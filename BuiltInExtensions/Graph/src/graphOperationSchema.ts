/**
 * Graph 的 Operation Schema（供 `visualbridge_project` 的按 editors 暴露）。
 *
 * B4 只声明"支持哪些 Operation type"；字段级 Schema 由 F4 的 `$defs/documentOperation`
 * 接线后从 Protocol 契约统一生成，宿主不再手写每个 Operation 的参数形状。
 */
export const graphOperationSchema = {
  type: "object",
  required: ["type"],
  properties: {
    type: {
      enum: [
        "graph.addNode",
        "graph.addSubgraph",
        "graph.removeNode",
        "graph.moveNode",
        "graph.updateNode",
        "graph.replaceNodeType",
        "graph.addDynamicPort",
        "graph.updateDynamicPort",
        "graph.removeDynamicPort",
        "graph.reorderDynamicPorts",
        "graph.addEdge",
        "graph.removeEdge",
        "graph.assignType",
        "graph.updateGraph",
        "graph.addInterfacePort",
        "graph.updateInterfacePort",
        "graph.removeInterfacePort",
        "graph.reorderInterfacePorts",
        "graph.renameElement",
      ],
    },
  },
  additionalProperties: true,
} as const;
