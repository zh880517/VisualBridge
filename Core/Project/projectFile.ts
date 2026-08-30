import { BUILT_IN_REFERENCE_KINDS } from "../Reference/reference";

export const PROJECT_FILE_NAME = "VisualBridge.project.vbjson";
export const PROJECT_FILE_GLOB = `**/${PROJECT_FILE_NAME}`;
export const PROJECT_FORMAT_VERSION = 1;

export interface DocumentTypeDefinition {
  readonly id: string;
  readonly editor: string;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly catalogs: readonly string[];
}

export interface TableLayoutDefinition {
  readonly nameKeyRow: number;
  readonly dataStartRow: number;
}

export interface ProjectProviderReferenceCapability {
  readonly kinds: readonly string[];
}

export interface ProjectProviderValidatorCapability {
  readonly documentTypes: readonly string[];
}

export interface ProjectProviderCapabilities {
  readonly reference?: ProjectProviderReferenceCapability;
  readonly validator?: ProjectProviderValidatorCapability;
}

export interface ProjectProviderDefinition {
  readonly id: string;
  readonly entry: string;
  readonly args: readonly string[];
  readonly capabilities: ProjectProviderCapabilities;
}

export interface VisualBridgeProjectDefinition {
  readonly formatVersion: typeof PROJECT_FORMAT_VERSION;
  readonly projectId: string;
  readonly documentRoots: readonly string[];
  readonly documentTypes: readonly DocumentTypeDefinition[];
  readonly tableLayout?: TableLayoutDefinition;
  readonly providers: readonly ProjectProviderDefinition[];
}

export interface ProjectFileIssue {
  readonly path: string;
  readonly message: string;
}

export type ProjectFileParseResult =
  | { readonly success: true; readonly value: VisualBridgeProjectDefinition }
  | { readonly success: false; readonly issues: readonly ProjectFileIssue[] };

export function parseProjectFile(text: string): ProjectFileParseResult {
  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown JSON parse error.";
    return failure("$", `Invalid JSON: ${message}`);
  }

  if (!isRecord(value)) {
    return failure("$", "Project file must contain a JSON object.");
  }

  const issues: ProjectFileIssue[] = [];
  if (value.formatVersion !== PROJECT_FORMAT_VERSION) {
    issues.push({
      path: "formatVersion",
      message: `Expected formatVersion ${PROJECT_FORMAT_VERSION}.`,
    });
  }

  const projectId = readIdentifier(value.projectId, "projectId", issues);
  const documentRoots = readRelativePaths(value.documentRoots, "documentRoots", issues);
  const documentTypes = readDocumentTypes(value.documentTypes, issues);
  const tableLayout = value.tableLayout === undefined
    ? undefined
    : readTableLayout(value.tableLayout, issues);
  if (value.provider !== undefined) {
    issues.push({
      path: "provider",
      message: "Single 'provider' is not supported; declare the 'providers' array.",
    });
  }
  const providers = value.providers === undefined
    ? []
    : readProviders(value.providers, documentTypes, issues);

  if (issues.length > 0 || projectId === undefined) {
    return { success: false, issues };
  }

  return {
    success: true,
    value: {
      formatVersion: PROJECT_FORMAT_VERSION,
      projectId,
      documentRoots,
      documentTypes,
      ...(tableLayout === undefined ? {} : { tableLayout }),
      providers,
    },
  };
}

function readProviders(
  value: unknown,
  documentTypes: readonly DocumentTypeDefinition[],
  issues: ProjectFileIssue[],
): readonly ProjectProviderDefinition[] {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push({ path: "providers", message: "Expected a non-empty array." });
    return [];
  }

  const result: ProjectProviderDefinition[] = [];
  const seenIds = new Set<string>();
  const seenReferenceKinds = new Set<string>(BUILT_IN_REFERENCE_KINDS);
  const documentTypeIds = new Set(documentTypes.map((documentType) => documentType.id));
  value.forEach((entry, index) => {
    const basePath = `providers[${index}]`;
    if (!isRecord(entry)) {
      issues.push({ path: basePath, message: "Expected an object." });
      return;
    }
    rejectUnknownKeys(entry, ["id", "entry", "args", "capabilities"], basePath, issues);

    const id = readIdentifier(entry.id, `${basePath}.id`, issues);
    const providerEntry = readProviderEntry(entry.entry, `${basePath}.entry`, issues);
    const args = readStringArray(entry.args, `${basePath}.args`, issues, true);
    const capabilities = readProviderCapabilities(entry.capabilities, `${basePath}.capabilities`, issues);

    if (capabilities?.reference !== undefined) {
      capabilities.reference.kinds.forEach((kind, kindIndex) => {
        if (seenReferenceKinds.has(kind)) {
          issues.push({
            path: `${basePath}.capabilities.reference.kinds[${kindIndex}]`,
            message: BUILT_IN_REFERENCE_KINDS.includes(kind as (typeof BUILT_IN_REFERENCE_KINDS)[number])
              ? `Reference kind '${kind}' conflicts with a built-in provider.`
              : `Reference kind '${kind}' is already declared by another provider.`,
          });
        } else {
          seenReferenceKinds.add(kind);
        }
      });
    }
    if (capabilities?.validator !== undefined) {
      capabilities.validator.documentTypes.forEach((documentTypeId, documentTypeIndex) => {
        if (!documentTypeIds.has(documentTypeId)) {
          issues.push({
            path: `${basePath}.capabilities.validator.documentTypes[${documentTypeIndex}]`,
            message: `Unknown document type '${documentTypeId}'.`,
          });
        }
      });
    }

    if (id !== undefined && seenIds.has(id)) {
      issues.push({ path: `${basePath}.id`, message: `Duplicate provider id '${id}'.` });
    }
    if (id !== undefined) {
      seenIds.add(id);
    }
    if (id !== undefined && providerEntry !== undefined && args !== undefined && capabilities !== undefined) {
      result.push({ id, entry: providerEntry, args, capabilities });
    }
  });
  return result;
}

