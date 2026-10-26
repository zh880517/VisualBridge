/**
 * Graph 会话控制器（B2）。
 *
 * 从宿主 `graphEditorSession.ts` 搬来的领域逻辑：解析、Catalog 依赖判定、Operation 应用、
 * 悬空元素引用检查、Reference 变更校验、Provider Validator、替换候选与状态消息构造。
 * **不得 import `vscode`**；执行调试（Runtime 连接）仍由宿主先处理、不转发给控制器。
 */
import type { DocumentDiagnostic, JsonValue } from "@visualbridge/core";
import {
  applyGraphOperations,
  collectGraphReferences,
  findDanglingGraphElementReferenceDiagnostics,
  getReplacementCandidates,
  parseGraphDocument,
  serializeGraphDocument,
  validateGraphDocument,
  type GraphDocument,
} from "./graphDocument";
import type { GraphCatalogRegistry } from "./graphCatalog";
import type {
  ModuleSessionController,
  ModuleSessionDocument,
  ModuleSessionEffect,
  ModuleSessionHost,
  ModuleSessionMessage,
  ModuleTextCodec,
} from "./moduleSessionContract";

const INVALID_MESSAGE = "Graph Document 当前无效，无法应用操作。";
const CATALOG_UNAVAILABLE_MESSAGE = "Graph Catalog 尚未就绪，无法执行依赖 Catalog 的操作。";
const OPERATION_FAILED_MESSAGE = "Graph 操作无效。";
const REFACTOR_REQUIRED_MESSAGE =
  "refactor.required: Stable identity renames must use Reference Refactor preview/apply.";

const GUARDED_RENAME_OPERATIONS: ReadonlySet<string> = new Set(["graph.renameElement"]);

/** `storage: "text"` facet 的实际实现：Graph Document 的文本编解码。 */
export const graphSessionTextStorage: ModuleTextCodec<GraphDocument> = {
  parse(text) {
    return parseGraphDocument(text);
  },
  render(document) {
    return serializeGraphDocument(document);
  },
};

export function createGraphSessionController(): ModuleSessionController {
  return {
    state(document, host) {
      return buildState(document, host);
    },

    async handle(message, document, host) {
      if (message.type === "requestReplacementCandidates") {
        return sendReplacementCandidates(message, document, host);
      }
      if (message.type !== "applyOperations") {
        return [];
      }
      return applyOperations(message, document, host);
    },

    checkOperations(operations) {
      return guardedRenameMessage(operations);
    },
  };
}

async function buildState(
  snapshot: ModuleSessionDocument,
  host: ModuleSessionHost,
): Promise<JsonValue> {
  const parsed = graphSessionTextStorage.parse(snapshot.text);
  if (!parsed.success) {
    return invalidMessage(snapshot, parsed.diagnostics);
  }
  const catalog = await host.loadCatalog();
  const registry = catalog.registry as GraphCatalogRegistry;
  const diagnostics = [
    ...parsed.diagnostics,
    ...catalog.diagnostics,
    ...(catalog.ready ? validateGraphDocument(parsed.document, registry) : []),
    ...(catalog.ready
      ? await host.validateReferences(collectGraphReferences(parsed.document, registry))
      : []),
    ...await host.validateProviderDocument({
      documentTypeId: snapshot.documentTypeId,
      path: snapshot.path,
      content: parsed.document as unknown as JsonValue,
      source: snapshot.text,
    }),
  ];
  return {
    type: "graphState",
    documentVersion: snapshot.revision,
    document: parsed.document as unknown as JsonValue,
    catalogRegistry: registry as unknown as JsonValue,
    catalogReady: catalog.ready,
    isDirty: snapshot.isDirty,
    diagnostics: diagnostics as unknown as JsonValue,
  };
}

async function applyOperations(
  message: ModuleSessionMessage,
  snapshot: ModuleSessionDocument,
  host: ModuleSessionHost,
): Promise<readonly ModuleSessionEffect[]> {
  const parsed = graphSessionTextStorage.parse(snapshot.text);
  if (!parsed.success) {
    return [
      { kind: "post", message: invalidMessage(snapshot, parsed.diagnostics) },
      { kind: "post", message: rejected(INVALID_MESSAGE) },
    ];
  }

  const catalog = await host.loadCatalog();
  const registry = catalog.registry as GraphCatalogRegistry;
  if (!catalog.ready && operationsRequireCatalog(message.operations)) {
    return [
      {
        kind: "post",
        message: rejected(
          formatCatalogUnavailable(catalog.diagnostics),
          [...parsed.diagnostics, ...catalog.diagnostics],
        ),
      },
    ];
  }

  const applied = applyGraphOperations(parsed.document, message.operations, registry);
  if (!applied.success) {
    return [
      {
        kind: "post",
        message: rejected(
          formatDiagnostics(applied.diagnostics, OPERATION_FAILED_MESSAGE),
          [...catalog.diagnostics, ...applied.diagnostics],
        ),
      },
    ];
  }

  // 元素删除是单文件 Operation：同文档内仍引用被删元素时原子拒绝。
  const dangling = findDanglingGraphElementReferenceDiagnostics(
    parsed.document,
    applied.document,
    registry,
  );
  if (dangling.length > 0) {
    return [
      {
        kind: "post",
        message: rejected(
          formatDiagnostics(dangling, OPERATION_FAILED_MESSAGE),
          [...catalog.diagnostics, ...applied.diagnostics, ...dangling],
        ),
      },
    ];
  }

  if (catalog.ready) {
    const referenceResult = await host.validateReferenceChange(
      collectGraphReferences(parsed.document, registry),
      collectGraphReferences(applied.document, registry),
    );
    if (referenceResult.introducedErrors.length > 0) {
      return [
        {
          kind: "post",
          message: rejected(
            formatDiagnostics(referenceResult.introducedErrors, OPERATION_FAILED_MESSAGE),
            [...catalog.diagnostics, ...applied.diagnostics, ...referenceResult.diagnostics],
          ),
        },
      ];
    }
  }

  const nextText = graphSessionTextStorage.render(applied.document);
  const providerDiagnostics = await host.validateProviderDocument({
    documentTypeId: snapshot.documentTypeId,
    path: snapshot.path,
    content: applied.document as unknown as JsonValue,
    source: nextText,
  });
  const providerErrors = providerDiagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (providerErrors.length > 0) {
    return [
      {
        kind: "post",
        message: rejected(
          formatDiagnostics(providerErrors, OPERATION_FAILED_MESSAGE),
          [...catalog.diagnostics, ...applied.diagnostics, ...providerDiagnostics],
        ),
      },
    ];
  }

  if (nextText === snapshot.text) {
    return [
      {
        kind: "post",
        message: { type: "operationCompleted", changed: false },
      },
    ];
  }
  return [
    { kind: "apply", operations: { kind: "text", text: nextText }, label: "Edit VisualBridge Graph" },
    {
      kind: "post",
      message: { type: "operationCompleted", changed: true },
    },
  ];
}

