import { compareUtf16CodeUnits } from "@visualbridge/core";
import { resolveDynamicPortGroup, resolveNodeType, type GraphCatalogRegistry } from "./graphCatalog";
import type { GraphDefinition, GraphNode, GraphPosition } from "./graphDocument";

export type GraphAutoLayoutDirection = "LR" | "TB";

// 尺寸估算常量对齐 Editors/Graph webview 的 .graph-node 卡片样式；
// 估算只需近似值，布局结果对小幅偏差不敏感。
const NODE_WIDTH = 292;
const NODE_MIN_HEIGHT = 112;
const NODE_HEADER_HEIGHT = 38;
const NODE_BASE_PADDING = 26;
const PROPERTY_ROW_HEIGHT = 32;
const PORT_ROW_HEIGHT = 24;
const NODE_GAP = 40;
const RANK_SPACING = 120;
const LAYOUT_MARGIN = 80;
const LAYOUT_GRID = 10;

interface EstimatedSize {
  readonly width: number;
  readonly height: number;
}

function estimateNodeSize(node: GraphNode, registry?: GraphCatalogRegistry): EstimatedSize {
  const nodeType = node.nodeTypeId === undefined || registry === undefined
    ? undefined
    : resolveNodeType(registry, node.nodeTypeId);
  let sectionRows: number;
  let propertyRows: number;
  if (nodeType === undefined) {
    // 无 Catalog 时退化为粗略估算：属性一行一格，动态端口按通用行计。
    propertyRows = Object.keys(node.properties).length;
    sectionRows = node.dynamicPorts.length;
  } else {
    const propertyIds = new Set(nodeType.properties.flatMap((property) => [property.id, ...property.aliases]));
    propertyRows = nodeType.properties.length
      + Object.keys(node.properties).filter((propertyId) => !propertyIds.has(propertyId)).length;
    let flowInputs = 0;
    let flowOutputs = 0;
    let dataInputs = 0;
    let dataOutputs = 0;
    for (const port of nodeType.ports) {
      // 属性输入端口渲染在属性行内，不单独占数据列。
      if ([port.id, ...port.aliases].some((portId) => propertyIds.has(portId))) {
        continue;
      }
      if (port.kind === "flow") {
        port.direction === "input" ? flowInputs += 1 : flowOutputs += 1;
      } else {
        port.direction === "input" ? dataInputs += 1 : dataOutputs += 1;
      }
    }
    for (const port of node.dynamicPorts) {
      const group = resolveDynamicPortGroup(nodeType, port.groupId);
      if (group === undefined) {
        continue;
      }
      if (group.port.kind === "flow") {
        group.port.direction === "input" ? flowInputs += 1 : flowOutputs += 1;
      } else {
        group.port.direction === "input" ? dataInputs += 1 : dataOutputs += 1;
      }
    }
    sectionRows = Math.max(flowInputs, flowOutputs) + Math.max(dataInputs, dataOutputs);
  }
  const height = NODE_HEADER_HEIGHT
    + NODE_BASE_PADDING
    + propertyRows * PROPERTY_ROW_HEIGHT
    + sectionRows * PORT_ROW_HEIGHT;
  return { width: NODE_WIDTH, height: Math.max(NODE_MIN_HEIGHT, height) };
}

function edgeKey(source: string, target: string): string {
  return `${source}\u0000${target}`;
}

/** 迭代 DFS 检测回边，用于在分层前打破环；邻接表有序保证结果确定。 */
function findBackEdges(vertices: readonly string[], adjacency: ReadonlyMap<string, readonly string[]>): Set<string> {
  const color = new Map<string, 0 | 1 | 2>(vertices.map((vertex) => [vertex, 0]));
  const backEdges = new Set<string>();
  for (const root of vertices) {
    if (color.get(root) !== 0) {
      continue;
    }
    const stack: Array<[string, number]> = [[root, 0]];
    color.set(root, 1);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame === undefined) {
        break;
      }
      const neighbors = adjacency.get(frame[0]) ?? [];
      if (frame[1] >= neighbors.length) {
        color.set(frame[0], 2);
        stack.pop();
        continue;
      }
      const next = neighbors[frame[1]];
      frame[1] += 1;
      if (next === undefined) {
        continue;
      }
      const nextColor = color.get(next);
      if (nextColor === 1) {
        backEdges.add(edgeKey(frame[0], next));
      } else if (nextColor === 0) {
        color.set(next, 1);
        stack.push([next, 0]);
      }
    }
  }
  return backEdges;
}