function readProviderEntry(
  value: unknown,
  path: string,
  issues: ProjectFileIssue[],
): string | undefined {
  if (typeof value !== "string" || value === "." || !isSafeRelativePath(value) || !value.endsWith(".mjs")) {
    issues.push({
      path,
      message: "Expected a normalized project-relative '.mjs' entry using '/' separators.",
    });
    return undefined;
  }
  return value;
}

function readProviderCapabilities(
  value: unknown,
  path: string,
  issues: ProjectFileIssue[],
): ProjectProviderCapabilities | undefined {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected an object." });
    return undefined;
  }
  rejectUnknownKeys(value, ["reference", "validator"], path, issues);

  let reference: ProjectProviderReferenceCapability | undefined;
  if (value.reference !== undefined) {
    const capabilityPath = `${path}.reference`;
    if (!isRecord(value.reference)) {
      issues.push({ path: capabilityPath, message: "Expected an object." });
    } else {
      rejectUnknownKeys(value.reference, ["kinds"], capabilityPath, issues);
      const kinds = readIdentifierArray(value.reference.kinds, `${capabilityPath}.kinds`, issues);
      if (kinds !== undefined) {
        reference = { kinds };
      }
    }
  }

  let validator: ProjectProviderValidatorCapability | undefined;
  if (value.validator !== undefined) {
    const capabilityPath = `${path}.validator`;
    if (!isRecord(value.validator)) {
      issues.push({ path: capabilityPath, message: "Expected an object." });
    } else {
      rejectUnknownKeys(value.validator, ["documentTypes"], capabilityPath, issues);
      const documentTypes = readIdentifierArray(
        value.validator.documentTypes,
        `${capabilityPath}.documentTypes`,
        issues,
      );
      if (documentTypes !== undefined) {
        validator = { documentTypes };
      }
    }
  }

  if (reference === undefined && validator === undefined) {
    issues.push({ path, message: "Expected at least one 'reference' or 'validator' capability." });
    return undefined;
  }
  return {
    ...(reference === undefined ? {} : { reference }),
    ...(validator === undefined ? {} : { validator }),
  };
}

function readIdentifierArray(
  value: unknown,
  path: string,
  issues: ProjectFileIssue[],
): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push({ path, message: "Expected a non-empty array of identifiers." });
    return undefined;
  }
  const result: string[] = [];
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    const identifier = readIdentifier(entry, `${path}[${index}]`, issues);
    if (identifier === undefined) {
      return;
    }
    if (seen.has(identifier)) {
      issues.push({ path: `${path}[${index}]`, message: `Duplicate identifier '${identifier}'.` });
      return;
    }
    seen.add(identifier);
    result.push(identifier);
  });
  return result;
}

function readStringArray(
  value: unknown,
  path: string,
  issues: ProjectFileIssue[],
  allowEmpty: boolean,
): readonly string[] | undefined {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    issues.push({ path, message: allowEmpty ? "Expected an array." : "Expected a non-empty array." });
    return undefined;
  }
  const result: string[] = [];
  value.forEach((entry, index) => {
    if (typeof entry !== "string") {
      issues.push({ path: `${path}[${index}]`, message: "Expected a string." });
      return;
    }
    result.push(entry);
  });
  return result;
}

function rejectUnknownKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  path: string,
  issues: ProjectFileIssue[],
): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value).sort()) {
    if (!allowedKeys.has(key)) {
      issues.push({ path: `${path}.${key}`, message: `Unknown property '${key}'.` });
    }
  }
}

