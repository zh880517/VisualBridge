/**
 * Entity 模块的宿主语义面（附录 D.3 的 `storage` / `semantic` / `referenceData` / `references`）。
 *
 * Component 引用需要 Entity Catalog Registry；Registry 无效时不登记引用数据（与改造前一致）。
 */
import type {
  DocumentDiagnostic,
  DocumentFacet,
  DocumentFacetContext,
  DocumentFacetSourceFile,
  DocumentOperationResult,
} from "@visualbridge/core";
import { createEmptyEntityCatalogRegistry, ENTITY_EDITOR_ID, type EntityCatalogRegistry } from "./entityCatalog";
import { parseEntityDocument, serializeEntityDocument, type EntityDocument } from "./entityDocument";
import { entityDocumentAdapter } from "./entityDocumentAdapter";
import { collectEntityOwnedIdentities } from "./entityLifecycle";
import { findDanglingComponentReferenceDiagnostics } from "./entityReferences";
import {
  createEntityComponentReferenceProvider,
  ENTITY_COMPONENT_REFERENCE_KIND,
  type EntityReferenceDocument,
} from "./entityReferences";

type EntityTarget = Exclude<import("@visualbridge/core").DocumentLifecycleDeleteTarget, { readonly kind: "document" }>;

export const entityDocumentFacet: DocumentFacet<EntityDocument, EntityCatalogRegistry> = {
  editor: ENTITY_EDITOR_ID,
  storage: "text",
  references: [{
    kind: ENTITY_COMPONENT_REFERENCE_KIND,
    createProvider: (loadReferenceData) => createEntityComponentReferenceProvider(
      // facet 边界：引用数据由本模块写入，这里收窄回 EntityReferenceDocument。
      async () => await loadReferenceData() as readonly EntityReferenceDocument[],
    ),
  }],

  parseText(text, context) {
    const parsed = parseEntityDocument(text);
    if (!parsed.success || context.registry === undefined) return parsed;
    return {
      ...parsed,
      referenceData: {
        projectId: context.projectId,
        documentTypeId: context.documentTypeId,
        path: context.path,
        document: parsed.document,
        registry: context.registry,
      },
    };
  },

  async renderSources(document, sources) {
    const source = onlySource(sources, "Entity");
    return [{ path: source.path, bytes: new TextEncoder().encode(serializeEntityDocument(document)) }];
  },

  describe(document) {
    return { documentId: document.documentId, title: document.title };
  },

  validate(document, context) {
    return context.registry === undefined ? [] : entityDocumentAdapter.validate(document, { registry: context.registry });
  },

  collectReferences(document, context) {
    return context.registry === undefined
      ? []
      : entityDocumentAdapter.collectReferences(document, { registry: context.registry });
  },

  applyOperations(document, operations, context) {
    return entityDocumentAdapter.applyOperations(document, operations, requireRegistry(context, "Entity"));
  },

  replaceReferenceValues(document, context, occurrencePaths, replacement) {
    return entityDocumentAdapter.replaceReferenceValues(document, requireRegistry(context, "Entity"), occurrencePaths, replacement);
  },

  renameDocumentId(document, documentId, context) {
    return entityDocumentAdapter.renameDocumentId!(document, documentId, requireRegistry(context, "Entity"));
  },

  renameTarget(document, target, previous, replacement, context) {
    if (target.kind !== "entity.component") return targetKindFailure("Entity", target.kind);
    const componentId = requiredString(target.componentId, "target.componentId");
    if (componentId !== previous) {
      return failure("entity.targetChanged", "target.componentId", "The Entity component target changed after the preview was created.");
    }
    return entityDocumentAdapter.applyOperations(document, [{
      type: "entity.renameComponent",
      componentId,
      newComponentId: requiredString(replacement, "replacement"),
    }], requireRegistry(context, "Entity"));
  },

  guardOperations(_document, operations) {
    if (!Array.isArray(operations)) return [];
    // entity.removeComponent 不受守卫：组件没有跨文件引用语义，删除是普通单文件 Operation；
    // 仅稳定 Component ID 改名仍必须走 Reference Refactor。
    return operations.flatMap((entry, index) => {
      const type = typeof entry === "object" && entry !== null
        ? (entry as { readonly type?: unknown }).type
        : undefined;
      if (type !== "entity.renameComponent") return [];
      return [{
        severity: "error" as const,
        code: "lifecycle.required",
        path: `operations[${index}].type`,
        message: "Stable Component IDs must be changed through visualbridge_refactor_reference.",
      }];
    });
  },

  validateTransition(before, after, context) {
    return context.registry === undefined
      ? []
      : findDanglingComponentReferenceDiagnostics(before, after, context.registry);
  },

  collectOwnedIdentities(document, context) {
    return collectEntityOwnedIdentities(document, context.documentTypeId);
  },

  remapOwnedIdentities(document, context, remap) {
    return entityDocumentAdapter.lifecycle!.remapOwnedIdentities(document, context.documentTypeId, remap, {
      registry: context.registry ?? createEmptyEntityCatalogRegistry(),
    });
  },

  deleteOwnedTarget(document, target: EntityTarget, context) {
    return entityDocumentAdapter.lifecycle!.deleteOwnedTarget(document, target, requireRegistry(context, "Entity"));
  },
};

function requireRegistry(
  context: DocumentFacetContext<EntityCatalogRegistry>,
  scope: string,
): { readonly registry: EntityCatalogRegistry } {
  if (context.registry === undefined) {
    throw new Error(`${scope} Catalog Registry is unavailable.`);
  }
  return { registry: context.registry };
}

function onlySource(sources: readonly DocumentFacetSourceFile[], scope: string): DocumentFacetSourceFile {
  const source = sources[0];
  if (source === undefined) throw new Error(`${scope} document has no source file.`);
  return source;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${path} must be a non-empty string.`);
  return value;
}

function targetKindFailure(scope: string, kind: string): DocumentOperationResult<never> {
  return failure(`${scope.toLowerCase()}.targetKind`, "target.kind", `${scope} cannot rename '${kind}' targets.`);
}

function failure(code: string, path: string, message: string): DocumentOperationResult<never> {
  const diagnostic: DocumentDiagnostic = { severity: "error", code, path, message };
  return { success: false, diagnostics: [diagnostic] };
}