/** 忽略回边后的最长路径分层（Kahn 拓扑序，就绪队列按 ID 排序保证确定性）。 */
function assignLayers(
  vertices: readonly string[],
  edges: readonly (readonly [string, string])[],
  backEdges: ReadonlySet<string>,
): Map<string, number> {
  const successors = new Map<string, string[]>(vertices.map((vertex) => [vertex, []]));
  const layer = new Map<string, number>(vertices.map((vertex) => [vertex, 0]));
  const indegree = new Map<string, number>(vertices.map((vertex) => [vertex, 0]));
  for (const [source, target] of edges) {
    if (backEdges.has(edgeKey(source, target))) {
      continue;
    }
    successors.get(source)?.push(target);
    indegree.set(target, (indegree.get(target) ?? 0) + 1);
  }
  const ready = vertices.filter((vertex) => (indegree.get(vertex) ?? 0) === 0);
  while (ready.length > 0) {
    const vertex = ready.shift();
    if (vertex === undefined) {
      break;
    }
    const vertexLayer = layer.get(vertex) ?? 0;
    for (const target of successors.get(vertex) ?? []) {
      layer.set(target, Math.max(layer.get(target) ?? 0, vertexLayer + 1));
      const remaining = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, remaining);
      if (remaining === 0) {
        ready.push(target);
      }
    }
    ready.sort(compareUtf16CodeUnits);
  }
  return layer;
}

/** 层内重心法排序：交替按前驱/后继平均位置重排，平局按现有顺序，保持确定性。 */
function reorderLayers(
  layers: Map<number, string[]>,
  predecessors: ReadonlyMap<string, readonly string[]>,
  successors: ReadonlyMap<string, readonly string[]>,
  rounds: number,
): void {
  const keys = [...layers.keys()].sort((left, right) => left - right);
  for (let round = 0; round < rounds; round += 1) {
    const downward = round % 2 === 0;
    const indexOf = new Map<string, number>();
    for (const key of keys) {
      (layers.get(key) ?? []).forEach((nodeId, index) => indexOf.set(nodeId, index));
    }
    const orderedKeys = downward ? keys : [...keys].reverse();
    for (const key of orderedKeys) {
      if ((downward && key === keys[0]) || (!downward && key === keys[keys.length - 1])) {
        continue;
      }
      const members = layers.get(key);
      if (members === undefined) {
        continue;
      }
      const neighborsOf = downward ? predecessors : successors;
      const ranked = members.map((nodeId, index) => {
        const neighbors = neighborsOf.get(nodeId) ?? [];
        const positions = neighbors.flatMap((neighbor) => {
          const position = indexOf.get(neighbor);
          return position === undefined ? [] : [position];
        });
        const barycenter = positions.length === 0
          ? index
          : positions.reduce((sum, position) => sum + position, 0) / positions.length;
        return { nodeId, index, barycenter };
      });
      ranked.sort((left, right) => left.barycenter - right.barycenter || left.index - right.index);
      const next = ranked.map((entry) => entry.nodeId);
      layers.set(key, next);
      next.forEach((nodeId, index) => indexOf.set(nodeId, index));
    }
  }
}

/**
 * 计算一张图的自动布局：最长路径分层 + 重心法排序 + 逐组坐标打包。
 * 输出按 10px 网格取整（对齐画布 snapGrid），同一输入总是产生同一结果。
 * 连向输入接口的节点天然落在首列；连向输出接口的节点被拉到最深层；
 * 完全无边的节点收进末尾独立列。
 */
