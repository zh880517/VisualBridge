import assert from "node:assert/strict";
import test from "node:test";
import {
  WEBVIEW_READY_ACK_TYPE,
  WEBVIEW_READY_TYPE,
  WEBVIEW_THEME_STYLE,
  WEBVIEW_THEME_TOKENS,
  applyWebviewTheme,
  connectWebviewBridge,
  createReadyProposal,
} from "../dist/webview/index.js";

test("completes the ready proposal / token echo handshake and wraps postMessage", async () => {
  const listeners = new Set();
  const source = {
    addEventListener(type, listener) {
      assert.equal(type, "message");
      listeners.add(listener);
    },
    removeEventListener(type, listener) {
      assert.equal(type, "message");
      listeners.delete(listener);
    },
  };
  const sent = [];
  const target = {
    postMessage(message) {
      sent.push(message);
    },
  };

  const bridge = connectWebviewBridge({ source, target, token: "token-1", readyTimeoutMs: 1_000 });
  assert.deepEqual(sent[0], { type: WEBVIEW_READY_TYPE, apiVersion: 1, token: "token-1" });

  const received = [];
  bridge.onMessage((message) => received.push(message));
  for (const listener of listeners) {
    listener({ data: { type: WEBVIEW_READY_ACK_TYPE, token: "token-1" } });
  }
  await bridge.ready;

  bridge.postMessage({ type: "example.hello" });
  assert.deepEqual(sent.at(-1), { type: "example.hello" });

  for (const listener of listeners) {
    listener({ data: { type: "example.document", value: 1 } });
  }
  assert.deepEqual(received, [{ type: "example.document", value: 1 }]);

  bridge.dispose();
  assert.equal(listeners.size, 0);
});

test("keeps ready tokens and --vb-* theme tokens stable", () => {
  const proposal = createReadyProposal("token-2", 7);
  assert.deepEqual(proposal, { type: WEBVIEW_READY_TYPE, apiVersion: 7, token: "token-2" });
  assert.equal(WEBVIEW_THEME_TOKENS.background, "--vb-background");
  assert.equal(WEBVIEW_THEME_TOKENS.accent, "--vb-accent");
  assert.match(WEBVIEW_THEME_STYLE, /--vb-background/u);

  const values = new Map();
  applyWebviewTheme(
    { background: "#000000", accent: "#ffffff" },
    {
      style: {
        setProperty(name, value) {
          values.set(name, value);
        },
      },
    },
  );
  assert.equal(values.get("--vb-background"), "#000000");
  assert.equal(values.get("--vb-accent"), "#ffffff");
});
