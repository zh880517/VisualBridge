/**
 * Structured Config 会话控制器（B2）。
 *
 * 从宿主 `structuredEditorSession.ts` 搬来的领域逻辑：解析、Structured Catalog 依赖、
 * Operation 应用、Reference 变更校验、Provider Validator 与状态消息构造。
 * **不得 import `vscode`**；外部修改确认与文档刷新仍由宿主完成。
 */
import type { DocumentDiagnostic, JsonValue } from "@visualbridge/core";
import { resolveStructuredConfigType, type StructuredCatalogRegistry } from "./structuredCatalog";
import {
  applyStructuredOperations,
  collectStructuredReferences,
  parseStructuredDocument,
  serializeStructuredDocument,
  validateStructuredDocument,
  type StructuredDocument,
} from "./structuredDocument";
import type {
  ModuleSessionController,
  ModuleSessionDocument,
  ModuleSessionEffect,
  ModuleSessionHost,
  ModuleSessionMessage,
  ModuleTextCodec,
} from "./moduleSessionContract";

const INVALID_MESSAGE = "Structured Config 当前无效，无法应用操作。";
const CATALOG_UNAVAILABLE_MESSAGE = "Structured Catalog 尚未就绪。";
const OPERATION_FAILED_MESSAGE = "Structured Config 操作无效。";

/** `storage: "text"` facet 的实际实现：Structured Config 的文本编解码。 */
export const structuredSessionTextStorage: ModuleTextCodec<StructuredDocument> = {
  parse(text) {
    return parseStructuredDocument(text);
  },
  render(document) {
    return serializeStructuredDocument(document);
  },
};

export function createStructuredSessionController(): ModuleSessionController {
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
  };
}

async function buildState(
  snapshot: ModuleSessionDocument,
  host: ModuleSessionHost,
): Promise<JsonValue> {
  const parsed = structuredSessionTextStorage.parse(snapshot.text);
  if (!parsed.success) {
    return invalidMessage(snapshot, parsed.diagnostics);
  }
  const catalog = await host.loadCatalog();
  const registry = catalog.registry as StructuredCatalogRegistry;
  const configType = catalog.ready
    ? resolveStructuredConfigType(registry, snapshot.documentTypeId)
    : undefined;
  const diagnostics = [
    ...parsed.diagnostics,
    ...catalog.diagnostics,
    ...(catalog.ready
      ? validateStructuredDocument(parsed.document, registry, snapshot.documentTypeId)
      : []),
    ...(catalog.ready
      ? await host.validateReferences(
          collectStructuredReferences(parsed.document, registry, snapshot.documentTypeId),
        )
      : []),
    ...await host.validateProviderDocument({
      documentTypeId: snapshot.documentTypeId,
      path: snapshot.path,
      content: parsed.document as unknown as JsonValue,
      source: snapshot.text,
    }),
  ];
  if (configType === undefined) {
    return invalidMessage(snapshot, diagnostics);
  }
  return {
    type: "structuredState",
    documentVersion: snapshot.revision,
    document: parsed.document as unknown as JsonValue,
    configType: configType as unknown as JsonValue,
    isDirty: snapshot.isDirty,
    diagnostics: diagnostics as unknown as JsonValue,
  };
}

async function applyOperations(
  message: ModuleSessionMessage,
  snapshot: ModuleSessionDocument,
  host: ModuleSessionHost,
): Promise<readonly ModuleSessionEffect[]> {
  const parsed = structuredSessionTextStorage.parse(snapshot.text);
  if (!parsed.success) {
    return [
      { kind: "post", message: invalidMessage(snapshot, parsed.diagnostics) },
      { kind: "post", message: rejected(INVALID_MESSAGE) },
    ];
  }

  const catalog = await host.loadCatalog();
  const registry = catalog.registry as StructuredCatalogRegistry;
  if (!catalog.ready) {
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

  const applied = applyStructuredOperations(
    parsed.document,
    message.operations,
    registry,
    snapshot.documentTypeId,
  );
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

  const referenceResult = await host.validateReferenceChange(
    collectStructuredReferences(parsed.document, registry, snapshot.documentTypeId),
    collectStructuredReferences(applied.document, registry, snapshot.documentTypeId),
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

  const nextText = structuredSessionTextStorage.render(applied.document);
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
    {
      kind: "apply",
      operations: { kind: "text", text: nextText },
      label: "Edit VisualBridge Structured Config",
    },
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
    type: "structuredInvalid",
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
    : `Structured Catalog 尚未就绪：${firstError.path}: ${firstError.message}`;
}
