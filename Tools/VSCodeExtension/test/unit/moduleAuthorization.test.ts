import assert from "node:assert/strict";
import test from "node:test";
import { moduleUnavailableAuthorization, resolveModuleAuthorization } from "../../src/modules/moduleRegistration";

test("authorization requires Workspace Trust and a local file project root", () => {
  assert.equal(resolveModuleAuthorization({ trusted: true, rootScheme: "file", skipModules: false }), "trusted");
  // Remote-SSH / devcontainer：工作区已信任，但 bundle 在远端，本地求值属于越权。
  assert.equal(resolveModuleAuthorization({ trusted: true, rootScheme: "vscode-remote", skipModules: false }), "untrusted");
  assert.equal(resolveModuleAuthorization({ trusted: false, rootScheme: "file", skipModules: false }), "untrusted");
  assert.equal(resolveModuleAuthorization({ trusted: false, rootScheme: "vscode-remote", skipModules: false }), "untrusted");
});

test("VB_SKIP_MODULES wins over trust so a trusted workspace can still skip modules", () => {
  assert.equal(resolveModuleAuthorization({ trusted: true, rootScheme: "file", skipModules: true }), "skipped");
  assert.equal(resolveModuleAuthorization({ trusted: false, rootScheme: "file", skipModules: true }), "skipped");
});

test("skip and untrusted never produce each other's message", () => {
  const skipped = moduleUnavailableAuthorization("skipped", "file");
  assert.equal(skipped.reason, "disabled");
  assert.match(skipped.message, /VB_SKIP_MODULES=1/u);
  assert.doesNotMatch(skipped.message, /信任工作区/u, "跳过模块不等于未授权，不能提示去信任工作区");

  const untrusted = moduleUnavailableAuthorization("untrusted", "file");
  assert.equal(untrusted.reason, "untrusted");
  assert.match(untrusted.message, /信任工作区/u);
  assert.doesNotMatch(untrusted.message, /VB_SKIP_MODULES/u);

  // Remote-SSH/devcontainer：已信任也要说清楚是 scheme 不对，而不是"需要信任工作区"。
  const remote = moduleUnavailableAuthorization("untrusted", "vscode-remote");
  assert.equal(remote.reason, "untrusted");
  assert.match(remote.message, /vscode-remote/u);
  assert.doesNotMatch(remote.message, /需要信任工作区/u);
});
