import type {
  DocumentTypeDefinition,
  ProjectFileIssue,
  ProjectModuleDefinition,
  ProjectModuleOptions,
  ProjectProviderDefinition,
  VisualBridgeProjectDefinition,
} from "./projectFile";
import { parseProjectFile, serializeProjectFile } from "./projectFile";
import { compareUtf16CodeUnits } from "../Ordering/ordinal";
import { cloneJsonValue, isJsonValue } from "../Form/field";

export type ProjectOperation =
  | { readonly type: "project.setProjectId"; readonly projectId: string }
  | { readonly type: "project.setDocumentRoots"; readonly documentRoots: readonly string[] }
  | { readonly type: "project.addModule"; readonly module: ProjectModuleDefinition; readonly index?: number }
  | { readonly type: "project.upsertModule"; readonly module: ProjectModuleDefinition; readonly index?: number }
  | { readonly type: "project.removeModule"; readonly moduleId: string }
  | { readonly type: "project.moveModule"; readonly moduleId: string; readonly toIndex: number }
  | { readonly type: "project.setModuleOptions"; readonly moduleId: string; readonly options?: ProjectModuleOptions }
  | { readonly type: "project.upsertDocumentType"; readonly documentType: DocumentTypeDefinition; readonly index?: number }
  | { readonly type: "project.renameDocumentType"; readonly documentTypeId: string; readonly newId: string }
  | { readonly type: "project.removeDocumentType"; readonly documentTypeId: string }
  | { readonly type: "project.moveDocumentType"; readonly documentTypeId: string; readonly toIndex: number }
  | { readonly type: "project.addProvider"; readonly provider: ProjectProviderDefinition; readonly index?: number }
  | { readonly type: "project.upsertProvider"; readonly provider: ProjectProviderDefinition; readonly index?: number }
  | { readonly type: "project.renameProvider"; readonly providerId: string; readonly newId: string }
  | { readonly type: "project.removeProvider"; readonly providerId: string }
  | { readonly type: "project.moveProvider"; readonly providerId: string; readonly toIndex: number };

export type ProjectOperationResult =
  | {
    readonly success: true;
    readonly document: VisualBridgeProjectDefinition;
    readonly text: string;
  }
  | {
    readonly success: false;
    readonly issues: readonly ProjectFileIssue[];
  };

