/**
 * Graph 模块的宿主语义面（附录 D.3 的 `storage` / `semantic` / `referenceData` / `references`）。
 *
 * 宿主只依赖 `DocumentFacet` 结构：解析、校验、引用收集、引用数据、生命周期目标全部委托给
 * Graph 的 adapter。本文件不 import 任何宿主类型。
 */
import type {
  DocumentDiagnostic,
  DocumentFacet,
  DocumentFacetContext,
  DocumentFacetSourceFile,
  DocumentOperationResult,
} from "@visualbridge/module-sdk";
import {
  applyGraphOperations,
  findDanglingGraphElementReferenceDiagnostics,
  parseGraphDocument,
  serializeGraphDocument,
  GRAPH_EDITOR_ID,
  type GraphDocument,
} from "./graphDocument";
import {
  createEmptyGraphCatalogRegistry,
  type GraphCatalogRegistry,
} from "./graphCatalog";
import { graphDocumentAdapter } from "./graphDocumentAdapter";
import { collectGraphOwnedIdentities } from "./graphLifecycle";
import {
  createGraphElementReferenceProvider,
  GRAPH_ELEMENT_REFERENCE_KIND,
  type GraphReferenceDocument,
} from "./graphReferences";

type GraphTarget = Exclude<import("@visualbridge/module-sdk").DocumentLifecycleDeleteTarget, { readonly kind: "document" }>;