async function sendReplacementCandidates(
  message: ModuleSessionMessage,
  snapshot: ModuleSessionDocument,
  host: ModuleSessionHost,
): Promise<readonly ModuleSessionEffect[]> {
  if (
    typeof message.documentVersion !== "number"
    || message.documentVersion !== snapshot.revision
    || typeof message.graphId !== "string"
    || typeof message.nodeId !== "string"
  ) {
    return [{ kind: "post", message: await buildState(snapshot, host) as ModuleSessionMessage }];
  }
  const parsed = graphSessionTextStorage.parse(snapshot.text);
  if (!parsed.success) {
    return [{ kind: "post", message: invalidMessage(snapshot, parsed.diagnostics) }];
  }
  const catalog = await host.loadCatalog();
  const registry = catalog.registry as GraphCatalogRegistry;
  return [{
    kind: "post",
    message: {
      type: "replacementCandidates",
      documentVersion: snapshot.revision,
      graphId: message.graphId,
      nodeId: message.nodeId,
      nodeTypeIds: catalog.ready
        ? getReplacementCandidates(
            parsed.document,
            message.graphId,
            message.nodeId,
            registry,
          ).map((nodeType) => nodeType.id) as unknown as JsonValue
        : [],
    },
  }];
}

function invalidMessage(
  snapshot: ModuleSessionDocument,
  diagnostics: readonly DocumentDiagnostic[],
): ModuleSessionMessage {
  return {
    type: "graphInvalid",
    documentVersion: snapshot.revision,
    isDirty: snapshot.isDirty,
    diagnostics: diagnostics as unknown as JsonValue,
  };
}

function rejected(
  message: string,
  diagnostics?: readonly DocumentDiagnostic[],
): ModuleSessionMessage {
  return {
    type: "operationRejected",
    message,
    ...(diagnostics === undefined ? {} : { diagnostics: diagnostics as unknown as JsonValue }),
  };
}

function guardedRenameMessage(operations: unknown): string | undefined {
  if (!Array.isArray(operations)) return undefined;
  const guarded = operations.some((operation) => (
    typeof operation === "object"
    && operation !== null
    && !Array.isArray(operation)
    && GUARDED_RENAME_OPERATIONS.has((operation as { readonly type?: unknown }).type as string)
  ));
  return guarded ? REFACTOR_REQUIRED_MESSAGE : undefined;
}

function operationsRequireCatalog(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((operation) => {
    if (typeof operation !== "object" || operation === null || Array.isArray(operation)) {
      return false;
    }
    const candidate = operation as {
      readonly type?: unknown;
      readonly node?: { readonly nodeTypeId?: unknown };
      readonly subgraph?: { readonly graphTypeId?: unknown };
    };
    if (candidate.type === "graph.addSubgraph") {
      return typeof candidate.node?.nodeTypeId === "string"
        || typeof candidate.subgraph?.graphTypeId === "string";
    }
    return typeof candidate.type === "string" && CATALOG_OPERATION_TYPES.has(candidate.type);
  });
}

const CATALOG_OPERATION_TYPES: ReadonlySet<string> = new Set([
  "graph.addNode",
  "graph.replaceNodeType",
  "graph.addDynamicPort",
  "graph.updateDynamicPort",
  "graph.addEdge",
  "graph.assignType",
]);

function formatDiagnostics(
  diagnostics: readonly DocumentDiagnostic[],
  fallback: string,
): string {
  const first = diagnostics[0];
  return first === undefined ? fallback : `${first.path}: ${first.message}`;
}

function formatCatalogUnavailable(diagnostics: readonly DocumentDiagnostic[]): string {
  const firstError = diagnostics.find((diagnostic) => diagnostic.severity === "error");
  return firstError === undefined
    ? CATALOG_UNAVAILABLE_MESSAGE
    : `Graph Catalog 尚未就绪：${firstError.path}: ${firstError.message}`;
}