export function applyProjectOperations(
  document: VisualBridgeProjectDefinition,
  operationsValue: unknown,
): ProjectOperationResult {
  const parsed = parseProjectOperations(operationsValue);
  if (!parsed.success) {
    return parsed;
  }
  let projectId = document.projectId;
  let documentRoots = [...document.documentRoots];
  const modules = document.modules.map(cloneModule);
  const documentTypes = document.documentTypes.map(cloneDocumentType);
  const providers = document.providers.map(cloneProvider);

  for (const [operationIndex, operation] of parsed.operations.entries()) {
    switch (operation.type) {
      case "project.setProjectId":
        projectId = operation.projectId;
        break;
      case "project.setDocumentRoots":
        documentRoots = [...operation.documentRoots];
        break;
      case "project.addModule": {
        if (modules.some((entry) => entry.id === operation.module.id)) {
          return operationFailure(operationIndex, "module.id", `Module '${operation.module.id}' already exists.`);
        }
        const insertionIndex = operation.index ?? modules.length;
        if (!isInsertionIndex(insertionIndex, modules.length)) {
          return operationFailure(operationIndex, "index", "Module insertion index is out of range.");
        }
        modules.splice(insertionIndex, 0, cloneModule(operation.module));
        break;
      }
      case "project.upsertModule": {
        const existingIndex = modules.findIndex((entry) => entry.id === operation.module.id);
        if (existingIndex >= 0) {
          modules[existingIndex] = cloneModule(operation.module);
        } else {
          const insertionIndex = operation.index ?? modules.length;
          if (!isInsertionIndex(insertionIndex, modules.length)) {
            return operationFailure(operationIndex, "index", "Module insertion index is out of range.");
          }
          modules.splice(insertionIndex, 0, cloneModule(operation.module));
        }
        break;
      }
      case "project.removeModule": {
        const index = modules.findIndex((entry) => entry.id === operation.moduleId);
        if (index < 0) {
          return operationFailure(operationIndex, "moduleId", `Unknown module '${operation.moduleId}'.`);
        }
        modules.splice(index, 1);
        break;
      }
      case "project.moveModule": {
        const index = modules.findIndex((entry) => entry.id === operation.moduleId);
        if (index < 0) {
          return operationFailure(operationIndex, "moduleId", `Unknown module '${operation.moduleId}'.`);
        }
        if (!isMoveIndex(operation.toIndex, modules.length)) {
          return operationFailure(operationIndex, "toIndex", "Module destination index is out of range.");
        }
        const [entry] = modules.splice(index, 1);
        modules.splice(operation.toIndex, 0, entry!);
        break;
      }
      case "project.setModuleOptions": {
        const index = modules.findIndex((entry) => entry.id === operation.moduleId);
        if (index < 0) {
          return operationFailure(operationIndex, "moduleId", `Unknown module '${operation.moduleId}'.`);
        }
        const { options: _options, ...rest } = modules[index]!;
        modules[index] = operation.options === undefined
          ? rest
          : { ...rest, options: cloneJsonValue(operation.options) };
        break;
      }
      case "project.upsertDocumentType": {
        const existingIndex = documentTypes.findIndex((entry) => entry.id === operation.documentType.id);
        if (existingIndex >= 0) {
          documentTypes[existingIndex] = cloneDocumentType(operation.documentType);
        } else {
          const insertionIndex = operation.index ?? documentTypes.length;
          if (!isInsertionIndex(insertionIndex, documentTypes.length)) {
            return operationFailure(operationIndex, "index", "Document Type insertion index is out of range.");
          }
          documentTypes.splice(insertionIndex, 0, cloneDocumentType(operation.documentType));
        }
        break;
      }
      case "project.removeDocumentType": {
        const index = documentTypes.findIndex((entry) => entry.id === operation.documentTypeId);
        if (index < 0) {
          return operationFailure(operationIndex, "documentTypeId", `Unknown Document Type '${operation.documentTypeId}'.`);
        }
        documentTypes.splice(index, 1);
        break;
      }
      case "project.renameDocumentType": {
        const index = documentTypes.findIndex((entry) => entry.id === operation.documentTypeId);
        if (index < 0) {
          return operationFailure(operationIndex, "documentTypeId", `Unknown Document Type '${operation.documentTypeId}'.`);
        }
        documentTypes[index] = { ...documentTypes[index]!, id: operation.newId };
        for (let providerIndex = 0; providerIndex < providers.length; providerIndex += 1) {
          const provider = providers[providerIndex]!;
          if (provider.capabilities.validator === undefined) continue;
          providers[providerIndex] = {
            ...provider,
            capabilities: {
              ...provider.capabilities,
              validator: {
                documentTypes: provider.capabilities.validator.documentTypes.map((id) => (
                  id === operation.documentTypeId ? operation.newId : id
                )),
              },
            },
          };
        }
        break;
      }
      case "project.moveDocumentType": {
        const index = documentTypes.findIndex((entry) => entry.id === operation.documentTypeId);
        if (index < 0) {
          return operationFailure(operationIndex, "documentTypeId", `Unknown Document Type '${operation.documentTypeId}'.`);
        }
        if (!isMoveIndex(operation.toIndex, documentTypes.length)) {
          return operationFailure(operationIndex, "toIndex", "Document Type destination index is out of range.");
        }
        const [entry] = documentTypes.splice(index, 1);
        documentTypes.splice(operation.toIndex, 0, entry!);
        break;
      }
      case "project.addProvider": {
        if (providers.some((entry) => entry.id === operation.provider.id)) {
          return operationFailure(operationIndex, "provider.id", `Provider '${operation.provider.id}' already exists.`);
        }
        const insertionIndex = operation.index ?? providers.length;
        if (!isInsertionIndex(insertionIndex, providers.length)) {
          return operationFailure(operationIndex, "index", "Provider insertion index is out of range.");
        }
        providers.splice(insertionIndex, 0, cloneProvider(operation.provider));
        break;
      }
      case "project.upsertProvider": {
        const existingIndex = providers.findIndex((entry) => entry.id === operation.provider.id);
        if (existingIndex >= 0) {
          providers[existingIndex] = cloneProvider(operation.provider);
        } else {
          const insertionIndex = operation.index ?? providers.length;
          if (!isInsertionIndex(insertionIndex, providers.length)) {
            return operationFailure(operationIndex, "index", "Provider insertion index is out of range.");
          }
          providers.splice(insertionIndex, 0, cloneProvider(operation.provider));
        }
        break;
      }
      case "project.removeProvider": {
        const index = providers.findIndex((entry) => entry.id === operation.providerId);
        if (index < 0) {
          return operationFailure(operationIndex, "providerId", `Unknown Provider '${operation.providerId}'.`);
        }
        providers.splice(index, 1);
        break;
      }
      case "project.renameProvider": {
        const index = providers.findIndex((entry) => entry.id === operation.providerId);
        if (index < 0) {
          return operationFailure(operationIndex, "providerId", `Unknown Provider '${operation.providerId}'.`);
        }
        providers[index] = { ...providers[index]!, id: operation.newId };
        break;
      }
      case "project.moveProvider": {
        const index = providers.findIndex((entry) => entry.id === operation.providerId);
        if (index < 0) {
          return operationFailure(operationIndex, "providerId", `Unknown Provider '${operation.providerId}'.`);
        }
        if (!isMoveIndex(operation.toIndex, providers.length)) {
          return operationFailure(operationIndex, "toIndex", "Provider destination index is out of range.");
        }
        const [entry] = providers.splice(index, 1);
        providers.splice(operation.toIndex, 0, entry!);
        break;
      }
    }
  }

  const candidate: VisualBridgeProjectDefinition = {
    formatVersion: document.formatVersion,
    projectId,
    documentRoots,
    modules,
    documentTypes,
    providers,
  };
  const text = serializeProjectFile(candidate);
  const reparsed = parseProjectFile(text);
  return reparsed.success
    ? { success: true, document: reparsed.value, text }
    : reparsed;
}