export const graphDocumentFacet: DocumentFacet<GraphDocument, GraphCatalogRegistry> = {
  editor: GRAPH_EDITOR_ID,
  storage: "text",
  references: [{
    kind: GRAPH_ELEMENT_REFERENCE_KIND,
    createProvider: (loadReferenceData) => createGraphElementReferenceProvider(
      // facet 边界：引用数据由本模块写入，这里收窄回 GraphReferenceDocument。
      async () => await loadReferenceData() as readonly GraphReferenceDocument[],
    ),
  }],

  parseText(text, context) {
    const parsed = parseGraphDocument(text);
    return parsed.success
      ? {
          ...parsed,
          referenceData: {
            projectId: context.projectId,
            documentTypeId: context.documentTypeId,
            path: context.path,
            document: parsed.document,
          },
        }
      : parsed;
  },

  async renderSources(document, sources) {
    const source = onlySource(sources, "Graph");
    return [{ path: source.path, bytes: new TextEncoder().encode(serializeGraphDocument(document)) }];
  },

  describe(document, context) {
    const root = document.graphs.find((graph) => graph.id === document.rootGraphId);
    return { documentId: document.documentId, title: root?.title ?? fileTitle(context.path) };
  },

  validate(document, context) {
    return context.registry === undefined ? [] : graphDocumentAdapter.validate(document, { registry: context.registry });
  },

  collectReferences(document, context) {
    return context.registry === undefined
      ? []
      : graphDocumentAdapter.collectReferences(document, { registry: context.registry });
  },

  applyOperations(document, operations, context) {
    return graphDocumentAdapter.applyOperations(document, operations, requireRegistry(context, "Graph"));
  },

  replaceReferenceValues(document, context, occurrencePaths, replacement) {
    return graphDocumentAdapter.replaceReferenceValues(document, requireRegistry(context, "Graph"), occurrencePaths, replacement);
  },

  renameDocumentId(document, documentId, context) {
    return graphDocumentAdapter.renameDocumentId!(document, documentId, requireRegistry(context, "Graph"));
  },

  renameTarget(document, target, previous, replacement, context) {
    if (target.kind !== "graph.element") return targetKindFailure("Graph", target.kind);
    const graphId = requiredString(target.graphId, "target.graphId");
    const elementId = requiredString(target.elementId, "target.elementId");
    const elementKind = requiredElementKind(target.elementKind);
    if (elementId !== previous) {
      return failure("graph.targetChanged", "target.elementId", "The Graph element target changed after the preview was created.");
    }
    const newElementId = requiredString(replacement, "replacement");
    const { registry } = requireRegistry(context, "Graph");
    const nodeId = target.nodeId === undefined ? undefined : requiredString(target.nodeId, "target.nodeId");
    return applyGraphOperations(document, [{
      type: "graph.renameElement",
      graphId,
      elementKind,
      elementId,
      newElementId,
      ...(nodeId === undefined ? {} : { nodeId }),
    }], registry);
  },

  guardOperations(_document, operations) {
    if (!Array.isArray(operations)) return [];
    // 元素删除不受守卫（单文件 Operation，悬空引用由 validateTransition 兜底）；
    // 仅稳定 ID 重命名仍必须走 Reference Refactor。
    return operations.flatMap((entry, index) => (
      typeof entry === "object"
        && entry !== null
        && (entry as { readonly type?: unknown }).type === "graph.renameElement"
        ? [{
            severity: "error" as const,
            code: "lifecycle.required",
            path: `operations[${index}].type`,
            message: "Stable Graph element IDs must be changed through visualbridge_refactor_reference.",
          }]
        : []
    ));
  },

  validateTransition(before, after, context) {
    return context.registry === undefined
      ? []
      : findDanglingGraphElementReferenceDiagnostics(before, after, context.registry);
  },

  collectOwnedIdentities(document, context) {
    return collectGraphOwnedIdentities(document, context.documentTypeId);
  },

  incomingReference(document, context, occurrencePath) {
    const graphMatch = /^graphs\[(\d+)\](?:\.(.*))?$/u.exec(occurrencePath);
    if (graphMatch === null) return undefined;
    const graph = document.graphs[Number.parseInt(graphMatch[1]!, 10)];
    if (graph === undefined) return undefined;
    const remainder = graphMatch[2];
    const nodeMatch = remainder === undefined ? null : /^nodes\[(\d+)\](?:\.(.*))?$/u.exec(remainder);
    const node = nodeMatch === null ? undefined : graph.nodes[Number.parseInt(nodeMatch[1]!, 10)];
    const fieldPath = (nodeMatch?.[2] ?? remainder)?.replace(/^properties\./u, "");
    const base = {
      projectId: context.projectId,
      documentTypeId: context.documentTypeId,
      path: context.path,
      documentId: document.documentId,
      graphId: graph.id,
    };
    return {
      title: graph.title,
      ...(node === undefined ? {} : { nodeTitle: node.title }),
      ...(fieldPath === undefined ? {} : { fieldPath }),
      location: node === undefined
        ? { ...base, elementKind: "graph", elementId: graph.id }
        : { ...base, elementKind: "node", elementId: node.id, nodeId: node.id },
    };
  },

  remapOwnedIdentities(document, context, remap) {
    return graphDocumentAdapter.lifecycle!.remapOwnedIdentities(document, context.documentTypeId, remap, {
      registry: context.registry ?? createEmptyGraphCatalogRegistry(),
    });
  },

  deleteOwnedTarget(document, target: GraphTarget, context) {
    const { registry } = requireRegistry(context, "Graph");
    return graphDocumentAdapter.lifecycle!.deleteOwnedTarget(document, target, { registry });
  },
};

function requireRegistry(
  context: DocumentFacetContext<GraphCatalogRegistry>,
  scope: string,
): { readonly registry: GraphCatalogRegistry } {
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

/** 文档标题的兜底：Project 内路径的物理文件名（不含扩展名）。 */
function fileTitle(path: string): string {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const base = path.slice(separator + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? base : base.slice(0, dot);
}

function requiredElementKind(value: unknown): "graph" | "node" | "interfacePort" | "dynamicPort" {
  if (value === "graph" || value === "node" || value === "interfacePort" || value === "dynamicPort") return value;
  throw new Error("target.elementKind must be 'graph', 'node', 'interfacePort' or 'dynamicPort'.");
}

function targetKindFailure(scope: string, kind: string): DocumentOperationResult<never> {
  return failure(`${scope.toLowerCase()}.targetKind`, "target.kind", `${scope} cannot rename '${kind}' targets.`);
}

function failure(code: string, path: string, message: string): DocumentOperationResult<never> {
  const diagnostic: DocumentDiagnostic = { severity: "error", code, path, message };
  return { success: false, diagnostics: [diagnostic] };
}
