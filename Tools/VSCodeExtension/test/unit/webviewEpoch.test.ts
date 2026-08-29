import assert from "node:assert/strict";
import test from "node:test";
import { WebviewEpoch } from "../../src/editor/webviewEpoch";

test("Webview epoch rejects queued messages from a hidden context", () => {
  const epoch = new WebviewEpoch();
  const queuedReady = epoch.capture();

  epoch.invalidate();

  assert.equal(epoch.isCurrent(queuedReady), false);
  assert.equal(epoch.isCurrent(epoch.capture()), true);
});

test("Webview epoch rejects every earlier context after repeated recreation", () => {
  const epoch = new WebviewEpoch();
  const first = epoch.capture();
  epoch.invalidate();
  const second = epoch.capture();
  epoch.invalidate();
  const third = epoch.capture();

  assert.equal(epoch.isCurrent(first), false);
  assert.equal(epoch.isCurrent(second), false);
  assert.equal(epoch.isCurrent(third), true);
});

test("Webview epoch rejects an old token even when its message arrives after invalidation", () => {
  const epoch = new WebviewEpoch();
  epoch.begin("lifecycle-1");
  assert.equal(epoch.markReady("lifecycle-1"), true);
  assert.equal(epoch.acceptsMessage("lifecycle-1"), true);

  epoch.invalidate();
  epoch.begin("lifecycle-2");

  assert.equal(epoch.canAcceptReady("lifecycle-1"), false);
  assert.equal(epoch.acceptsMessage("lifecycle-1"), false);
  assert.equal(epoch.markReady("lifecycle-2"), true);
  assert.equal(epoch.acceptsMessage("lifecycle-2"), true);
});
