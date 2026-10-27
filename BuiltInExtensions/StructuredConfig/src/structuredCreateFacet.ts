/**
 * Structured 模块的 `create` facet（附录 D.3）。
 *
 * 只产出默认文件名与 Lifecycle parameters、新文档字节；Quick Pick、保存对话框与
 * preview/apply 都在宿主。宿主因此没有按 editor 分支的创建逻辑。
 */
import type { JsonValue, OwnedStableIdentity } from "@visualbridge/core";
import {
  resolveStructuredConfigType,
  type StructuredCatalogRegistry,
} from "./structuredCatalog";
import { createEmptyStructuredDocument, serializeStructuredDocument } from "./structuredDocument";
import { structuredDocumentAdapter } from "./structuredDocumentAdapter";

interface CreateCatalogView {
  readonly ready: boolean;
  readonly registry: unknown;
  readonly diagnostics: readonly { readonly severity: string; readonly message: string }[];
}

interface CreateFacetInput {
  readonly projectId: string;
  readonly projectDefinition: unknown;
  readonly documentType: { readonly id: string; readonly editor: string; readonly catalogs: readonly string[] };
  readonly catalog: CreateCatalogView;
  /** 宿主注入的稳定 ID 生成器；facet 不得依赖 Node 内建模块。 */
  readonly newStableId: (prefix: string) => string;
}

export const structuredCreateFacet = {
  prepare(input: CreateFacetInput) {
    if (!input.catalog.ready) {
      return {
        kind: "unavailable" as const,
        message: `无法创建 Structured Config，Catalog Registry 无效：${firstCatalogError(input.catalog)}`,
      };
    }
    const registry = input.catalog.registry as StructuredCatalogRegistry;
    const configType = resolveStructuredConfigType(registry, input.documentType.id);
    if (configType === undefined) {
      return {
        kind: "unavailable" as const,
        message: `Document Type '${input.documentType.id}' 必须与一个 Structured Config Type ID 或 alias 对应。`,
      };
    }
    return {
      kind: "ready" as const,
      questions: [],
      fallbackExtension: "vbconfig",
      defaultFileName: () => `New${configType.title}`,
      parameters: () => ({ documentId: input.newStableId("config") }),
    };
  },

  async createDocument(input: CreateFacetInput & {
    readonly parameters: Readonly<Record<string, JsonValue>>;
    readonly targetPath: string;
  }) {
    try {
      assertParameterKeys(input.parameters, ["documentId"]);
      if (!input.catalog.ready) throw new Error(`Structured Catalog Registry 无效：${firstCatalogError(input.catalog)}`);
      const registry = input.catalog.registry as StructuredCatalogRegistry;
      const document = createEmptyStructuredDocument(
        requiredIdentifier(input.parameters.documentId, "parameters.documentId"),
        input.documentType.id,
        registry,
      );
      const ownedIdentities: readonly OwnedStableIdentity[] = structuredDocumentAdapter.lifecycle!
        .collectOwnedIdentities(document, input.documentType.id, {
          registry,
          configTypeId: input.documentType.id,
        });
      return {
        success: true as const,
        sources: [{
          path: input.targetPath,
          bytes: new TextEncoder().encode(serializeStructuredDocument(document)),
        }],
        ownedIdentities,
      };
    } catch (errorValue) {
      return { success: false as const, message: formatError(errorValue) };
    }
  },
};

function firstCatalogError(catalog: CreateCatalogView): string {
  return catalog.diagnostics.find((diagnostic) => diagnostic.severity === "error")?.message
    ?? "未配置可用 Catalog";
}

function assertParameterKeys(parameters: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
  const unexpected = Object.keys(parameters).find((key) => !allowed.includes(key));
  if (unexpected !== undefined) throw new Error(`Unexpected create parameter '${unexpected}'.`);
}

function requiredIdentifier(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error(`${path} must be a stable identifier.`);
  }
  return value;
}

function formatError(errorValue: unknown): string {
  return errorValue instanceof Error ? errorValue.message : String(errorValue);
}
