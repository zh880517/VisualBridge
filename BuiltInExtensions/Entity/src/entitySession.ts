/**
 * Entity 会话控制器（B2）。
 *
 * 从宿主 `entityEditorSession.ts` 搬来的领域逻辑：解析、Catalog 依赖判定、Operation 应用、
 * 悬空引用检查、Reference 变更校验、Provider Validator 与状态消息构造。**不得 import `vscode`**：
 * Catalog 读取 / Reference 校验 / Provider 校验全部经 `ModuleSessionHost` 查询。
 */
import type { DocumentDiagnostic, JsonValue } from "@visualbridge/core";
import { searchEntityComponentTypes, type EntityCatalogRegistry } from "./entityCatalog";
import {
  applyEntityOperations,
  collectEntityReferences,
  parseEntityDocument,
  serializeEntityDocument,
  validateEntityDocument,
  type EntityDocument,
} from "./entityDocument";
import { findDanglingComponentReferenceDiagnostics } from "./entityReferences";
import type {
  ModuleSessionController,
  ModuleSessionDocument,
  ModuleSessionEffect,
  ModuleSessionHost,
  ModuleSessionMessage,
  ModuleTextCodec,
} from "./moduleSessionContract";

const INVALID_MESSAGE = "Entity Document 当前无效，无法应用操作。";
const CATALOG_UNAVAILABLE_MESSAGE = "Entity Catalog 尚未就绪，无法执行依赖 Catalog 的操作。";
const OPERATION_FAILED_MESSAGE = "Entity 操作失败。";
const REFACTOR_REQUIRED_MESSAGE =
  "refactor.required: Stable identity renames must use Reference Refactor preview/apply.";

/** 稳定身份改名必须走 Reference Refactor（宿主在外部修改确认之前用它整批拒绝）。 */
const GUARDED_RENAME_OPERATIONS: ReadonlySet<string> = new Set(["entity.renameComponent"]);

/** `storage: "text"` facet 的实际实现：Entity Document 的文本编解码。 */
export const entitySessionTextStorage: ModuleTextCodec<EntityDocument> = {
  parse(text) {
    return parseEntityDocument(text);
  },
  render(document) {
    return serializeEntityDocument(document);
  },
};

export function createEntitySessionController(): ModuleSessionController {
  return {
    state(document, host) {
      return buildState(document, host);
    },

    async handle(message, document, host) {
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
  const parsed = entitySessionTextStorage.parse(snapshot.text);
  if (!parsed.success) {
    return invalidMessage(snapshot, parsed.diagnostics);
  }
  const catalog = await host.loadCatalog();
  const registry = catalog.registry as EntityCatalogRegistry;
  const diagnostics = [
    ...parsed.diagnostics,
    ...catalog.diagnostics,
    ...(catalog.ready ? validateEntityDocument(parsed.document, registry) : []),
    ...(catalog.ready
      ? await host.validateReferences(collectEntityReferences(parsed.document, registry))
      : []),
    ...await host.validateProviderDocument({
      documentTypeId: snapshot.documentTypeId,
      path: snapshot.path,
      content: parsed.document as unknown as JsonValue,
      source: snapshot.text,
    }),
  ];
  return {
    type: "entityState",
    documentVersion: snapshot.revision,
    document: parsed.document as unknown as JsonValue,
    catalogRegistry: registry as unknown as JsonValue,
    catalogReady: catalog.ready,
    addableComponentTypeIds: catalog.ready
      ? searchEntityComponentTypes(registry, {
          entityTypeId: parsed.document.entityTypeId,
          limit: 200,
        }).map((componentType) => componentType.id)
      : [],
    isDirty: snapshot.isDirty,
    diagnostics: diagnostics as unknown as JsonValue,
  };
}

async function applyOperations(
  message: ModuleSessionMessage,
  snapshot: ModuleSessionDocument,
  host: ModuleSessionHost,
): Promise<readonly ModuleSessionEffect[]> {
  const parsed = entitySessionTextStorage.parse(snapshot.text);
  if (!parsed.success) {
    return [
      { kind: "post", message: invalidMessage(snapshot, parsed.diagnostics) },
      { kind: "post", message: rejected(INVALID_MESSAGE) },
    ];
  }

  const catalog = await host.loadCatalog();
  const registry = catalog.registry as EntityCatalogRegistry;
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

  const applied = applyEntityOperations(parsed.document, message.operations, registry);
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

  // 组件删除是单文件 Operation：同文档内仍引用被删组件时原子拒绝。
  const dangling = findDanglingComponentReferenceDiagnostics(
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
      collectEntityReferences(parsed.document, registry),
      collectEntityReferences(applied.document, registry),
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

  const nextText = entitySessionTextStorage.render(applied.document);
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
    { kind: "apply", operations: { kind: "text", text: nextText }, label: "Edit VisualBridge Entity" },
    {
      kind: "post",
      message: { type: "operationCompleted", changed: true },
    },
  ];
}

function invalidMessage(
  snapshot: ModuleSessionDocument,
  diagnostics: readonly DocumentDiagnostic[],
): ModuleSessionMessage {
  return {
    type: "entityInvalid",
    documentVersion: snapshot.revision,
    isDirty: snapshot.isDirty,
    diagnostics: diagnostics as unknown as JsonValue,
  };
}

/**
 * 拒绝消息可携带 `diagnostics`：宿主会先发布诊断再转发消息。
 *
 * 这是 B2 为保持"拒绝时不改变 Webview 文档态"的既有行为所用的载体（Webview 只读 `message`，
 * 多余字段被忽略）；B3 接管诊断发布后可移除。
 */
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
  return value.some((operation) => (
    typeof operation === "object"
    && operation !== null
    && !Array.isArray(operation)
    && typeof (operation as { readonly type?: unknown }).type === "string"
    && CATALOG_OPERATION_TYPES.has((operation as { readonly type: string }).type)
  ));
}

const CATALOG_OPERATION_TYPES: ReadonlySet<string> = new Set([
  "entity.setProperty",
  "entity.addComponent",
  "entity.setComponentProperty",
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
    : `Entity Catalog 尚未就绪：${firstError.path}: ${firstError.message}`;
}
