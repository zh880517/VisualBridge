import { readFile } from "node:fs/promises";
import type { DocumentTypeDefinition } from "@visualbridge/core";
import {
  buildEntityCatalogRegistry,
  parseEntityCatalog,
  type EntityCatalog,
  type EntityCatalogRegistry,
} from "@visualbridge/entity";
import {
  VisualBridgeMcpError,
  resolveExistingProjectPath,
  type ProjectContext,
} from "./projectWorkspace.js";

export async function loadMcpEntityRegistry(
  project: ProjectContext,
  documentType: Pick<DocumentTypeDefinition, "id" | "catalogs">,
): Promise<EntityCatalogRegistry> {
  if (documentType.catalogs.length === 0) {
    throw new VisualBridgeMcpError(
      "refactor.catalogUnavailable",
      `Entity Document Type '${documentType.id}' has no Catalogs.`,
    );
  }
  const catalogs: EntityCatalog[] = [];
  for (const catalogPath of documentType.catalogs) {
    const parsed = parseEntityCatalog(decodeUtf8(
      await readFile(await resolveExistingProjectPath(project, catalogPath)),
      catalogPath,
    ));
    if (!parsed.success) {
      throw new VisualBridgeMcpError(
        "refactor.invalidSource",
        `Source '${catalogPath}' is invalid and cannot participate in project semantics.`,
        parsed.diagnostics,
      );
    }
    catalogs.push(parsed.document);
  }
  const built = buildEntityCatalogRegistry(catalogs);
  if (!built.success) {
    throw new VisualBridgeMcpError(
      "refactor.invalidSource",
      `Source '${documentType.id} Entity Catalog Registry' is invalid and cannot participate in project semantics.`,
      built.diagnostics,
    );
  }
  return built.document;
}

function decodeUtf8(bytes: Uint8Array, sourcePath: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (errorValue) {
    const message = errorValue instanceof Error ? errorValue.message : String(errorValue);
    throw new VisualBridgeMcpError("file.invalidUtf8", `File '${sourcePath}' is not valid UTF-8: ${message}`);
  }
}
