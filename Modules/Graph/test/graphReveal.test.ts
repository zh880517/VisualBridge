import assert from "node:assert/strict";
import test from "node:test";
import {
  GRAPH_INTERFACE_INPUT_NODE_ID,
  GRAPH_INTERFACE_OUTPUT_NODE_ID,
  GraphRevealMailbox,
  planGraphElementReveal,
  readGraphRevealTarget,
  type GraphRevealDocument,
} from "../src/graphReveal";

const document: GraphRevealDocument = {
  graphs: [
    {
      id: "root",
      interfacePorts: [],
      nodes: [{ id: "call", dynamicPorts: [] }],
    },
    {
      id: "child",
      interfacePorts: [
        { id: "input.value", direction: "input" },
        { id: "output.value", direction: "output" },
      ],
      nodes: [{ id: "step", dynamicPorts: [{ id: "branch.success" }] }],
    },
  ],
};

test("Graph reveal target parsing requires complete element scope", () => {
  assert.deepEqual(readGraphRevealTarget({
    elementKind: "dynamicPort",
    elementId: "branch.success",
    graphId: "child",
    nodeId: "step",
    portId: "branch.success",
    projectId: "sample",
    path: "Graph/Main.vbgraph",
  }), {
    elementKind: "dynamicPort",
    elementId: "branch.success",
    graphId: "child",
    nodeId: "step",
    portId: "branch.success",
  });
  assert.equal(readGraphRevealTarget({ elementKind: "node", elementId: "step", graphId: "child" }), undefined);
  assert.equal(readGraphRevealTarget({
    elementKind: "interfacePort",
    elementId: "input.value",
    graphId: "child",
    nodeId: "step",
    portId: "input.value",
  }), undefined);
});

test("Graph reveal plans select and focus Graph elements without changing the document", () => {
  assert.deepEqual(planGraphElementReveal(document, {
    elementKind: "graph",
    elementId: "child",
    graphId: "child",
  }), {
    success: true,
    plan: { elementKind: "graph", elementId: "child", graphId: "child" },
  });
  assert.deepEqual(planGraphElementReveal(document, {
    elementKind: "node",
    elementId: "step",
    graphId: "child",
    nodeId: "step",
  }), {
    success: true,
    plan: {
      elementKind: "node",
      elementId: "step",
      graphId: "child",
      nodeId: "step",
      canvasNodeId: "step",
      selectedNodeId: "step",
    },
  });
  assert.deepEqual(planGraphElementReveal(document, {
    elementKind: "interfacePort",
    elementId: "input.value",
    graphId: "child",
    portId: "input.value",
  }), {
    success: true,
    plan: {
      elementKind: "interfacePort",
      elementId: "input.value",
      graphId: "child",
      portId: "input.value",
      canvasNodeId: GRAPH_INTERFACE_INPUT_NODE_ID,
    },
  });
  assert.deepEqual(planGraphElementReveal(document, {
    elementKind: "interfacePort",
    elementId: "output.value",
    graphId: "child",
    portId: "output.value",
  }), {
    success: true,
    plan: {
      elementKind: "interfacePort",
      elementId: "output.value",
      graphId: "child",
      portId: "output.value",
      canvasNodeId: GRAPH_INTERFACE_OUTPUT_NODE_ID,
    },
  });
  assert.deepEqual(planGraphElementReveal(document, {
    elementKind: "dynamicPort",
    elementId: "branch.success",
    graphId: "child",
    nodeId: "step",
    portId: "branch.success",
  }), {
    success: true,
    plan: {
      elementKind: "dynamicPort",
      elementId: "branch.success",
      graphId: "child",
      nodeId: "step",
      portId: "branch.success",
      canvasNodeId: "step",
      selectedNodeId: "step",
    },
  });
});

test("Graph reveal planning rejects stale owner scope instead of guessing", () => {
  assert.deepEqual(planGraphElementReveal(document, {
    elementKind: "node",
    elementId: "step",
    graphId: "root",
    nodeId: "step",
  }), {
    success: false,
    code: "graph.reveal.missingNode",
    message: "节点 'step' 不在 Graph 'root' 中。",
  });
  assert.deepEqual(planGraphElementReveal(document, {
    elementKind: "dynamicPort",
    elementId: "branch.success",
    graphId: "child",
    nodeId: "call",
    portId: "branch.success",
  }), {
    success: false,
    code: "graph.reveal.missingNode",
    message: "动态端口所属节点 'call' 不在 Graph 'child' 中。",
  });
});

test("Graph reveal mailbox retains only the latest request until the active Webview acknowledges it", () => {
  const mailbox = new GraphRevealMailbox();
  const first = mailbox.enqueue({
    elementKind: "graph",
    elementId: "root",
    graphId: "root",
  });
  assert.equal(deliveryRequestId(mailbox), undefined);

  mailbox.markReady();
  assert.equal(deliveryRequestId(mailbox), first.requestId);
  mailbox.markUnavailable();
  assert.equal(deliveryRequestId(mailbox), undefined);
  mailbox.markReady();
  assert.equal(deliveryRequestId(mailbox), first.requestId);

  const second = mailbox.enqueue({
    elementKind: "node",
    elementId: "step",
    graphId: "child",
    nodeId: "step",
  });
  assert.notEqual(second.requestId, first.requestId);
  assert.equal(deliveryRequestId(mailbox), second.requestId);
  assert.equal(mailbox.acknowledge(first.requestId), false);
  assert.equal(deliveryRequestId(mailbox), second.requestId);
  assert.equal(mailbox.acknowledge(second.requestId), true);
  assert.equal(deliveryRequestId(mailbox), undefined);
});

function deliveryRequestId(mailbox: GraphRevealMailbox): string | undefined {
  return mailbox.deliverable?.requestId;
}
