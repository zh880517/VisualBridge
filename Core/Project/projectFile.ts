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

export interface VisualBridgeProjectDefinition {
  readonly formatVersion: typeof PROJECT_FORMAT_VERSION;
  readonly projectId: string;
  readonly documentRoots: readonly string[];
  readonly documentTypes: readonly DocumentTypeDefinition[];
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
    },
  };
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
    const hasCatalog = entry.catalog !== undefined;
    const hasCatalogs = entry.catalogs !== undefined;
    if (hasCatalog && hasCatalogs) {
      issues.push({
        path: `${basePath}.catalogs`,
        message: "'catalog' and 'catalogs' cannot be declared together.",
      });
    }
    const catalogs = hasCatalogs
      ? readRelativePaths(entry.catalogs, `${basePath}.catalogs`, issues)
      : hasCatalog
        ? toArray(readRelativePath(entry.catalog, `${basePath}.catalog`, issues))
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

function toArray(value: string | undefined): readonly string[] {
  return value === undefined ? [] : [value];
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