function parseProjectOperations(value: unknown):
  | { readonly success: true; readonly operations: readonly ProjectOperation[] }
  | { readonly success: false; readonly issues: readonly ProjectFileIssue[] } {
  if (!Array.isArray(value) || value.length === 0) {
    return { success: false, issues: [{ path: "operations", message: "Expected a non-empty Project Operation array." }] };
  }
  const issues: ProjectFileIssue[] = [];
  const operations: ProjectOperation[] = [];
  value.forEach((entry, index) => {
    const path = `operations[${index}]`;
    if (!isRecord(entry) || typeof entry.type !== "string") {
      issues.push({ path, message: "Expected a Project Operation object with a type." });
      return;
    }
    const operation = readOperation(entry, path, issues);
    if (operation !== undefined) operations.push(operation);
  });
  return issues.length === 0 ? { success: true, operations } : { success: false, issues };
}

function readOperation(
  entry: Readonly<Record<string, unknown>>,
  path: string,
  issues: ProjectFileIssue[],
): ProjectOperation | undefined {
  switch (entry.type) {
    case "project.setProjectId":
      checkKeys(entry, ["type", "projectId"], path, issues);
      return typeof entry.projectId === "string"
        ? { type: entry.type, projectId: entry.projectId }
        : invalidField(path, "projectId", "Expected a string.", issues);
    case "project.setDocumentRoots":
      checkKeys(entry, ["type", "documentRoots"], path, issues);
      return isStringArray(entry.documentRoots)
        ? { type: entry.type, documentRoots: entry.documentRoots }
        : invalidField(path, "documentRoots", "Expected a string array.", issues);
    case "project.addModule":
    case "project.upsertModule": {
      checkKeys(entry, ["type", "module", "index"], path, issues);
      if (!isModule(entry.module, `${path}.module`, issues)) {
        return invalidField(path, "module", "Expected a Module object.", issues);
      }
      if (entry.index !== undefined && !isNonNegativeInteger(entry.index)) return invalidField(path, "index", "Expected a non-negative integer.", issues);
      return { type: entry.type, module: entry.module, ...(entry.index === undefined ? {} : { index: entry.index }) };
    }
    case "project.removeModule":
      checkKeys(entry, ["type", "moduleId"], path, issues);
      return typeof entry.moduleId === "string"
        ? { type: entry.type, moduleId: entry.moduleId }
        : invalidField(path, "moduleId", "Expected a string.", issues);
    case "project.moveModule":
      checkKeys(entry, ["type", "moduleId", "toIndex"], path, issues);
      return typeof entry.moduleId === "string" && isNonNegativeInteger(entry.toIndex)
        ? { type: entry.type, moduleId: entry.moduleId, toIndex: entry.toIndex }
        : invalidField(path, "moduleId/toIndex", "Expected a string ID and non-negative destination index.", issues);
    case "project.setModuleOptions": {
      checkKeys(entry, ["type", "moduleId", "options"], path, issues);
      if (typeof entry.moduleId !== "string") {
        return invalidField(path, "moduleId", "Expected a string.", issues);
      }
      if (entry.options !== undefined && !isModuleOptions(entry.options)) {
        return invalidField(path, "options", "Expected a JSON object.", issues);
      }
      return {
        type: entry.type,
        moduleId: entry.moduleId,
        ...(entry.options === undefined ? {} : { options: entry.options }),
      };
    }
    case "project.upsertDocumentType": {
      checkKeys(entry, ["type", "documentType", "index"], path, issues);
      if (!isDocumentType(entry.documentType, `${path}.documentType`, issues)) {
        return invalidField(path, "documentType", "Expected a Document Type object.", issues);
      }
      if (entry.index !== undefined && !isNonNegativeInteger(entry.index)) return invalidField(path, "index", "Expected a non-negative integer.", issues);
      return { type: entry.type, documentType: entry.documentType, ...(entry.index === undefined ? {} : { index: entry.index }) };
    }
    case "project.removeDocumentType":
      checkKeys(entry, ["type", "documentTypeId"], path, issues);
      return typeof entry.documentTypeId === "string"
        ? { type: entry.type, documentTypeId: entry.documentTypeId }
        : invalidField(path, "documentTypeId", "Expected a string.", issues);
    case "project.renameDocumentType":
      checkKeys(entry, ["type", "documentTypeId", "newId"], path, issues);
      return typeof entry.documentTypeId === "string" && typeof entry.newId === "string"
        ? { type: entry.type, documentTypeId: entry.documentTypeId, newId: entry.newId }
        : invalidField(path, "documentTypeId/newId", "Expected current and new string IDs.", issues);
    case "project.moveDocumentType":
      checkKeys(entry, ["type", "documentTypeId", "toIndex"], path, issues);
      return typeof entry.documentTypeId === "string" && isNonNegativeInteger(entry.toIndex)
        ? { type: entry.type, documentTypeId: entry.documentTypeId, toIndex: entry.toIndex }
        : invalidField(path, "documentTypeId/toIndex", "Expected a string ID and non-negative destination index.", issues);
    case "project.setTableLayout":
    case "project.clearTableLayout":
      issues.push({
        path: `${path}.type`,
        message: `'${entry.type}' was removed; declare the Table layout in the 'visualbridge.table' module's 'options.tableLayout'.`,
      });
      return undefined;
    case "project.addProvider":
    case "project.upsertProvider": {
      checkKeys(entry, ["type", "provider", "index"], path, issues);
      if (!isProvider(entry.provider, `${path}.provider`, issues)) {
        return invalidField(path, "provider", "Expected a Provider object.", issues);
      }
      if (entry.index !== undefined && !isNonNegativeInteger(entry.index)) return invalidField(path, "index", "Expected a non-negative integer.", issues);
      return { type: entry.type, provider: entry.provider, ...(entry.index === undefined ? {} : { index: entry.index }) };
    }
    case "project.removeProvider":
      checkKeys(entry, ["type", "providerId"], path, issues);
      return typeof entry.providerId === "string"
        ? { type: entry.type, providerId: entry.providerId }
        : invalidField(path, "providerId", "Expected a string.", issues);
    case "project.renameProvider":
      checkKeys(entry, ["type", "providerId", "newId"], path, issues);
      return typeof entry.providerId === "string" && typeof entry.newId === "string"
        ? { type: entry.type, providerId: entry.providerId, newId: entry.newId }
        : invalidField(path, "providerId/newId", "Expected current and new string IDs.", issues);
    case "project.moveProvider":
      checkKeys(entry, ["type", "providerId", "toIndex"], path, issues);
      return typeof entry.providerId === "string" && isNonNegativeInteger(entry.toIndex)
        ? { type: entry.type, providerId: entry.providerId, toIndex: entry.toIndex }
        : invalidField(path, "providerId/toIndex", "Expected a string ID and non-negative destination index.", issues);
    default:
      issues.push({ path: `${path}.type`, message: `Unknown Project Operation '${entry.type}'.` });
      return undefined;
  }
}

