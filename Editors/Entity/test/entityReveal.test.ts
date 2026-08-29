import assert from "node:assert/strict";
import test from "node:test";
import {
  EntityRevealMailbox,
  planEntityComponentReveal,
  readEntityRevealTarget,
} from "../src/entityReveal";

const document = {
  documentId: "sample.player",
  components: [{ id: "health" }, { id: "move" }],
};

test("Entity reveal target parsing requires complete component owner scope", () => {
  assert.deepEqual(readEntityRevealTarget({
    projectId: "sample",
    path: "Config/Player.herojson",
    documentId: "sample.player",
    componentId: "health",
    elementKind: "component",
    elementId: "health",
  }), {
    documentId: "sample.player",
    componentId: "health",
    elementKind: "component",
    elementId: "health",
  });
  assert.equal(readEntityRevealTarget({
    documentId: "sample.player",
    componentId: "health",
    elementKind: "component",
    elementId: "move",
  }), undefined);
});

test("Entity reveal planning rejects stale documents and missing Components", () => {
  assert.deepEqual(planEntityComponentReveal(document, {
    documentId: "sample.player",
    componentId: "health",
    elementKind: "component",
    elementId: "health",
  }), { success: true, componentId: "health" });
  assert.equal(planEntityComponentReveal(document, {
    documentId: "sample.clone",
    componentId: "health",
    elementKind: "component",
    elementId: "health",
  }).success, false);
  assert.equal(planEntityComponentReveal(document, {
    documentId: "sample.player",
    componentId: "missing",
    elementKind: "component",
    elementId: "missing",
  }).success, false);
});

test("Entity reveal mailbox retains the latest request until acknowledged", () => {
  const mailbox = new EntityRevealMailbox();
  const first = mailbox.enqueue({
    documentId: "sample.player",
    componentId: "health",
    elementKind: "component",
    elementId: "health",
  });
  assert.equal(deliveryRequestId(mailbox), undefined);
  mailbox.markReady();
  assert.equal(deliveryRequestId(mailbox), first.requestId);
  const second = mailbox.enqueue({
    documentId: "sample.player",
    componentId: "move",
    elementKind: "component",
    elementId: "move",
  });
  assert.equal(mailbox.acknowledge(first.requestId), false);
  assert.equal(deliveryRequestId(mailbox), second.requestId);
  mailbox.markUnavailable();
  assert.equal(deliveryRequestId(mailbox), undefined);
  mailbox.markReady();
  assert.equal(mailbox.acknowledge(second.requestId), true);
  assert.equal(deliveryRequestId(mailbox), undefined);
});

function deliveryRequestId(mailbox: EntityRevealMailbox): string | undefined {
  return mailbox.deliverable?.requestId;
}
