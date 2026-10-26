import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  BridgeDiscoveryError,
  enumerateDiscoveryRecords,
  probeDiscoveryRecord,
  requireDiscoveryEndpoint,
  touchDiscoveryRecord,
  writeDiscoveryRecordAtomically,
} from "../../src/bridge/bridgeDiscovery";
import type { BridgeDiscoveryRecord } from "../../src/bridge/bridgeProtocol";

const TOKEN = "a".repeat(48);
const WINDOW_ID = "1b3121ab-2646-4e0f-a789-e970d4fbca8f";

function record(overrides: Partial<BridgeDiscoveryRecord> = {}): BridgeDiscoveryRecord {
  return {
    formatVersion: 2,
    protocolVersion: 4,
    role: "vscode",
    tcpPort: 28301,
    token: TOKEN,
    pid: process.pid,
    generation: 1,
    windowId: WINDOW_ID,
    projectRoots: ["D:/Authoring"],
    ...overrides,
  };
}

async function withTempDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "visualbridge-discovery-test-"));
  try {
    await run(directory);
  } finally {
    // Windows 上 rename 后的句柄可能短暂占用目录；rm 自带重试。
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

test("publishes the discovery record v2 atomically and leaves no temporary file", async () => {
  await withTempDirectory(async (directory) => {
    const recordPath = path.join(directory, `${WINDOW_ID}.json`);
    await writeDiscoveryRecordAtomically(recordPath, record());

    const entries = await fs.readdir(directory);
    assert.deepEqual(entries, [`${WINDOW_ID}.json`]);
    const parsed = JSON.parse(await fs.readFile(recordPath, "utf8"));
    assert.equal(parsed.formatVersion, 2);
    assert.equal(parsed.protocolVersion, 4);
    assert.equal(parsed.role, "vscode");
    assert.equal("capabilities" in parsed, false);
    assert.equal("startedAt" in parsed, false);

    // 覆盖写仍走临时文件：正式记录始终是完整 JSON。
    await writeDiscoveryRecordAtomically(recordPath, record({ generation: 2 }));
    assert.equal(JSON.parse(await fs.readFile(recordPath, "utf8")).generation, 2);
    assert.deepEqual(await fs.readdir(directory), [`${WINDOW_ID}.json`]);
  });
});

test("concurrent atomic writes never expose a half-written record", async () => {
  await withTempDirectory(async (directory) => {
    const recordPath = path.join(directory, `${WINDOW_ID}.json`);
    await Promise.all(Array.from({ length: 16 }, (_, index) => writeDiscoveryRecordAtomically(
      recordPath,
      record({ generation: index + 1 }),
    )));
    const text = await fs.readFile(recordPath, "utf8");
    const parsed = JSON.parse(text);
    assert.equal(parsed.formatVersion, 2);
    assert.ok(parsed.generation >= 1 && parsed.generation <= 16);
    assert.equal((await fs.readdir(directory)).some((entry) => entry.endsWith(".tmp")), false);
  });
});

test("heartbeat touches only the mtime and keeps the record content", async () => {
  await withTempDirectory(async (directory) => {
    const recordPath = path.join(directory, `${WINDOW_ID}.json`);
    await writeDiscoveryRecordAtomically(recordPath, record());
    const before = await fs.readFile(recordPath, "utf8");
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(recordPath, old, old);
    await touchDiscoveryRecord(recordPath);
    assert.equal(await fs.readFile(recordPath, "utf8"), before);
    const probe = await probeDiscoveryRecord(recordPath);
    assert.equal(probe.status, "live");
    assert.ok(probe.status === "live" && probe.heartbeatAgeMs < 5000);
  });
});

test("stale heartbeat and dead publisher become noEndpoint instead of a connection target", async () => {
  await withTempDirectory(async (directory) => {
    const recordPath = path.join(directory, `${WINDOW_ID}.json`);
    await writeDiscoveryRecordAtomically(recordPath, record());
    const old = new Date(Date.now() - 6000);
    await fs.utimes(recordPath, old, old);

    const stale = await probeDiscoveryRecord(recordPath);
    assert.equal(stale.status, "stale");
    assert.equal(stale.status === "stale" ? stale.code : undefined, "runtime.staleRecord");
    assert.deepEqual(await enumerateDiscoveryRecords(directory), []);
    await assert.rejects(
      () => requireDiscoveryEndpoint(directory),
      (errorValue: unknown) => errorValue instanceof BridgeDiscoveryError && errorValue.code === "runtime.noEndpoint",
    );

    // 先把心跳刷新，确保死 pid 判定而不是心跳超时先命中。
    await touchDiscoveryRecord(recordPath);
    const dead = await probeDiscoveryRecord(recordPath, { isProcessAlive: () => false });
    assert.equal(dead.status, "stale");
    assert.equal(dead.status === "stale" ? dead.code : undefined, "runtime.stalePid");
  });
});

test("formatVersion 1 records are ignored as if absent", async () => {
  await withTempDirectory(async (directory) => {
    const recordPath = path.join(directory, `${WINDOW_ID}.json`);
    await fs.writeFile(recordPath, `${JSON.stringify({
      ...record(),
      formatVersion: 1,
    })}\n`, "utf8");

    const probe = await probeDiscoveryRecord(recordPath);
    assert.equal(probe.status, "unsupported");
    assert.deepEqual(await enumerateDiscoveryRecords(directory), []);
  });
});

test("a half-written temporary file is never treated as a record", async () => {
  await withTempDirectory(async (directory) => {
    const recordPath = path.join(directory, `${WINDOW_ID}.json`);
    await writeDiscoveryRecordAtomically(recordPath, record());
    await fs.writeFile(`${recordPath}.1234.tmp`, "{ \"formatVersion\": 2, \"protocolVersion\"", "utf8");

    const live = await enumerateDiscoveryRecords(directory);
    assert.equal(live.length, 1);
    assert.equal(live[0]?.record.windowId, WINDOW_ID);
    const probe = await probeDiscoveryRecord(recordPath);
    assert.equal(probe.status, "live");
  });
});

test("only live records are enumerable and exactly one endpoint is required", async () => {
  await withTempDirectory(async (directory) => {
    await writeDiscoveryRecordAtomically(path.join(directory, `${WINDOW_ID}.json`), record());
    const live = await enumerateDiscoveryRecords(directory);
    assert.equal(live.length, 1);
    const endpoint = await requireDiscoveryEndpoint(directory);
    assert.equal(endpoint.record.generation, 1);

    await assert.rejects(
      () => requireDiscoveryEndpoint(directory, {}, (value) => value.role === "editor"),
      (errorValue: unknown) => errorValue instanceof BridgeDiscoveryError && errorValue.code === "runtime.noEndpoint",
    );
  });
});