function cloneModule(value: ProjectModuleDefinition): ProjectModuleDefinition {
  return {
    id: value.id,
    entry: value.entry,
    ...(value.options === undefined ? {} : { options: cloneJsonValue(value.options) }),
    ...(value.hash === undefined ? {} : { hash: value.hash }),
  };
}

function cloneDocumentType(value: DocumentTypeDefinition): DocumentTypeDefinition {
  return {
    id: value.id,
    editor: value.editor,
    include: [...value.include],
    exclude: [...value.exclude],
    catalogs: [...value.catalogs],
  };
}

function cloneProvider(value: ProjectProviderDefinition): ProjectProviderDefinition {
  return {
    id: value.id,
    entry: value.entry,
    args: [...value.args],
    capabilities: {
      ...(value.capabilities.reference === undefined
        ? {}
        : { reference: { kinds: [...value.capabilities.reference.kinds] } }),
      ...(value.capabilities.validator === undefined
        ? {}
        : { validator: { documentTypes: [...value.capabilities.validator.documentTypes] } }),
    },
  };
}

function isModule(
  value: unknown,
  path: string,
  issues: ProjectFileIssue[],
): value is ProjectModuleDefinition {
  if (!isRecord(value)) return false;
  checkKeys(value, ["id", "entry", "options", "hash"], path, issues);
  return typeof value.id === "string"
    && typeof value.entry === "string"
    && (value.options === undefined || isModuleOptions(value.options))
    && (value.hash === undefined || typeof value.hash === "string");
}

