import { BUILT_IN_REFERENCE_KINDS } from "../Reference/reference";
import { compareUtf16CodeUnits } from "../Ordering/ordinal";
import { cloneJsonValue, isJsonValue, type JsonValue } from "../Form/field";

export const PROJECT_FILE_NAME = "VisualBridge.project.vbjson";
export const PROJECT_FILE_GLOB = `**/${PROJECT_FILE_NAME}`;
export const PROJECT_FORMAT_VERSION = 2;
/** 模块条目 entry 的固定后缀；entry 本身是 Project 内规范化的相对路径。 */
export const PROJECT_MODULE_ENTRY_SUFFIX = ".vbmodule.js";
/** 模块条目可选 hash 的形状；只校验格式，不校验值（值与 bundle 字节的比对属于模块加载）。 */
export const PROJECT_MODULE_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;
/** formatVersion 不受支持时的诊断码；v1 不自动升级。 */
export const PROJECT_FORMAT_VERSION_UNSUPPORTED = "project.formatVersionUnsupported";

/** 模块自有 options 的共享形状；Core 只保证它是 JSON 对象，内容由模块 validateOptions 校验。 */
export type ProjectModuleOptions = Readonly<Record<string, JsonValue>>;

export interface ProjectModuleDefinition {
  readonly id: string;
  readonly entry: string;
  readonly options?: ProjectModuleOptions;
  readonly hash?: string;
}

export interface DocumentTypeDefinition {
  readonly id: string;
  readonly editor: string;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly catalogs: readonly string[];
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
  /**
   * 模块声明只做结构校验；documentTypes[].editor 与已加载模块提供者的一致性校验延后到模块装载，
   * 本层不加载模块。
   */
  readonly modules: readonly ProjectModuleDefinition[];
  readonly documentTypes: readonly DocumentTypeDefinition[];
  readonly providers: readonly ProjectProviderDefinition[];
}

export interface ProjectFileIssue {
  /** 可选诊断码；只有需要跨宿主对齐的稳定失败（如 formatVersion 不受支持）才带码。 */
  readonly code?: string;
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
  // 先报版本，再报结构：v1 文件的主要失败原因是版本，迁移要点必须排在未知键之前。
  if (value.formatVersion !== PROJECT_FORMAT_VERSION) {
    issues.push({
      code: PROJECT_FORMAT_VERSION_UNSUPPORTED,
      path: "formatVersion",
      message: value.formatVersion === 1
        ? "Project File formatVersion 1 is not supported. Migrate to formatVersion 2 by adding the required 'modules' array and moving the top-level 'tableLayout' into the 'visualbridge.table' module's 'options.tableLayout'."
        : `Expected formatVersion ${PROJECT_FORMAT_VERSION}.`,
    });
  }

  rejectUnknownKeys(
    value,
    ["formatVersion", "projectId", "documentRoots", "modules", "documentTypes", "providers"],
    "$",
    issues,
  );

  const projectId = readIdentifier(value.projectId, "projectId", issues);
  const documentRoots = readRelativePaths(value.documentRoots, "documentRoots", issues);
  const modules = readModules(value.modules, issues);
  const documentTypes = readDocumentTypes(value.documentTypes, issues);
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
      modules,
      documentTypes,
      providers,
    },
  };
}

export function serializeProjectFile(project: VisualBridgeProjectDefinition): string {
  return `${JSON.stringify({
    formatVersion: PROJECT_FORMAT_VERSION,
    projectId: project.projectId,
    documentRoots: [...project.documentRoots],
    modules: project.modules.map((module) => ({
      id: module.id,
      entry: module.entry,
      ...(module.options === undefined ? {} : { options: cloneJsonValue(module.options) }),
      ...(module.hash === undefined ? {} : { hash: module.hash }),
    })),
    documentTypes: project.documentTypes.map((documentType) => ({
      id: documentType.id,
      editor: documentType.editor,
      include: [...documentType.include],
      exclude: [...documentType.exclude],
      catalogs: [...documentType.catalogs],
    })),
    ...(project.providers.length === 0 ? {} : {
      providers: project.providers.map((provider) => ({
        id: provider.id,
        entry: provider.entry,
        args: [...provider.args],
        capabilities: {
          ...(provider.capabilities.reference === undefined ? {} : {
            reference: { kinds: [...provider.capabilities.reference.kinds] },
          }),
          ...(provider.capabilities.validator === undefined ? {} : {
            validator: { documentTypes: [...provider.capabilities.validator.documentTypes] },
          }),
        },
      })),
    }),
  }, undefined, 2)}\n`;
}

