import { compareUtf16CodeUnits } from "@visualbridge/core";
import type {
  GraphCatalog,
  GraphCatalogLookup,
  GraphCatalogRegistry,
  GraphNodeSearchOptions,
  GraphNodeSelector,
  GraphNodeTypeDefinition,
  GraphTypeDefinition,
  RegisteredGraphNodeTypeDefinition,
  RegisteredGraphTypeDefinition,
} from "./types";

export function resolveNodeType(
  catalog: GraphCatalogRegistry,
  nodeTypeId: string,
): RegisteredGraphNodeTypeDefinition | undefined;
export function resolveNodeType(
  catalog: GraphCatalog,
  nodeTypeId: string,
): GraphNodeTypeDefinition | undefined;
export function resolveNodeType(
  catalog: GraphCatalogLookup,
  nodeTypeId: string,
): GraphNodeTypeDefinition | undefined;
export function resolveNodeType(
  catalog: GraphCatalogLookup,
  nodeTypeId: string,
): GraphNodeTypeDefinition | undefined {
  return catalog.nodeTypes.find(
    (nodeType) => nodeType.id === nodeTypeId || nodeType.aliases.includes(nodeTypeId),
  );
}

export function resolveGraphType(
  catalog: GraphCatalogRegistry,
  graphTypeId: string,
): RegisteredGraphTypeDefinition | undefined;
export function resolveGraphType(
  catalog: GraphCatalog,
  graphTypeId: string,
): GraphTypeDefinition | undefined;
export function resolveGraphType(
  catalog: GraphCatalogLookup,
  graphTypeId: string,
): GraphTypeDefinition | undefined;
export function resolveGraphType(
  catalog: GraphCatalogLookup,
  graphTypeId: string,
): GraphTypeDefinition | undefined {
  return resolveGraphTypeFromList(catalog.graphTypes, graphTypeId);
}

export function matchesNodeSelector(
  nodeType: GraphNodeTypeDefinition,
  selector: GraphNodeSelector,
): boolean {
  const nodeTypeMatch = selector.nodeTypeIds === undefined
    || selector.nodeTypeIds.some((id) => id === nodeType.id || nodeType.aliases.includes(id));
  const tagMatch = selector.tags === undefined
    || selector.tags.some((tag) => nodeType.tags.includes(tag));
  const traitMatch = selector.traits === undefined
    || selector.traits.every((trait) => nodeType.traits.includes(trait));
  return nodeTypeMatch && tagMatch && traitMatch;
}

export function isNodeTypeAllowed(
  graphType: GraphTypeDefinition,
  nodeType: GraphNodeTypeDefinition | RegisteredGraphNodeTypeDefinition,
): boolean {
  const catalogAllowed = !("catalogId" in nodeType)
    || graphType.supportedCatalogIds.includes(nodeType.catalogId);
  return catalogAllowed && (
    graphType.allowedNodeSelectors === undefined
    || graphType.allowedNodeSelectors.some((selector) => matchesNodeSelector(nodeType, selector))
  );
}

export function searchGraphNodeTypes(
  catalog: GraphCatalogRegistry,
  options: GraphNodeSearchOptions = {},
): readonly RegisteredGraphNodeTypeDefinition[] {
  const graphType = options.graphTypeId === undefined
    ? undefined
    : resolveGraphType(catalog, options.graphTypeId);
  if (options.graphTypeId !== undefined && graphType === undefined) {
    return [];
  }

  const queryTerms = options.query?.trim().toLowerCase().split(/\s+/).filter(Boolean) ?? [];
  const limit = Math.max(1, Math.floor(options.limit ?? 50));
  return catalog.nodeTypes
    .filter((nodeType) => options.includeSubgraphNodeTypes !== false || nodeType.subgraph === undefined)
    .filter((nodeType) => graphType === undefined || isNodeTypeAllowed(graphType, nodeType))
    .filter((nodeType) => {
      const searchText = nodeSearchText(nodeType);
      return queryTerms.every((term) => searchText.includes(term));
    })
    .sort((left, right) => {
      const pathComparison = compareUtf16CodeUnits(nodeDisplayPath(left), nodeDisplayPath(right));
      return pathComparison !== 0 ? pathComparison : compareUtf16CodeUnits(left.id, right.id);
    })
    .slice(0, limit);
}

export function nodeSearchText(nodeType: RegisteredGraphNodeTypeDefinition): string {
  return [
    nodeType.catalogTitle,
    nodeType.catalogId,
    nodeType.title,
    nodeType.id,
    ...nodeType.aliases,
    nodeType.category,
    ...nodeType.menuPath,
    ...nodeType.tags,
    ...nodeType.traits,
    nodeType.source?.providerId,
    nodeType.source?.assemblyName,
    nodeType.source?.typeName,
    nodeType.source?.wrapperTypeName,
  ]
    .filter((value): value is string => value !== undefined)
    .join("\n")
    .toLowerCase();
}

export function nodeDisplayPath(nodeType: RegisteredGraphNodeTypeDefinition): string {
  const relativePath = nodeType.menuPath.length > 0 ? nodeType.menuPath : [nodeType.category];
  return [nodeType.catalogTitle, ...relativePath, nodeType.title].join(" / ");
}
export function resolveNodeTypeFromList<TNodeType extends GraphNodeTypeDefinition>(
  nodeTypes: readonly TNodeType[],
  nodeTypeId: string,
): TNodeType | undefined {
  return nodeTypes.find((nodeType) => nodeType.id === nodeTypeId || nodeType.aliases.includes(nodeTypeId));
}

export function resolveGraphTypeFromList<TGraphType extends GraphTypeDefinition>(
  graphTypes: readonly TGraphType[],
  graphTypeId: string,
): TGraphType | undefined {
  return graphTypes.find((graphType) => graphType.id === graphTypeId || graphType.aliases.includes(graphTypeId));
}
