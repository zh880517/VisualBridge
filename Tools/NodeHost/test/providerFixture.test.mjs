import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import readline from "node:readline";
import test from "node:test";
import {
  createProviderFixture,
  providerArgumentSentinel,
  readProviderEvents,
} from "./providerFixture.mjs";

test("sample Project Provider exposes deterministic healthy reference and validator results", async () => {
  const fixture = await createProviderFixture();
  const project = JSON.parse(await readFile(fixture.projectFile, "utf8"));
  const child = spawn(process.execPath, [fixture.entryPath, ...project.providers[0].args], {
    cwd: fixture.projectRoot,
    env: process.env,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const output = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const responses = [];
  output.on("line", (line) => responses.push(JSON.parse(line)));
  let nextId = 1;
  const request = async (method, params) => {
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const response = responses.find((entry) => entry.id === id);
      if (response !== undefined) return response.result;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Provider fixture did not respond to '${method}'.`);
  };

  try {
    assert.deepEqual(await request("initialize", {
      protocolVersion: 1,
      providerId: "sample.provider",
      project: { projectId: "visualbridge.provider-semantics", projectHash: "0".repeat(64) },
    }), { protocolVersion: 1 });
    assert.deepEqual(await request("capabilities", {}), {
      capabilities: {
        reference: { kinds: ["sample.asset"] },
        validator: { documentTypes: ["sample.provider.settings"] },
      },
    });
    const search = await request("reference/search", {
      kind: "sample.asset",
      target: { scope: "weapons" },
      query: "swo",
      limit: 10,
    });
    assert.equal(search.status, "ok");
    assert.deepEqual(search.candidates.map((candidate) => candidate.value), ["asset.sword"]);
    const resolved = await request("reference/resolve", {
      kind: "sample.asset",
      target: { scope: "weapons" },
      value: "asset.sword",
    });
    assert.equal(resolved.status, "resolved");
    assert.equal(resolved.candidates[0].title, "Sword");
    const diagnostics = await request("validator/diagnostics", {
      project: { projectId: "visualbridge.provider-semantics", projectHash: "0".repeat(64) },
      documents: [{
        documentTypeId: "sample.provider.settings",
        path: "Config/ProviderSettings.providerconfig",
        sourceHash: "1".repeat(64),
        content: {
          formatVersion: 1,
          documentId: "sample.provider.settings.default",
          properties: { assetId: "asset.sword", displayName: "Needs Provider Review" },
        },
      }],
    });
    assert.deepEqual(diagnostics.diagnostics.map((diagnostic) => diagnostic.code), [
      "sample.provider.displayNameReview",
    ]);
    await request("shutdown", {});
    if (child.exitCode === null) {
      await new Promise((resolve, reject) => {
        child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Provider exited with ${code}.`)));
      });
    }
    const events = await readProviderEvents(fixture.stateDirectory);
    assert.equal(events[0].type, "start");
    assert.equal(events[0].echoArgument, providerArgumentSentinel);
    assert.ok(events.some((event) => event.type === "request" && event.method === "reference/search"));
  } finally {
    if (child.exitCode === null) child.kill();
    await fixture.dispose();
  }
});