function readModules(
  value: unknown,
  issues: ProjectFileIssue[],
): readonly ProjectModuleDefinition[] {
  if (!Array.isArray(value)) {
    issues.push({ path: "modules", message: "Expected an array." });
    return [];
  }

  const result: ProjectModuleDefinition[] = [];
  const seenIds = new Set<string>();
  value.forEach((entry, index) => {
    const basePath = `modules[${index}]`;
    if (!isRecord(entry)) {
      issues.push({ path: basePath, message: "Expected an object." });
      return;
    }

    rejectUnknownKeys(entry, ["id", "entry", "options", "hash"], basePath, issues);

    const id = readIdentifier(entry.id, `${basePath}.id`, issues);
    const moduleEntry = readModuleEntry(entry.entry, `${basePath}.entry`, issues);
    const options = entry.options === undefined
      ? undefined
      : readModuleOptions(entry.options, `${basePath}.options`, issues);
    const hash = entry.hash === undefined
      ? undefined
      : readModuleHash(entry.hash, `${basePath}.hash`, issues);

    if (id !== undefined && seenIds.has(id)) {
      issues.push({ path: `${basePath}.id`, message: `Duplicate module id '${id}'.` });
    }
    if (id !== undefined) {
      seenIds.add(id);
    }

    const optionsValid = entry.options === undefined || options !== undefined;
    const hashValid = entry.hash === undefined || hash !== undefined;
    if (id !== undefined && moduleEntry !== undefined && optionsValid && hashValid) {
      result.push({
        id,
        entry: moduleEntry,
        ...(options === undefined ? {} : { options }),
        ...(hash === undefined ? {} : { hash }),
      });
    }
  });
  return result;
}

function readModuleEntry(
  value: unknown,
  path: string,
  issues: ProjectFileIssue[],
): string | undefined {
  if (typeof value !== "string" || !isSafeModuleEntry(value)) {
    issues.push({
      path,
      message: `Expected a normalized project-relative '${PROJECT_MODULE_ENTRY_SUFFIX}' entry using '/' separators.`,
    });
    return undefined;
  }
  return value;
}

/**
 * 模块 entry 的安全判定。除相对路径段规则外还必须拒绝盘符前缀与控制字符：
 * Schema `$defs/module.entry` 与 Unity `ValidateRelativePath` 都拒绝这两类输入，
 * 否则 Core/VS Code 会接受 Unity 编译期拒收的 Project File。
 */
function isSafeModuleEntry(value: string): boolean {
  return value !== "."
    && isSafeRelativePath(value)
    && !/^[A-Za-z]:\//u.test(value)
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
    && value.endsWith(PROJECT_MODULE_ENTRY_SUFFIX);
}

function readModuleOptions(
  value: unknown,
  path: string,
  issues: ProjectFileIssue[],
): ProjectModuleOptions | undefined {
  if (!isRecord(value) || !isJsonValue(value)) {
    issues.push({ path, message: "Expected a JSON object." });
    return undefined;
  }
  return value as ProjectModuleOptions;
}

function readModuleHash(
  value: unknown,
  path: string,
  issues: ProjectFileIssue[],
): string | undefined {
  if (typeof value !== "string" || !PROJECT_MODULE_HASH_PATTERN.test(value)) {
    issues.push({ path, message: "Expected a module hash of the form 'sha256:<lowercase hex>'." });
    return undefined;
  }
  return value;
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
  for (const key of Object.keys(value).sort(compareUtf16CodeUnits)) {
    if (!allowedKeys.has(key)) {
      issues.push({ path: `${path}.${key}`, message: `Unknown property '${key}'.` });
    }
  }
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

    rejectUnknownKeys(entry, ["id", "editor", "include", "exclude", "catalogs"], basePath, issues);

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
      ? readRelativePaths(entry.catalogs, `${basePath}.catalogs`, issues, true)
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
  allowEmpty = false,
): readonly string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    issues.push({ path, message: allowEmpty ? "Expected an array of relative paths." : "Expected a non-empty array of relative paths." });
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
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    if (typeof entry !== "string" || !isSafeGlobPattern(entry)) {
      issues.push({
        path: `${path}[${index}]`,
        message: "Expected a normalized project-relative glob using '/' separators without negation, empty, '.' or '..' segments.",
      });
      return;
    }

    if (seen.has(entry)) {
      issues.push({ path: `${path}[${index}]`, message: `Duplicate glob pattern '${entry}'.` });
      return;
    }
    seen.add(entry);
    result.push(entry);
  });

  return result;
}

function isSafeGlobPattern(value: string): boolean {
  if (
    value.length === 0
    || value.trim() !== value
    || value.startsWith("/")
    || value.startsWith("!")
    || /^[A-Za-z]:\//u.test(value)
    || value.includes("\\")
    || value.includes("\0")
    || /[?\[\]{}()!]/u.test(value)
  ) {
    return false;
  }
  return value.split("/").every((segment) => (
    segment.length > 0
    && segment !== "."
    && segment !== ".."
    && (segment === "**" || !segment.includes("**"))
    && (segment === "**" || (segment.match(/\*/gu)?.length ?? 0) <= 1)
  ));
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