function readTableLayout(
  value: unknown,
  issues: ProjectFileIssue[],
): TableLayoutDefinition | undefined {
  if (!isRecord(value)) {
    issues.push({ path: "tableLayout", message: "Expected an object." });
    return undefined;
  }
  const nameKeyRow = readPositiveInteger(value.nameKeyRow, "tableLayout.nameKeyRow", issues);
  const dataStartRow = readPositiveInteger(value.dataStartRow, "tableLayout.dataStartRow", issues);
  if (nameKeyRow !== undefined && dataStartRow !== undefined && dataStartRow <= nameKeyRow) {
    issues.push({
      path: "tableLayout.dataStartRow",
      message: "Data start row must be after the name-key row.",
    });
  }
  return nameKeyRow === undefined || dataStartRow === undefined || dataStartRow <= nameKeyRow
    ? undefined
    : { nameKeyRow, dataStartRow };
}

function readPositiveInteger(
  value: unknown,
  path: string,
  issues: ProjectFileIssue[],
): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    issues.push({ path, message: "Expected a positive 1-based row number." });
    return undefined;
  }
  return value;
}

function readDocumentTypes(
  value: unknown,
  issues: ProjectFileIssue[],
): readonly DocumentTypeDefinition[] {
  if (!Array.isArray(value)) {
    issues.push({ path: "documentTypes", message: "Expected an array." });
    return [];
  }

  const seenIds = new Set<string>();
  const documentTypes: DocumentTypeDefinition[] = [];

  value.forEach((entry, index) => {
    const basePath = `documentTypes[${index}]`;
    if (!isRecord(entry)) {
      issues.push({ path: basePath, message: "Expected an object." });
      return;
    }

    const id = readIdentifier(entry.id, `${basePath}.id`, issues);
    const editor = readIdentifier(entry.editor, `${basePath}.editor`, issues);
    const include = readGlobPatterns(entry.include, `${basePath}.include`, issues);
    const exclude = entry.exclude === undefined
      ? []
      : readGlobPatterns(entry.exclude, `${basePath}.exclude`, issues, true);
    if (entry.catalog !== undefined) {
      issues.push({
        path: `${basePath}.catalog`,
        message: "Single 'catalog' is not supported; declare the 'catalogs' array.",
      });
    }
    const catalogs = entry.catalogs !== undefined
      ? readRelativePaths(entry.catalogs, `${basePath}.catalogs`, issues)
      : [];

    if (id !== undefined && seenIds.has(id)) {
      issues.push({ path: `${basePath}.id`, message: `Duplicate document type id '${id}'.` });
    }

    if (id !== undefined && editor !== undefined) {
      seenIds.add(id);
      documentTypes.push({ id, editor, include, exclude, catalogs });
    }
  });

  return documentTypes;
}

function readIdentifier(
  value: unknown,
  path: string,
  issues: ProjectFileIssue[],
): string | undefined {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    issues.push({
      path,
      message: "Expected a non-empty identifier using letters, digits, '.', '_' or '-'.",
    });
    return undefined;
  }

  return value;
}

function readRelativePaths(
  value: unknown,
  path: string,
  issues: ProjectFileIssue[],
): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push({ path, message: "Expected a non-empty array of relative paths." });
    return [];
  }

  const result: string[] = [];
  const seenPaths = new Set<string>();
  value.forEach((entry, index) => {
    if (typeof entry !== "string" || !isSafeRelativePath(entry)) {
      issues.push({
        path: `${path}[${index}]`,
        message: "Expected a normalized relative path that stays inside the project root.",
      });
      return;
    }

    const normalizedPath = normalizeRelativePath(entry);
    if (seenPaths.has(normalizedPath)) {
      issues.push({ path: `${path}[${index}]`, message: `Duplicate path '${normalizedPath}'.` });
      return;
    }

    seenPaths.add(normalizedPath);
    result.push(normalizedPath);
  });

  return result;
}

function readRelativePath(
  value: unknown,
  path: string,
  issues: ProjectFileIssue[],
): string | undefined {
  if (typeof value !== "string" || !isSafeRelativePath(value)) {
    issues.push({
      path,
      message: "Expected a normalized relative path that stays inside the project root.",
    });
    return undefined;
  }
  return normalizeRelativePath(value);
}

function readGlobPatterns(
  value: unknown,
  path: string,
  issues: ProjectFileIssue[],
  allowEmpty = false,
): readonly string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    issues.push({ path, message: allowEmpty ? "Expected an array." : "Expected a non-empty array." });
    return [];
  }

  const result: string[] = [];
  value.forEach((entry, index) => {
    if (typeof entry !== "string" || entry.trim().length === 0 || entry.includes("\\")) {
      issues.push({
        path: `${path}[${index}]`,
        message: "Expected a non-empty glob pattern using '/' separators.",
      });
      return;
    }

    result.push(entry);
  });

  return result;
}

function isSafeRelativePath(value: string): boolean {
  if (value === ".") {
    return true;
  }

  if (value.length === 0 || value.startsWith("/") || value.includes("\\")) {
    return false;
  }

  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\/$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure(path: string, message: string): ProjectFileParseResult {
  return { success: false, issues: [{ path, message }] };
}
