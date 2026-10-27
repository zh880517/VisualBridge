/**
 * Graph 模块的 `create` facet（附录 D.3）。
 *
 * 只产出"问什么 / 默认文件名 / Lifecycle parameters"和新文档字节；Quick Pick、保存对话框与
 * preview/apply 都在宿主。宿主因此没有按 editor 分支的创建逻辑与 Graph Type 列表。
 */
import type {
  CreateCatalogView as SharedCreateCatalogView,
  CreateFacet,
  CreateFacetInput as SharedCreateFacetInput,
  JsonValue,
  OwnedStableIdentity,
} from "@visualbridge/core";
import { createEmptyGraphDocument, serializeGraphDocument } from "./graphDocument";
import { graphDocumentAdapter } from "./graphDocumentAdapter";
import type { GraphCatalogRegistry } from "./graphCatalog";

type CreateCatalogView = SharedCreateCatalogView;
type CreateFacetInput = SharedCreateFacetInput;

export const graphCreateFacet = {
  prepare(input: CreateFacetInput) {
    const catalogError = firstCatalogError(input.catalog);
    if (!input.catalog.ready && input.documentType.catalogs.length > 0) {
      return { kind: "unavailable" as const, message: `无法创建 Graph，Catalog Registry 无效：${catalogError}` };
    }
    const registry = input.catalog.registry as GraphCatalogRegistry;
    if (
      registry.graphTypes.length > 0
      && registry.graphTypes.every((graphType) => graphType.usage === "subgraph")
    ) {
      return {
        kind: "unavailable" as const,
        message: "Graph Catalog Registry 没有可用作根图的 Graph Type。",
      };
    }
    const candidates = registry.graphTypes.filter((graphType) => graphType.usage !== "subgraph");
    return {
      kind: "ready" as const,
      questions: candidates.length === 0 ? [] : [{
        id: "rootGraphType",
        title: "Select Root Graph Type",
        placeholder: "Graph Type for the new document",
        options: candidates.map((graphType) => ({
          id: graphType.id,
          label: graphType.title,
          description: `${graphType.catalogTitle} · ${graphType.id}`,
          ...(graphType.description === undefined ? {} : { detail: graphType.description }),
        })),
      }],
      fallbackExtension: "vbgraph",
      defaultFileName: () => "NewGraph",
      parameters: (answers: Readonly<Record<string, string>>) => {
        const documentId = input.newStableId("graph");
        const rootGraphId = input.newStableId("root");
        const initialNodeIds: string[] = [];
        createEmptyGraphDocument(documentId, rootGraphId, answers.rootGraphType, registry, () => {
          const id = input.newStableId("node");
          initialNodeIds.push(id);
          return id;
        });
        return {
          documentId,
          rootGraphId,
          ...(answers.rootGraphType === undefined ? {} : { graphTypeId: answers.rootGraphType }),
          initialNodeIds,
        };
      },
    };
  },

  async createDocument(input: CreateFacetInput & {
    readonly parameters: Readonly<Record<string, JsonValue>>;
    readonly targetPath: string;
  }) {
    try {
      assertParameterKeys(input.parameters, ["documentId", "rootGraphId", "graphTypeId", "initialNodeIds"]);
      if (!input.catalog.ready && input.documentType.catalogs.length > 0) {
        throw new Error(`Graph Catalog Registry 无效：${firstCatalogError(input.catalog)}`);
      }
      const registry = input.catalog.registry as GraphCatalogRegistry;
      const ids = requiredIdentifierArray(input.parameters.initialNodeIds, "parameters.initialNodeIds");
      let index = 0;
      const document = createEmptyGraphDocument(
        requiredIdentifier(input.parameters.documentId, "parameters.documentId"),
        requiredIdentifier(input.parameters.rootGraphId, "parameters.rootGraphId"),
        optionalIdentifier(input.parameters.graphTypeId, "parameters.graphTypeId"),
        registry,
        () => {
          const id = ids[index];
          if (id === undefined) throw new Error("Graph create requires an ID for every initial node.");
          index += 1;
          return id;
        },
      );
      if (index !== ids.length) throw new Error("Graph create supplied unused initial node IDs.");
      const ownedIdentities: readonly OwnedStableIdentity[] = graphDocumentAdapter.lifecycle!
        .collectOwnedIdentities(document, input.documentType.id, { registry });
      return {
        success: true as const,
        sources: [{
          path: input.targetPath,
          bytes: new TextEncoder().encode(serializeGraphDocument(document)),
        }],
        ownedIdentities,
      };
    } catch (errorValue) {
      return { success: false as const, message: formatError(errorValue) };
    }
  },
} satisfies CreateFacet<CreateFacetInput>;

function firstCatalogError(catalog: CreateCatalogView): string {
  return catalog.diagnostics.find((diagnostic) => diagnostic.severity === "error")?.message ?? "未知错误";
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

function optionalIdentifier(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : requiredIdentifier(value, path);
}

function requiredIdentifierArray(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array.`);
  return value.map((entry, index) => requiredIdentifier(entry, `${path}[${index}]`));
}

function formatError(errorValue: unknown): string {
  return errorValue instanceof Error ? errorValue.message : String(errorValue);
}