function isModuleOptions(value: unknown): value is ProjectModuleOptions {
  return isRecord(value) && isJsonValue(value);
}

function isDocumentType(
  value: unknown,
  path: string,
  issues: ProjectFileIssue[],
): value is DocumentTypeDefinition {
  if (!isRecord(value)) return false;
  checkKeys(value, ["id", "editor", "include", "exclude", "catalogs"], path, issues);
  return typeof value.id === "string"
    && typeof value.editor === "string"
    && isStringArray(value.include)
    && isStringArray(value.exclude)
    && isStringArray(value.catalogs);
}

function isProvider(
  value: unknown,
  path: string,
  issues: ProjectFileIssue[],
): value is ProjectProviderDefinition {
  if (!isRecord(value)) return false;
  checkKeys(value, ["id", "entry", "args", "capabilities"], path, issues);
  if (isRecord(value.capabilities)) {
    checkKeys(value.capabilities, ["reference", "validator"], `${path}.capabilities`, issues);
    if (isRecord(value.capabilities.reference)) {
      checkKeys(value.capabilities.reference, ["kinds"], `${path}.capabilities.reference`, issues);
    }
    if (isRecord(value.capabilities.validator)) {
      checkKeys(value.capabilities.validator, ["documentTypes"], `${path}.capabilities.validator`, issues);
    }
  }
  return typeof value.id === "string"
    && typeof value.entry === "string"
    && isStringArray(value.args)
    && isRecord(value.capabilities);
}

function invalidField(
  path: string,
  field: string,
  message: string,
  issues: ProjectFileIssue[],
): undefined {
  issues.push({ path: `${path}.${field}`, message });
  return undefined;
}

function checkKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  path: string,
  issues: ProjectFileIssue[],
): void {
  const allowedKeys = new Set(allowed);
  Object.keys(value).filter((key) => !allowedKeys.has(key)).sort(compareUtf16CodeUnits).forEach((key) => {
    issues.push({ path: `${path}.${key}`, message: `Unknown property '${key}'.` });
  });
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isInsertionIndex(value: number, length: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= length;
}

function isMoveIndex(value: number, length: number): boolean {
  return Number.isInteger(value) && value >= 0 && value < length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function operationFailure(operationIndex: number, field: string, message: string): ProjectOperationResult {
  return { success: false, issues: [{ path: `operations[${operationIndex}].${field}`, message }] };
}
