import type { JsonValue, ReferenceCandidate, ReferenceProvider } from "@visualbridge/core";
import type { GraphDocument } from "./graphDocument";

export const GRAPH_ELEMENT_REFERENCE_KIND = "graph.element";
export type GraphElementKind = "graph" | "node" | "interfacePort" | "dynamicPort";

export interface GraphReferenceDocument {
  readonly projectId: string;
  readonly documentTypeId: string;
  readonly path: string;
  readonly document: GraphDocument;
}

interface GraphElementReferenceTarget {
  readonly documentTypeId: string;
  readonly elementKind: GraphElementKind;
}

export function createGraphElementReferenceProvider(
  loadDocuments: () => Promise<readonly GraphReferenceDocument[]>,
): ReferenceProvider {
  let documents: Promise<readonly GraphReferenceDocument[]> | undefined;
  const load = async (target: GraphElementReferenceTarget): Promise<readonly ReferenceCandidate[]> => (
    collectCandidates(await (documents ??= loadDocuments()), target)
  );
  return {
    kind: GRAPH_ELEMENT_REFERENCE_KIND,
    validateTarget: validateGraphElementReferenceTarget,
    async search(request) {
      const target = readTarget(request.target);
      if (target === undefined) return [];
      const terms = request.query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
      return (await load(target)).filter((candidate) => {
        const text = `${candidate.title}\n${candidate.description ?? ""}\n${candidate.value}`.toLocaleLowerCase();
        return terms.every((term) => text.includes(term));
      }).slice(0, request.limit);
    },
    async resolve(request) {
      const target = readTarget(request.target);
      if (target === undefined || typeof request.value !== "string") return [];
      return (await load(target)).filter((candidate) => candidate.value === request.value);
    },
  };
}

export function validateGraphElementReferenceTarget(
  value: Readonly<Record<string, JsonValue>>,
): string | undefined {
  return readTarget(value) === undefined
    ? "Graph element references require only stable documentTypeId and elementKind selectors."
    : undefined;
}

function collectCandidates(
  documents: readonly GraphReferenceDocument[],
  target: GraphElementReferenceTarget,
): readonly ReferenceCandidate[] {
  const candidates: ReferenceCandidate[] = [];
  documents.filter((source) => source.documentTypeId === target.documentTypeId).forEach((source) => {
    source.document.graphs.forEach((graph) => {
      if (target.elementKind === "graph") {
        candidates.push(candidate(source, target, graph.id, graph.title, { graphId: graph.id }));
      }
      graph.nodes.forEach((node) => {
        if (target.elementKind === "node") {
          candidates.push(candidate(source, target, node.id, node.title, { graphId: graph.id, nodeId: node.id }));
        }
        if (target.elementKind === "dynamicPort") {
          node.dynamicPorts.forEach((port) => candidates.push(candidate(
            source,
            target,
            port.id,
            `${node.title} / ${port.title}`,
            { graphId: graph.id, nodeId: node.id, portId: port.id },
          )));
        }
      });
      if (target.elementKind === "interfacePort") {
        graph.interfacePorts.forEach((port) => candidates.push(candidate(
          source,
          target,
          port.id,
          `${graph.title} / ${port.title}`,
          { graphId: graph.id, portId: port.id },
        )));
      }
    });
  });
  return candidates.sort((left, right) => candidateKey(left).localeCompare(candidateKey(right)));
}

function candidate(
  source: GraphReferenceDocument,
  target: GraphElementReferenceTarget,
  value: string,
  title: string,
  ids: { readonly graphId: string; readonly nodeId?: string; readonly portId?: string },
): ReferenceCandidate {
  return {
    kind: GRAPH_ELEMENT_REFERENCE_KIND,
    target: {
      documentTypeId: target.documentTypeId,
      elementKind: target.elementKind,
    },
    value,
    title,
    description: `${target.elementKind} / ${source.path}`,
    location: {
      projectId: source.projectId,
      documentTypeId: source.documentTypeId,
      path: source.path,
      documentId: source.document.documentId,
      elementKind: target.elementKind,
      elementId: value,
      graphId: ids.graphId,
      ...(ids.nodeId === undefined ? {} : { nodeId: ids.nodeId }),
      ...(ids.portId === undefined ? {} : { portId: ids.portId }),
    },
  };
}

function readTarget(value: Readonly<Record<string, JsonValue>>): GraphElementReferenceTarget | undefined {
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "documentTypeId" && key !== "elementKind")) return undefined;
  const { documentTypeId, elementKind } = value;
  return !isIdentifier(documentTypeId) || !isElementKind(elementKind)
    ? undefined
    : { documentTypeId, elementKind };
}

function isIdentifier(value: JsonValue | undefined): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function isElementKind(value: JsonValue | undefined): value is GraphElementKind {
  return value === "graph" || value === "node" || value === "interfacePort" || value === "dynamicPort";
}

function candidateKey(value: ReferenceCandidate): string {
  const location = value.location;
  return [value.title, String(value.value), location?.path ?? "", location?.graphId ?? "", location?.nodeId ?? "", location?.portId ?? ""].join("\u0000");
}
