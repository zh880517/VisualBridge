import { useEffect, useState, type FormEvent } from "react";
import { PropertySection } from "@visualbridge/editor-ui";
import {
  createDefaultProperties,
  resolveGraphTypeDefinition,
  resolveNodeTypeDefinition,
} from "../model/graphCatalog";
import { newId } from "../model/graphUtils";
import type {
  GraphCatalogRegistry,
  GraphDefinition,
  GraphNodeData,
  GraphOperation,
  NodeTypeDefinition,
} from "../types";
import { InlineNodeProperties } from "./GraphNodes";
import { InputField, ReadonlyField } from "./GraphPickers";

export function GraphInspector({
  graph,
  isRoot,
  catalogRegistry,
  catalogReady,
  pending,
  postOperations,
  reportStatus,
}: {
  readonly graph: GraphDefinition;
  readonly isRoot: boolean;
  readonly catalogRegistry: GraphCatalogRegistry;
  readonly catalogReady: boolean;
  readonly pending: boolean;
  readonly postOperations: (operations: readonly GraphOperation[]) => void;
  readonly reportStatus: (status: { message: string; error: boolean }) => void;
}): React.JSX.Element {
  const [title, setTitle] = useState(graph.title);
  const graphType = graph.graphTypeId === undefined ? undefined : resolveGraphTypeDefinition(catalogRegistry, graph.graphTypeId);
  const assignableTypes = catalogRegistry.graphTypes.filter((candidate) => candidate.usage === "any" || candidate.usage === (isRoot ? "root" : "subgraph"));
  const [selectedGraphTypeId, setSelectedGraphTypeId] = useState(assignableTypes[0]?.id ?? "");
  useEffect(() => setTitle(graph.title), [graph.title]);
  useEffect(() => {
    setSelectedGraphTypeId((current) => assignableTypes.some((candidate) => candidate.id === current)
      ? current
      : assignableTypes[0]?.id ?? "");
  }, [catalogRegistry, isRoot]);
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    postOperations([{ type: "graph.updateGraph", graphId: graph.id, title, properties: graph.properties }]);
  };
  const propertyNodeType: NodeTypeDefinition = {
    catalogId: graphType?.catalogId ?? "untyped",
    catalogTitle: graphType?.catalogTitle ?? "Graph",
    id: graphType?.id ?? "untyped.graph",
    aliases: [],
    title: graphType?.title ?? "Untyped Graph",
    category: "Graph",
    ports: [],
    properties: graphType?.properties ?? [],
  };
  const propertyData: GraphNodeData = {
    flavor: "node",
    graphId: graph.id,
    model: {
      kind: "node",
      id: graph.id,
      nodeTypeId: propertyNodeType.id,
      title: graph.title,
      position: { x: 0, y: 0 },
      properties: graph.properties,
      dynamicPorts: [],
    },
    nodeType: propertyNodeType,
    ports: [],
    typeTitle: propertyNodeType.title,
    overriddenPropertyIds: new Set(),
    connectedInputPortIds: new Set(),
    commitNode: (_, nextTitle, properties) => postOperations([{
      type: "graph.updateGraph",
      graphId: graph.id,
      title: nextTitle === graph.title ? title : nextTitle,
      properties,
    }]),
    commitOperations: postOperations,
    reportStatus,
  };
  const assignType = (): void => {
    const nextType = resolveGraphTypeDefinition(catalogRegistry, selectedGraphTypeId);
    if (nextType === undefined || !catalogReady) {
      return;
    }
    const initialOperations: GraphOperation[] = nextType.initialNodes.flatMap((initialNode, index) => {
      const nodeType = resolveNodeTypeDefinition(catalogRegistry, initialNode.nodeTypeId);
      return nodeType === undefined || nodeType.subgraph !== undefined
        ? []
        : [{
            type: "graph.addNode" as const,
            graphId: graph.id,
            node: {
              kind: "node",
              id: newId("node"),
              nodeTypeId: nodeType.id,
              title: initialNode.title ?? nodeType.title,
              position: { x: 80 + (index % 3) * 260, y: 80 + Math.floor(index / 3) * 180 },
              properties: createDefaultProperties(nodeType),
              dynamicPorts: [],
            },
          }];
    });
    postOperations([{ type: "graph.assignType", graphId: graph.id, graphTypeId: nextType.id }, ...initialOperations]);
  };
  return (
    <aside className="graph-inspector" data-vb-property-density="sidebar">
      <h2>图检查器</h2>
      <PropertySection title="标识">
        <ReadonlyField label="图 ID" value={graph.id} />
        {graphType !== undefined
          ? <ReadonlyField label="图类型" value={`${graphType.title} · ${graphType.id}`} />
          : graph.graphTypeId !== undefined
            ? <ReadonlyField label="图类型" value={`未知 · ${graph.graphTypeId}`} />
            : (
              <section className="graph-assign-type">
                <label className="graph-field">
                  <span>图类型</span>
                  <select value={selectedGraphTypeId} disabled={!catalogReady} onChange={(event) => setSelectedGraphTypeId(event.target.value)}>
                    {assignableTypes.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.catalogTitle} / {candidate.title}</option>)}
                  </select>
                </label>
                <button type="button" disabled={pending || !catalogReady || graph.nodes.length > 0 || selectedGraphTypeId.length === 0} onClick={assignType}>设置图类型</button>
                {!catalogReady && <p className="graph-empty">目录尚未就绪，不能设置图类型。</p>}
                {graph.nodes.length > 0 && <p className="graph-empty">已有节点的旧图需要后续安全迁移，不能直接设置类型。</p>}
              </section>
            )}
      </PropertySection>
      <PropertySection title="名称">
        <form onSubmit={submit}>
          <InputField label="名称" value={title} onChange={setTitle} />
          <button type="submit" disabled={pending || title === graph.title}>应用名称修改</button>
        </form>
      </PropertySection>
      <PropertySection title="图属性">
        <InlineNodeProperties data={propertyData} pending={pending} />
      </PropertySection>
    </aside>
  );
}