export function computeGraphAutoLayout(
  graph: GraphDefinition,
  registry?: GraphCatalogRegistry,
  direction: GraphAutoLayoutDirection = "LR",
): ReadonlyMap<string, GraphPosition> {
  const positions = new Map<string, GraphPosition>();
  const nodes = [...graph.nodes].sort((left, right) => compareUtf16CodeUnits(left.id, right.id));
  if (nodes.length === 0) {
    return positions;
  }

  const nodeIds = new Set(nodes.map((node) => node.id));
  const nodeEdges: Array<[string, string]> = [];
  const inputAnchored = new Set<string>();
  const outputAnchored = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.source.kind === "node" && edge.target.kind === "node") {
      if (nodeIds.has(edge.source.nodeId) && nodeIds.has(edge.target.nodeId)) {
        nodeEdges.push([edge.source.nodeId, edge.target.nodeId]);
      }
    } else if (edge.source.kind === "interface" && edge.target.kind === "node" && nodeIds.has(edge.target.nodeId)) {
      inputAnchored.add(edge.target.nodeId);
    } else if (edge.source.kind === "node" && edge.target.kind === "interface" && nodeIds.has(edge.source.nodeId)) {
      outputAnchored.add(edge.source.nodeId);
    }
  }
  nodeEdges.sort((left, right) => compareUtf16CodeUnits(edgeKey(left[0], left[1]), edgeKey(right[0], right[1])));

  const connected = new Set<string>(nodeEdges.flatMap(([source, target]) => [source, target]));
  inputAnchored.forEach((nodeId) => connected.add(nodeId));
  outputAnchored.forEach((nodeId) => connected.add(nodeId));
  const layoutNodes = nodes.filter((node) => connected.has(node.id));
  const orphanNodes = nodes.filter((node) => !connected.has(node.id));

  const groups: string[][] = [];
  if (layoutNodes.length > 0) {
    const vertices = layoutNodes.map((node) => node.id);
    const adjacency = new Map<string, string[]>(vertices.map((vertex) => [vertex, []]));
    for (const [source, target] of nodeEdges) {
      adjacency.get(source)?.push(target);
    }
    adjacency.forEach((targets) => targets.sort(compareUtf16CodeUnits));
    const backEdges = findBackEdges(vertices, adjacency);

    const predecessors = new Map<string, string[]>(vertices.map((vertex) => [vertex, []]));
    const successors = new Map<string, string[]>(vertices.map((vertex) => [vertex, []]));
    for (const [source, target] of nodeEdges) {
      if (backEdges.has(edgeKey(source, target))) {
        continue;
      }
      predecessors.get(target)?.push(source);
      successors.get(source)?.push(target);
    }
    const layerOf = assignLayers(vertices, nodeEdges, backEdges);

    // 输出接口锚点：连向输出接口的节点抬升到"下游闭包之外的最深层"，
    // 再沿拓扑序单遍松弛，让其后继级联下移；全部节点都在闭包内时不抬升。
    if (outputAnchored.size > 0) {
      const downstream = new Set<string>();
      const pending = [...outputAnchored];
      while (pending.length > 0) {
        const nodeId = pending.pop();
        if (nodeId === undefined || downstream.has(nodeId)) {
          continue;
        }
        downstream.add(nodeId);
        for (const target of successors.get(nodeId) ?? []) {
          pending.push(target);
        }
      }
      let boundary = -1;
      for (const nodeId of vertices) {
        if (!downstream.has(nodeId)) {
          boundary = Math.max(boundary, layerOf.get(nodeId) ?? 0);
        }
      }
      if (boundary >= 0) {
        for (const nodeId of outputAnchored) {
          layerOf.set(nodeId, Math.max(layerOf.get(nodeId) ?? 0, boundary));
        }
        const indegree = new Map<string, number>(vertices.map((vertex) => [vertex, 0]));
        for (const [source, target] of nodeEdges) {
          if (!backEdges.has(edgeKey(source, target))) {
            indegree.set(target, (indegree.get(target) ?? 0) + 1);
          }
        }
        const queue = vertices.filter((vertex) => (indegree.get(vertex) ?? 0) === 0);
        while (queue.length > 0) {
          const vertex = queue.shift();
          if (vertex === undefined) {
            break;
          }
          for (const target of successors.get(vertex) ?? []) {
            layerOf.set(target, Math.max(layerOf.get(target) ?? 0, (layerOf.get(vertex) ?? 0) + 1));
            const remaining = (indegree.get(target) ?? 0) - 1;
            indegree.set(target, remaining);
            if (remaining === 0) {
              queue.push(target);
            }
          }
          queue.sort(compareUtf16CodeUnits);
        }
      }
    }

    const layers = new Map<number, string[]>();
    for (const node of layoutNodes) {
      const layer = layerOf.get(node.id) ?? 0;
      const members = layers.get(layer);
      if (members === undefined) {
        layers.set(layer, [node.id]);
      } else {
        members.push(node.id);
      }
    }
    for (const members of layers.values()) {
      members.sort(compareUtf16CodeUnits);
    }
    reorderLayers(layers, predecessors, successors, 4);
    for (const layer of [...layers.keys()].sort((left, right) => left - right)) {
      groups.push(layers.get(layer) ?? []);
    }
  }
  if (orphanNodes.length > 0) {
    if (groups.length > 0) {
      groups.push([]);
    }
    groups.push(orphanNodes.map((node) => node.id));
  }

  const sizes = new Map<string, EstimatedSize>(nodes.map((node) => [node.id, estimateNodeSize(node, registry)]));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const gridRound = (value: number): number => Math.round(value / LAYOUT_GRID) * LAYOUT_GRID;

  if (direction === "LR") {
    // 主轴为 X（层列），层内沿 Y 堆叠并整体垂直居中。
    const groupTotals = groups.map((members) =>
      members.reduce((sum, nodeId) => sum + (sizes.get(nodeId)?.height ?? NODE_MIN_HEIGHT) + NODE_GAP, -NODE_GAP));
    const maxGroupTotal = Math.max(0, ...groupTotals);
    let xCursor = LAYOUT_MARGIN;
    groups.forEach((members, groupIndex) => {
      const groupTotal = groupTotals[groupIndex] ?? 0;
      let yCursor = LAYOUT_MARGIN + (maxGroupTotal - groupTotal) / 2;
      for (const nodeId of members) {
        const size = sizes.get(nodeId);
        if (size !== undefined) {
          positions.set(nodeId, { x: gridRound(xCursor), y: gridRound(yCursor) });
          yCursor += size.height + NODE_GAP;
        }
      }
      if (members.length > 0) {
        xCursor += NODE_WIDTH + RANK_SPACING;
      } else {
        // 空组是孤立节点区与主图之间的额外间距列。
        xCursor += RANK_SPACING;
      }
    });
  } else {
    // 主轴为 Y（层行），行内沿 X 堆叠并整体水平居中。
    const groupHeights = groups.map((members) =>
      Math.max(0, ...members.map((nodeId) => sizes.get(nodeId)?.height ?? NODE_MIN_HEIGHT)));
    const groupTotals = groups.map((members) =>
      members.length === 0 ? 0 : members.length * NODE_WIDTH + (members.length - 1) * NODE_GAP);
    const maxGroupTotal = Math.max(0, ...groupTotals);
    let yCursor = LAYOUT_MARGIN;
    groups.forEach((members, groupIndex) => {
      const groupTotal = groupTotals[groupIndex] ?? 0;
      let xCursor = LAYOUT_MARGIN + (maxGroupTotal - groupTotal) / 2;
      for (const nodeId of members) {
        if (nodeById.has(nodeId)) {
          positions.set(nodeId, { x: gridRound(xCursor), y: gridRound(yCursor) });
          xCursor += NODE_WIDTH + NODE_GAP;
        }
      }
      yCursor += (groupHeights[groupIndex] ?? 0) + RANK_SPACING;
    });
  }

  return positions;
}
