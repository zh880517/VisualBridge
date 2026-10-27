/**
 * Entity 模块的 `create` facet（附录 D.3）。
 *
 * 只产出"问什么 / 默认文件名 / Lifecycle parameters"和新文档字节；Quick Pick、保存对话框与
 * preview/apply 都在宿主。宿主因此没有按 editor 分支的创建逻辑与 Entity Type 列表。
 */
import type {
  CreateCatalogView as SharedCreateCatalogView,
  CreateFacet,
  CreateFacetInput as SharedCreateFacetInput,
  JsonValue,
  OwnedStableIdentity,
} from "@visualbridge/module-sdk";
import type { EntityCatalogRegistry } from "./entityCatalog";
import { createEmptyEntityDocument, serializeEntityDocument } from "./entityDocument";
import { entityDocumentAdapter } from "./entityDocumentAdapter";

type CreateCatalogView = SharedCreateCatalogView;
type CreateFacetInput = SharedCreateFacetInput;

export const entityCreateFacet = {
  prepare(input: CreateFacetInput) {
    const catalogError = firstCatalogError(input.catalog);
    if (!input.catalog.ready) {
      return { kind: "unavailable" as const, message: `无法创建 Entity，Catalog Registry 无效：${catalogError}` };
    }
    const registry = input.catalog.registry as EntityCatalogRegistry;
    if (registry.entityTypes.length === 0) {
      return { kind: "unavailable" as const, message: "Entity Catalog Registry 没有 Entity Type。" };
    }
    return {
      kind: "ready" as const,
      questions: [{
        id: "entityType",
        title: "Select Entity Type",
        placeholder: "Runtime structure for the new Entity Document",
        options: registry.entityTypes.map((entry) => ({
          id: entry.id,
          label: entry.title,
          description: `${entry.catalogTitle} · ${entry.id}`,
          ...(entry.description === undefined ? {} : { detail: entry.description }),
        })),
      }],
      fallbackExtension: "vbentity",
      defaultFileName: (answers: Readonly<Record<string, string>>) => `New${titleOf(registry, answers.entityType)}`,
      parameters: (answers: Readonly<Record<string, string>>) => ({
        documentId: input.newStableId("entity"),
        entityTypeId: answers.entityType ?? "",
        title: titleOf(registry, answers.entityType),
      }),
    };
  },

  async createDocument(input: CreateFacetInput & {
    readonly parameters: Readonly<Record<string, JsonValue>>;
    readonly targetPath: string;
  }) {
    try {
      assertParameterKeys(input.parameters, ["documentId", "entityTypeId", "title"]);
      if (!input.catalog.ready) throw new Error(`Entity Catalog Registry 无效：${firstCatalogError(input.catalog)}`);
      const registry = input.catalog.registry as EntityCatalogRegistry;
      const document = createEmptyEntityDocument(
        requiredIdentifier(input.parameters.documentId, "parameters.documentId"),
        requiredIdentifier(input.parameters.entityTypeId, "parameters.entityTypeId"),
        registry,
        optionalString(input.parameters.title, "parameters.title") ?? "New Entity",
      );
      const ownedIdentities: readonly OwnedStableIdentity[] = entityDocumentAdapter.lifecycle!
        .collectOwnedIdentities(document, input.documentType.id, { registry });
      return {
        success: true as const,
        sources: [{
          path: input.targetPath,
          bytes: new TextEncoder().encode(serializeEntityDocument(document)),
        }],
        ownedIdentities,
      };
    } catch (errorValue) {
      return { success: false as const, message: formatError(errorValue) };
    }
  },
} satisfies CreateFacet<CreateFacetInput>;

function titleOf(registry: EntityCatalogRegistry, entityTypeId: string | undefined): string {
  const entityType = registry.entityTypes.find((entry) => entry.id === entityTypeId);
  return entityType?.title ?? "Entity";
}

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

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${path} must be a string.`);
  return value;
}

function formatError(errorValue: unknown): string {
  return errorValue instanceof Error ? errorValue.message : String(errorValue);
}
