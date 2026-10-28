import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import path from "node:path";
import test from "node:test";
import { inflateSync } from "node:zlib";
import {
  BridgeChannel,
  BridgePayloadKind,
  FRAME_HEADER_BYTES,
  decodeFrameHeader,
  encodeFrame,
} from "../../src/bridge/framing";
import { BRIDGE_CONTRACT_SCHEMA_VERSION, BRIDGE_PROTOCOL_VERSION } from "../../src/bridge/bridgeProtocol";
import { DebugContractRegistry, type DebugContractSnapshot } from "../../src/bridge/debugContractRegistry";
import { DebugIngress } from "../../src/bridge/debugIngress";
import { DebugInstanceManager, debugInstanceKey } from "../../src/bridge/debugInstanceManager";
import {
  DebugSessionRecorder,
  type DebugRecorderSink,
  type DebugRecordingHeaderInput,
} from "../../src/bridge/debugRecorder";
import {
  DEBUG_RECORD_BLOCK_DATA,
  DEBUG_RECORD_BLOCK_FOOTER,
  DEBUG_RECORD_BLOCK_HEADER,
  DEBUG_RECORD_BLOCK_HEADER_BYTES,
  DEBUG_REPLAY_MAX_FILE_BYTES,
  DEBUG_REPLAY_MAX_RECORDS,
  DEBUG_REPLAY_MAX_WIRE_BYTES,
  DebugRecordingError,
  encodeRecordBlock,
  encodeRecordingFooter,
  encodeRecordingHeader,
  shouldRecordInboundFrame,
  type DebugRecordingFooter,
  type DebugRecordingHeader,
  type RecordedDebugContracts,
} from "../../src/bridge/debugRecordingFormat";
import { serializeRecordedContracts, snapshotFromRecordedContracts } from "../../src/bridge/debugRecordingContracts";
import { DebugReplaySession } from "../../src/bridge/debugReplaySession";
import {
  DebugRecordingReader,
  FileDebugSource,
  isSizeLimitRecording,
  preflightRecordingFile,
} from "../../src/bridge/debugRecordingSource";
import { DebugRecordingMonitor } from "../../src/debug/debugRecordingMonitor";

// .test-dist 比源码深一层：按编译输出深度解析仓库根，复用 TestData 的共享 fixture。
const repositoryRoot = path.resolve(__dirname, "../../../../..");
const unityProject = path.join(repositoryRoot, "TestData", "DebugContracts", "UnityProject");

/** 固定时钟：`startedAt` / `endedAt` 都用它，测试不依赖真实时间。 */
const FIXED_CLOCK = Date.UTC(2026, 9, 29, 1, 2, 3);

async function primaryContracts(): Promise<DebugContractSnapshot> {
  const set = await new DebugContractRegistry().load({ projectRoots: [unityProject] });
  const snapshot = set.snapshots[0];
  assert.ok(snapshot !== undefined);
  return snapshot;
}

async function withTempDir<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "visualbridge-f5-"));
  try {
    return await run(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

const CREATE_JSON = JSON.stringify({
  type: "debugCreate",
  category: "graph",
  instance: "hero",
  instanceSlot: 1,
  resName: "R",
  debugInfo: "",
});

const FRAME_JSON = JSON.stringify({ type: "debugFrame", frame: 7 });

/** `NodeStarted`：tag 1 int 5、tag 3 enum(Sample.Graph.Mode, short) 1。 */
const EVENT_JSON = JSON.stringify({
  type: "debug",
  category: "graph",
  instance: "hero",
  iface: "IGraphDebuger",
  method: "NodeStarted",
  args: [
    { tag: 1, name: "nodeId", type: "int", value: 5 },
    { tag: 3, name: "mode", type: "enum", value: 1 },
  ],
});

/** 同一记录的二进制形态：`000a 0001` methodId/slot + 参数区（A.4）。 */
const EVENT_BINARY = Buffer.from("000a0001" + "00010200000005" + "0003070001", "hex");

let sequence = 0;

interface TestFrame {
  readonly channel: number;
  readonly payloadKind: BridgePayloadKind;
  readonly payload: Buffer;
}

function jsonFrame(text: string, channel: BridgeChannel = BridgeChannel.Debug): TestFrame {
  return {
    channel,
    payloadKind: BridgePayloadKind.Json,
    payload: Buffer.from(text, "utf8"),
  };
}

function binaryFrame(payload: Buffer): TestFrame {
  return {
    channel: BridgeChannel.Debug,
    payloadKind: BridgePayloadKind.Binary,
    payload,
  };
}

function controlJson(value: Record<string, unknown>): TestFrame {
  return jsonFrame(JSON.stringify(value), BridgeChannel.Control);
}

function frameBytes(frame: TestFrame): Buffer {
  return encodeFrame(frame.channel as BridgeChannel, frame.payloadKind, frame.payload);
}

function headerInput(contracts: RecordedDebugContracts | null = null): DebugRecordingHeaderInput {
  return {
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    contractSchemaVersion: BRIDGE_CONTRACT_SCHEMA_VERSION,
    contractHash: contracts?.contractHash ?? "",
    sessionId: "endpoint#boot",
    endpointId: "endpoint",
    bootId: "boot",
    connectType: "editor",
    contracts,
  };
}

function rawHeader(overrides: Partial<DebugRecordingHeader> = {}): DebugRecordingHeader {
  return {
    recordVersion: 1,
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    contractSchemaVersion: BRIDGE_CONTRACT_SCHEMA_VERSION,
    contractHash: "0123456789abcdef",
    sessionId: "endpoint#boot",
    endpointId: "endpoint",
    bootId: "boot",
    connectType: "editor",
    startedAt: new Date(FIXED_CLOCK).toISOString(),
    contracts: null,
    ...overrides,
  };
}

function rawFooter(overrides: Partial<DebugRecordingFooter> = {}): DebugRecordingFooter {
  return {
    records: 0,
    wireBytes: 0,
    droppedRecords: 0,
    droppedBytes: 0,
    endedAt: new Date(FIXED_CLOCK + 1000).toISOString(),
    endedReason: "disconnect",
    ...overrides,
  };
}

async function startRecorder(
  directory: string,
  options: {
    readonly contracts?: RecordedDebugContracts | null;
    readonly maxFileBytes?: number;
    readonly maxRecords?: number;
    readonly maxWireBytes?: number;
    readonly blockBytes?: number;
    readonly queueBlocks?: number;
    readonly openSink?: () => Promise<DebugRecorderSink>;
    readonly now?: () => number;
    readonly onEncode?: (uncompressedBytes: number) => void;
  } = {},
): Promise<{ recorder: DebugSessionRecorder; filePath: string }> {
  sequence += 1;
  const filePath = path.join(directory, `session-${sequence}.vbdrec`);
  const recorder = new DebugSessionRecorder({
    filePath,
    header: headerInput(options.contracts ?? null),
    now: options.now ?? (() => FIXED_CLOCK),
    ...(options.maxFileBytes === undefined ? {} : { maxFileBytes: options.maxFileBytes }),
    ...(options.maxRecords === undefined ? {} : { maxRecords: options.maxRecords }),
    ...(options.maxWireBytes === undefined ? {} : { maxWireBytes: options.maxWireBytes }),
    ...(options.blockBytes === undefined ? {} : { blockBytes: options.blockBytes }),
    ...(options.queueBlocks === undefined ? {} : { queueBlocks: options.queueBlocks }),
    ...(options.openSink === undefined ? {} : { openSink: options.openSink }),
    ...(options.onEncode === undefined ? {} : { onEncode: options.onEncode }),
  });
  await recorder.start();
  return { recorder, filePath };
}

function ingestFrame(
  ingress: DebugIngress,
  manager: DebugInstanceManager,
  frame: TestFrame,
  contracts?: DebugContractSnapshot,
): void {
  for (const envelope of ingress.acceptFrame(frame)) {
    manager.ingest(envelope, contracts);
  }
}

/** 按 6 字节帧头切开一段数据块（测试侧独立实现，避免复用被测的接收门）。 */
function splitFrames(bytes: Buffer): TestFrame[] {
  const frames: TestFrame[] = [];
  let offset = 0;
  while (offset + 6 <= bytes.length) {
    const header = decodeFrameHeader(bytes.subarray(offset, offset + 6));
    const end = offset + 6 + header.payloadLength;
    if (end > bytes.length) {
      break;
    }

    frames.push({
      channel: header.channel,
      payloadKind: header.payloadKind,
      payload: bytes.subarray(offset + 6, end),
    });
    offset = end;
  }

  return frames;
}

/** 解一个完整块（跳过 9 字节块头）；测试侧不复用被测实现。 */
function zlibInflate(block: Buffer): Buffer {
  return inflateSync(block.subarray(DEBUG_RECORD_BLOCK_HEADER_BYTES));
}

async function countRecordedFrames(filePath: string): Promise<number> {
  const reader = await DebugRecordingReader.open(filePath);
  try {
    let frames = 0;
    for await (const block of reader.dataBlocks()) {
      frames += splitFrames(block).length;
    }

    return frames;
  } finally {
    await reader.close();
  }
}

/** 文件的块边界（offset + 压缩长度），用来精确构造"块中途截断"。 */
async function blockOffsets(filePath: string): Promise<{ offset: number; type: number; length: number }[]> {
  const bytes = await fs.readFile(filePath);
  const blocks: { offset: number; type: number; length: number }[] = [];
  let offset = 0;
  while (offset + DEBUG_RECORD_BLOCK_HEADER_BYTES <= bytes.length) {
    const type = bytes.readUInt8(offset);
    const length = bytes.readUInt32BE(offset + 1);
    blocks.push({ offset, type, length });
    offset += DEBUG_RECORD_BLOCK_HEADER_BYTES + length;
  }

  return blocks;
}

async function writeRawRecording(
  directory: string,
  header: DebugRecordingHeader,
  dataBlocks: readonly Buffer[],
  footer?: DebugRecordingFooter,
): Promise<string> {
  const parts: Buffer[] = [encodeRecordBlock(0, encodeRecordingHeader(header))];
  for (const block of dataBlocks) {
    parts.push(encodeRecordBlock(1, block));
  }

  if (footer !== undefined) {
    parts.push(encodeRecordBlock(2, encodeRecordingFooter(footer)));
  }

  sequence += 1;
  const filePath = path.join(directory, `raw-${sequence}.vbdrec`);
  await fs.writeFile(filePath, Buffer.concat(parts));
  return filePath;
}

function normalizeRecords(manager: DebugInstanceManager, key: string): unknown[] {
  const records = manager.storeFor(key)?.recordsFrom(0).records ?? [];
  return records.map((record) => ({
    kind: record.kind,
    category: record.category,
    interfaceId: record.interfaceId,
    instanceId: record.instanceId,
    method: record.method,
    frame: record.frame,
    wireBytes: record.wireBytes,
    contractState: record.contractState,
    args: [...record.args.entries()].map(([tag, arg]) => ({ tag, name: arg.name, type: arg.type, value: arg.value })),
    named: [...record.named.entries()].map(([name, arg]) => ({ name, value: arg.value })),
  }));
}

test("per-message recording table matches A.2 (channel 0 allowlist, channel 1 all data)", () => {
  // 通道 0：只有 open/reveal 是业务帧；其余握手/保活/错误/控制/应答都不录。
  const controlExpectations: Record<string, boolean> = {
    hello: false,
    welcome: false,
    error: false,
    ping: false,
    pong: false,
    open: true,
    reveal: true,
    response: false,
    debugSetEnabled: false,
    debugEnabled: false,
  };
  for (const [type, record] of Object.entries(controlExpectations)) {
    const decision = shouldRecordInboundFrame(BridgeChannel.Control, BridgePayloadKind.Json, Buffer.from(JSON.stringify({ type })));
    assert.equal(decision.record, record, `channel 0 '${type}'`);
    assert.equal(decision.messageType, type);
  }

  // 通道 1：全部是数据帧（JSON 与二进制同论）。
  for (const type of ["debugCreate", "debugFinish", "debugFrame", "debug", "debugResult", "request", "response", "dropped"]) {
    const decision = shouldRecordInboundFrame(BridgeChannel.Debug, BridgePayloadKind.Json, Buffer.from(JSON.stringify({ type })));
    assert.equal(decision.record, true, `channel 1 '${type}'`);
    assert.equal(decision.messageType, type);
  }

  for (const [name, methodId] of [["Create", 1], ["Finish", 2], ["debug", 10]] as const) {
    const payload = Buffer.from([(methodId >> 8) & 0xff, methodId & 0xff, 0, 1]);
    const decision = shouldRecordInboundFrame(BridgeChannel.Debug, BridgePayloadKind.Binary, payload);
    assert.equal(decision.record, true, `binary '${name}'`);
    assert.equal(decision.messageType, name);
  }

  assert.equal(
    shouldRecordInboundFrame(BridgeChannel.Control, BridgePayloadKind.Json, Buffer.from('{"type":"somethingElse"}')).record,
    false,
    "未知通道 0 类型不录",
  );
  assert.equal(
    shouldRecordInboundFrame(BridgeChannel.Control, BridgePayloadKind.Json, Buffer.from("not json")).record,
    false,
    "通道 0 非法 JSON 不录",
  );
});

test("container round-trips frames, header and footer", async () => {
  await withTempDir(async (directory) => {
    const { recorder, filePath } = await startRecorder(directory);
    const frames = [jsonFrame(CREATE_JSON), jsonFrame(FRAME_JSON), jsonFrame(EVENT_JSON), binaryFrame(EVENT_BINARY)];
    for (const frame of frames) {
      recorder.recordFrame(frame.channel, frame.payloadKind, frame.payload);
    }

    const footer = await recorder.stop();
    assert.equal(footer.endedReason, "disconnect");
    assert.equal(footer.records, frames.length);
    assert.equal(footer.droppedRecords, 0);
    assert.equal(footer.endedAt, new Date(FIXED_CLOCK).toISOString());

    const reader = await DebugRecordingReader.open(filePath);
    try {
      assert.equal(reader.header.recordVersion, 1);
      assert.equal(reader.header.startedAt, new Date(FIXED_CLOCK).toISOString());
      const blocks: Buffer[] = [];
      for await (const block of reader.dataBlocks()) {
        blocks.push(block);
      }

      const recordedFrames = blocks.flatMap((block) => splitFrames(block));
      assert.equal(recordedFrames.length, frames.length);
      for (const [index, frame] of recordedFrames.entries()) {
        const expected = frames[index]!;
        assert.equal(frame.channel, expected.channel);
        assert.equal(frame.payloadKind, expected.payloadKind);
        assert.deepEqual(frame.payload, expected.payload);
      }

      assert.deepEqual(reader.footer, footer);
      assert.equal(reader.counters.corruptedBlocks, 0);
      assert.equal(reader.counters.footerFound, true);
    } finally {
      await reader.close();
    }
  });
});

test("container round-trips multiple compressed blocks and incompressible payloads", async () => {
  await withTempDir(async (directory) => {
    const { recorder, filePath } = await startRecorder(directory, { blockBytes: 128 });
    const random = Buffer.alloc(512);
    for (let index = 0; index < random.length; index += 1) {
      random[index] = (index * 37 + 11) & 0xff;
    }

    recorder.recordFrame(BridgeChannel.Debug, BridgePayloadKind.Binary, random);
    for (let index = 0; index < 20; index += 1) {
      recorder.recordFrame(BridgeChannel.Debug, BridgePayloadKind.Json, Buffer.from(JSON.stringify({ type: "debugFrame", frame: index })));
    }

    const footer = await recorder.stop();
    const blocks = await blockOffsets(filePath);
    assert.ok(blocks.filter((block) => block.type === 1).length > 1, `multiple data blocks expected: ${JSON.stringify(blocks)}`);
    assert.equal(await countRecordedFrames(filePath), footer.records);
    assert.equal(footer.records, 21);
  });
});

test("truncated recording keeps the blocks that were already flushed", async () => {
  await withTempDir(async (directory) => {
    const { recorder, filePath } = await startRecorder(directory, { blockBytes: 64 });
    for (let index = 0; index < 12; index += 1) {
      recorder.recordFrame(BridgeChannel.Debug, BridgePayloadKind.Json, Buffer.from(JSON.stringify({ type: "debugFrame", frame: index })));
    }

    await recorder.stop();
    const blocks = await blockOffsets(filePath);
    const dataBlocks = blocks.filter((block) => block.type === 1);
    assert.ok(dataBlocks.length >= 2, `multiple data blocks expected: ${JSON.stringify(blocks)}`);
    // 在**最后一个数据块**的压缩载荷里截断：之前已 flush 的块必须完整可读。
    const lastData = dataBlocks.at(-1)!;
    const bytes = await fs.readFile(filePath);
    const cut = lastData.offset + DEBUG_RECORD_BLOCK_HEADER_BYTES + Math.max(1, Math.floor(lastData.length / 2));
    await fs.writeFile(filePath, bytes.subarray(0, cut));

    const source = await FileDebugSource.open(filePath);
    try {
      const result = await source.replay();
      const frames = await countRecordedFrames(filePath);
      assert.ok(frames > 0, "earlier flushed frames survive the truncation");
      assert.ok(frames < 12, "the truncated block is dropped");
      assert.equal(result.read.truncated, true);
      assert.equal(result.read.footerFound, false);
      assert.equal(result.footer, undefined);
    } finally {
      await source.close();
    }
  });
});

test("maxFileBytes stops the recording with sizeLimit and the file still opens", async () => {
  await withTempDir(async (directory) => {
    const { recorder, filePath } = await startRecorder(directory, { maxFileBytes: 700, blockBytes: 64 });
    for (let index = 0; index < 200; index += 1) {
      recorder.recordFrame(BridgeChannel.Debug, BridgePayloadKind.Json, Buffer.from(JSON.stringify({ type: "debugFrame", frame: index })));
    }

    const footer = await recorder.stop();
    assert.equal(footer.endedReason, "sizeLimit");
    assert.ok(footer.records < 200, `expected an early stop, recorded ${footer.records}`);
    assert.equal(isSizeLimitRecording(footer), true);

    const source = await FileDebugSource.open(filePath);
    try {
      const result = await source.replay();
      assert.equal(isSizeLimitRecording(result.footer), true, "the footer is readable, not a broken file");
      assert.equal(await countRecordedFrames(filePath), footer.records);
    } finally {
      await source.close();
    }
  });
});

test("a full queue drops new blocks without blocking the receiver (P0)", async () => {
  await withTempDir(async (directory) => {
    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let blockDataWrites = false;
    const writes: Buffer[] = [];
    const sink: DebugRecorderSink = {
      write: async (bytes) => {
        if (blockDataWrites && bytes[0] === DEBUG_RECORD_BLOCK_DATA) {
          await gate;
        }

        writes.push(bytes);
      },
      sync: async () => undefined,
      close: async () => undefined,
    };

    const { recorder } = await startRecorder(directory, {
      blockBytes: 8,
      queueBlocks: 1,
      openSink: async () => sink,
    });
    blockDataWrites = true;

    const total = 8;
    for (let index = 0; index < total; index += 1) {
      // `recordFrame` 是同步调用：队列满时只能返回（丢块），不可能等写盘。
      recorder.recordFrame(
        BridgeChannel.Debug,
        BridgePayloadKind.Json,
        Buffer.from(JSON.stringify({ type: "debugFrame", frame: index })),
      );
    }

    assert.ok(recorder.stats.droppedRecords > 0, `queue overflow must be counted: ${JSON.stringify(recorder.stats)}`);
    assert.equal(recorder.stats.queuedBlocks, 1, "one sealed block is waiting in the bounded queue");

    releaseGate?.();
    const footer = await recorder.stop();
    assert.ok(footer.droppedRecords > 0);
    assert.ok(footer.droppedBytes > 0);
    assert.equal(footer.records + footer.droppedRecords, total);
  });
});

test("file header round-trips every field including the contract snapshot", async () => {
  await withTempDir(async (directory) => {
    const snapshot = await primaryContracts();
    const contracts = serializeRecordedContracts(snapshot);
    assert.ok(contracts !== null);

    const { recorder, filePath } = await startRecorder(directory, { contracts });
    recorder.recordFrame(BridgeChannel.Debug, BridgePayloadKind.Json, Buffer.from(CREATE_JSON));
    await recorder.stop();

    const reader = await DebugRecordingReader.open(filePath);
    try {
      assert.deepEqual(reader.header, {
        recordVersion: 1,
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        contractSchemaVersion: BRIDGE_CONTRACT_SCHEMA_VERSION,
        contractHash: contracts.contractHash,
        sessionId: "endpoint#boot",
        endpointId: "endpoint",
        bootId: "boot",
        connectType: "editor",
        startedAt: new Date(FIXED_CLOCK).toISOString(),
        contracts,
      });
    } finally {
      await reader.close();
    }
  });
});

test("an unsupported recordVersion is rejected without migration", async () => {
  await withTempDir(async (directory) => {
    const filePath = await writeRawRecording(directory, rawHeader({ recordVersion: 2 }), [Buffer.from(CREATE_JSON)]);
    await assert.rejects(
      () => FileDebugSource.open(filePath),
      (errorValue: unknown) => errorValue instanceof DebugRecordingError && errorValue.code === "recording.unsupportedVersion",
    );
  });
});

test("replay produces the same DebugRecord sequence as the live ingress", async () => {
  await withTempDir(async (directory) => {
    const contracts = await primaryContracts();
    const frames = [
      jsonFrame(CREATE_JSON),
      jsonFrame(FRAME_JSON),
      jsonFrame(EVENT_JSON),
      binaryFrame(EVENT_BINARY),
    ];

    const liveManager = new DebugInstanceManager({ now: () => FIXED_CLOCK });
    const liveIngress = new DebugIngress({ contracts, assumeNoPendingRequests: true });
    const { recorder, filePath } = await startRecorder(directory, { contracts: serializeRecordedContracts(contracts) });
    for (const frame of frames) {
      ingestFrame(liveIngress, liveManager, frame, contracts);
      recorder.recordFrame(frame.channel, frame.payloadKind, frame.payload);
    }

    await recorder.stop();
    const source = await FileDebugSource.open(filePath);
    try {
      assert.deepEqual(source.welcome, {
        type: "welcome",
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        endpointId: "endpoint",
        sessionId: "endpoint#boot",
        resumed: false,
        connectType: "editor",
        generation: 0,
        bootId: "boot",
        contractHash: contracts.contractHash,
        payloads: ["json", "binary"],
        debugEnabled: true,
        startedAt: new Date(FIXED_CLOCK).toISOString(),
      });

      const result = await source.replay({ ingressOptions: { assumeNoPendingRequests: true } });
      const key = debugInstanceKey("graph", "hero");
      assert.deepEqual(normalizeRecords(result.manager, key), normalizeRecords(liveManager, key));
      assert.equal(result.manager.storeFor(key)?.recordCount, liveManager.storeFor(key)?.recordCount);
      assert.ok((result.manager.storeFor(key)?.recordCount ?? 0) >= 2, "both JSON and binary payloads were decoded");
    } finally {
      await source.close();
    }
  });
});

test("replay discards handshake and control frames found inside a recording", async () => {
  await withTempDir(async (directory) => {
    const contracts = serializeRecordedContracts(await primaryContracts());
    // 手工构造一个"不会由本写入器产生"的文件：数据块里混进 welcome/hello/debugEnabled/ping。
    const frames = [
      controlJson({ type: "welcome", protocolVersion: 4, endpointId: "old", sessionId: "old#boot", resumed: false, connectType: "editor", generation: 1, bootId: "old", contractHash: "", payloads: ["json"], debugEnabled: false, startedAt: "x" }),
      controlJson({ type: "hello", protocolVersion: 4, role: "editor", clientEndpointId: "unity", contractHash: "", payloads: ["json"] }),
      controlJson({ type: "debugEnabled", enabled: false }),
      controlJson({ type: "ping" }),
      jsonFrame(CREATE_JSON),
      jsonFrame(EVENT_JSON),
    ];
    const block = Buffer.concat(frames.map((frame) => frameBytes(frame)));
    const filePath = await writeRawRecording(directory, rawHeader({ contracts }), [block], rawFooter());

    const source = await FileDebugSource.open(filePath);
    try {
      const result = await source.replay();
      assert.equal(result.ingressCounters.controlFrames, 4, "handshake/keepalive/control frames are discarded");
      // 只有合成的 welcome（source.welcome），文件里的 welcome 不会改变会话/开关。
      assert.equal(source.welcome.debugEnabled, true);
      assert.equal(source.welcome.resumed, false);
      assert.equal(source.welcome.endpointId, "endpoint");
      const key = debugInstanceKey("graph", "hero");
      assert.equal(result.manager.storeFor(key)?.recordCount, 1, "the business record after the control frames is delivered");
    } finally {
      await source.close();
    }
  });
});

test("block CRC failures skip only the bad block (P0: separate from frame CRC)", async () => {
  await withTempDir(async (directory) => {
    const blockOne = encodeRecordBlock(DEBUG_RECORD_BLOCK_DATA, frameBytes(jsonFrame(CREATE_JSON)));
    // 篡改压缩载荷：块级 CRC/zlib 失败，但块头 length 仍然可信 ⇒ 可定位并跳过该块。
    blockOne.writeUInt8(blockOne.readUInt8(DEBUG_RECORD_BLOCK_HEADER_BYTES + 3) ^ 0xff, DEBUG_RECORD_BLOCK_HEADER_BYTES + 3);
    const blockTwo = encodeRecordBlock(
      DEBUG_RECORD_BLOCK_DATA,
      Buffer.concat([frameBytes(jsonFrame(CREATE_JSON)), frameBytes(jsonFrame(EVENT_JSON))]),
    );
    const headerBlock = encodeRecordBlock(0, encodeRecordingHeader(rawHeader()));
    const footerBlock = encodeRecordBlock(2, encodeRecordingFooter(rawFooter()));
    sequence += 1;
    const filePath = path.join(directory, `block-crc-${sequence}.vbdrec`);
    await fs.writeFile(filePath, Buffer.concat([headerBlock, blockOne, blockTwo, footerBlock]));

    const source = await FileDebugSource.open(filePath);
    try {
      const result = await source.replay();
      assert.equal(result.read.corruptedBlocks, 1);
      assert.equal(result.read.dataBlocks, 1);
      const key = debugInstanceKey("graph", "hero");
      assert.equal(result.manager.storeFor(key)?.recordCount, 1, "the next block is still decoded");
    } finally {
      await source.close();
    }
  });
});

test("frame CRC failures are counted and later blocks still replay (P0)", async () => {
  await withTempDir(async (directory) => {
    const eventPayload = Buffer.from(EVENT_JSON, "utf8");
    const bad = Buffer.from(encodeFrame(BridgeChannel.Debug, BridgePayloadKind.Json, eventPayload));
    // 破坏 6 字节帧头的 CRC 字段：帧内容长度仍然可读，但帧头 CRC 失败。
    bad.writeUInt8(bad.readUInt8(4) ^ 0xff, 4);
    const blockOne = Buffer.concat([
      frameBytes(jsonFrame(CREATE_JSON)),
      frameBytes(jsonFrame(EVENT_JSON)),
      bad,
      frameBytes(jsonFrame(EVENT_JSON)),
    ]);
    const blockTwo = Buffer.concat([
      frameBytes(jsonFrame(CREATE_JSON)),
      frameBytes(jsonFrame(EVENT_JSON)),
    ]);
    const filePath = await writeRawRecording(directory, rawHeader(), [blockOne, blockTwo], rawFooter());

    const source = await FileDebugSource.open(filePath);
    try {
      const result = await source.replay();
      assert.equal(result.ingressCounters.crcFailures, 1, "the broken frame is counted, not fatal");
      assert.equal(result.ingressCounters.truncatedFrames, 0);
      // 块内帧头 CRC 失败后长度不可信：当前块剩余帧丢弃，但**下一个块**照常解码。
      const key = debugInstanceKey("graph", "hero");
      const records = result.manager.storeFor(key)?.recordsFrom(0).records ?? [];
      assert.equal(records.length, 2, "first record + next block's record");
    } finally {
      await source.close();
    }
  });
});

test("contracts are snapshotted when recording starts, not when it stops (P0)", async () => {
  await withTempDir(async (directory) => {
    const snapshot = await primaryContracts();
    const contracts = serializeRecordedContracts(snapshot);
    assert.ok(contracts !== null);
    const originalHash = contracts.contractHash;

    const { recorder, filePath } = await startRecorder(directory, { contracts });
    // 模拟"录制中途契约注册表热更新"：naive 实现会在 stop() 时读当前注册表，于是文件头变成新版本。
    const mutated = contracts as unknown as { contractHash: string; methods: unknown[] };
    mutated.contractHash = "ffffffffffffffff";
    mutated.methods = [];
    recorder.recordFrame(BridgeChannel.Debug, BridgePayloadKind.Json, Buffer.from(CREATE_JSON));

    const footer = await recorder.stop();
    assert.equal(footer.records, 1);

    const reader = await DebugRecordingReader.open(filePath);
    try {
      assert.equal(reader.header.contracts?.contractHash, originalHash);
      assert.ok((reader.header.contracts?.methods.length ?? 0) > 0, "the start-time method table survives");
    } finally {
      await reader.close();
    }
  });
});

test("replay session is isolated from the live manager", async () => {
  await withTempDir(async (directory) => {
    const contracts = await primaryContracts();
    const frames = [jsonFrame(CREATE_JSON), jsonFrame(EVENT_JSON)];
    const live = new DebugInstanceManager({ now: () => FIXED_CLOCK });
    const liveIngress = new DebugIngress({ contracts });
    for (const frame of frames) {
      ingestFrame(liveIngress, live, frame, contracts);
    }

    const { recorder, filePath } = await startRecorder(directory, { contracts: serializeRecordedContracts(contracts) });
    for (const frame of frames) {
      recorder.recordFrame(frame.channel, frame.payloadKind, frame.payload);
    }

    await recorder.stop();
    const session = await DebugReplaySession.load(filePath);
    try {
      const key = debugInstanceKey("graph", "hero");
      assert.notEqual(session.manager, live, "replay owns a separate manager");
      assert.equal(session.manager.storeFor(key)?.recordCount, 1);
      assert.equal(live.storeFor(key)?.recordCount, 1);

      // 回看里清空/选择不得影响在线数据源。
      session.manager.clearInstance(key);
      assert.equal(session.manager.storeFor(key)?.recordCount, 0);
      assert.equal(live.storeFor(key)?.recordCount, 1, "the live manager is untouched");
      assert.equal(session.welcome.resumed, false);
    } finally {
      session.dispose();
    }
  });
});

test("recording is not affected by instance-memory eviction", async () => {
  await withTempDir(async (directory) => {
    const contracts = await primaryContracts();
    const { recorder, filePath } = await startRecorder(directory, { contracts: serializeRecordedContracts(contracts) });
    const manager = new DebugInstanceManager({
      now: () => FIXED_CLOCK,
      limits: { maxBytesPerInstance: 512, maxRecordsPerInstance: 3, maxInstances: 1 },
    });
    const ingress = new DebugIngress({
      contracts,
      recorder: { recordFrame: (channel, payloadKind, payload) => recorder.recordFrame(channel, payloadKind, payload) },
    });

    const frames = [jsonFrame(CREATE_JSON), jsonFrame(FRAME_JSON)];
    for (let index = 0; index < 20; index += 1) {
      frames.push(jsonFrame(EVENT_JSON));
    }

    for (const frame of frames) {
      ingestFrame(ingress, manager, frame, contracts);
    }

    const key = debugInstanceKey("graph", "hero");
    const onlineRecords = manager.storeFor(key)?.recordCount ?? 0;
    assert.ok(onlineRecords < 20, `the online view evicted the oldest records (kept ${onlineRecords})`);

    const footer = await recorder.stop();
    assert.equal(footer.records, frames.length, "the recording keeps every frame");
    assert.equal(await countRecordedFrames(filePath), frames.length);

    const source = await FileDebugSource.open(filePath);
    try {
      const result = await source.replay();
      assert.equal(result.manager.storeFor(key)?.recordCount, 20, "replay sees the complete recording");
    } finally {
      await source.close();
    }
  });
});

test("recording is not affected by receive-side drops or filterKey changes", async () => {
  await withTempDir(async (directory) => {
    const contracts = await primaryContracts();
    const { recorder, filePath } = await startRecorder(directory, { contracts: serializeRecordedContracts(contracts) });
    const manager = new DebugInstanceManager({ now: () => FIXED_CLOCK, filterKey: "mode=slow" });
    const ingress = new DebugIngress({
      contracts,
      recorder: { recordFrame: (channel, payloadKind, payload) => recorder.recordFrame(channel, payloadKind, payload) },
    });

    const frames = [jsonFrame(CREATE_JSON), jsonFrame(EVENT_JSON)];
    for (let index = 0; index < 5; index += 1) {
      frames.push(jsonFrame(EVENT_JSON));
    }

    // `Finish` 之后到达的数据帧会被接收侧丢弃（C.3）；`filterKey` 变化会让关键帧失效。
    // （F2 的 filterKey 在 HEAD 只作废关键帧、不过滤记录，因此这里同时覆盖两条真实路径。）
    frames.push(jsonFrame(JSON.stringify({ type: "debugFinish", category: "graph", instance: "hero" })));
    manager.setFilterKey("mode=fast");
    for (let index = 0; index < 5; index += 1) {
      frames.push(jsonFrame(EVENT_JSON));
    }

    for (const frame of frames) {
      ingestFrame(ingress, manager, frame, contracts);
    }

    assert.ok(manager.counters.droppedAfterFinish >= 5, `receive-side drops expected: ${JSON.stringify(manager.counters)}`);
    assert.equal(manager.filterKey, "mode=fast");
    const footer = await recorder.stop();
    assert.equal(footer.records, frames.length, "every frame reaches the file before any receive-side decision");
    assert.equal(await countRecordedFrames(filePath), frames.length);
  });
});

// ==== F5 返修（P1-02 / F5-04 / F5-05 / F5-06 / F5-07 / F5-03） ====

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test("stopping while the header write is blocked still writes the footer after the header (P1-02)", async () => {
  await withTempDir(async (directory) => {
    const filePath = path.join(directory, "blocked-header.vbdrec");
    const handle = await fs.open(filePath, "w");
    let releaseHeader: (() => void) | undefined;
    const headerGate = new Promise<void>((resolve) => {
      releaseHeader = resolve;
    });
    let blockHeader = true;
    let headerWriteEntered = false;
    let closes = 0;
    const types: number[] = [];
    const sink: DebugRecorderSink = {
      write: async (bytes) => {
        types.push(bytes[0]!);
        if (blockHeader && bytes[0] === DEBUG_RECORD_BLOCK_HEADER) {
          headerWriteEntered = true;
          blockHeader = false;
          await headerGate;
        }

        await handle.write(bytes);
      },
      sync: async () => {
        await handle.sync();
      },
      close: async () => {
        closes += 1;
        await handle.close();
      },
    };

    const recorder = new DebugSessionRecorder({
      filePath,
      header: headerInput(),
      openSink: async () => sink,
      now: () => FIXED_CLOCK,
    });
    const startPromise = recorder.start();
    while (!headerWriteEntered) {
      // 修复前：header 还在写的时候 stop() 看不到 header，直接拒绝并留下半开 fd。
      await tick();
    }

    const stopPromise = recorder.stop("disconnect");
    releaseHeader?.();
    const [header, footer] = await Promise.all([startPromise, stopPromise]);

    assert.equal(header.recordVersion, 1);
    assert.equal(footer.endedReason, "disconnect", "stop 必须排在 start 之后，而不是直接拒绝");
    assert.equal(footer.records, 0);
    assert.deepEqual(types, [DEBUG_RECORD_BLOCK_HEADER, DEBUG_RECORD_BLOCK_FOOTER], "文件尾只能写在文件头之后");
    assert.equal(closes, 1, "sink 必须恰好关闭一次（不遗留 fd）");

    const source = await FileDebugSource.open(filePath);
    try {
      const result = await source.replay();
      assert.equal(result.footer?.endedReason, "disconnect", "文件必须可被回看源打开（footer 不在 offset 0）");
    } finally {
      await source.close();
    }
  });
});

test("recordFrame never runs deflate on the caller's stack (F5-04)", async () => {
  await withTempDir(async (directory) => {
    const order: string[] = [];
    const { recorder } = await startRecorder(directory, {
      // 1 字节块：recordFrame 内部会立即 seal 并调度写循环，正好暴露"是否同步编码"。
      blockBytes: 1,
      onEncode: () => order.push("encode"),
    });

    recorder.recordFrame(BridgeChannel.Debug, BridgePayloadKind.Json, Buffer.from(EVENT_JSON));
    order.push("after-record");
    assert.equal(order.filter((entry) => entry === "encode").length, 0, "recordFrame 返回前不得压缩");
    assert.deepEqual(order, ["after-record"]);

    await tick();
    await tick();
    assert.deepEqual(order, ["after-record", "encode"], "压缩必须发生在调用栈之外（微任务）");
    await recorder.stop();
  });
});

test("every stop path accounts for all arrived frames (F5-06)", async () => {
  await withTempDir(async (directory) => {
    // 1) 手动停止：全部写入。
    const manual = await startRecorder(directory, { blockBytes: 64 });
    for (let index = 0; index < 10; index += 1) {
      manual.recorder.recordFrame(BridgeChannel.Debug, BridgePayloadKind.Json, Buffer.from(EVENT_JSON));
    }

    const manualFooter = await manual.recorder.stop();
    assert.equal(manualFooter.records + manualFooter.droppedRecords, 10);
    assert.equal(manualFooter.records, 10);
    assert.equal(await countRecordedFrames(manual.filePath), 10);

    // 2) 断连：停止时未封口的 current 必须进账（写不下就计 dropped）。
    const disconnect = await startRecorder(directory, { blockBytes: 1_000, maxFileBytes: 1_000 });
    let disconnectFrames = 0;
    for (let index = 0; index < 7; index += 1) {
      disconnect.recorder.recordFrame(BridgeChannel.Debug, BridgePayloadKind.Json, Buffer.from(EVENT_JSON));
      disconnectFrames += 1;
    }

    const disconnectFooter = await disconnect.recorder.stop("disconnect");
    assert.equal(disconnectFooter.endedReason, "disconnect");
    assert.equal(disconnectFooter.records + disconnectFooter.droppedRecords, disconnectFrames);

    // 3) sizeLimit：上限小到第一个数据块就超限；11 帧 = 5 个封口块 + 1 帧留在 current，
    // 收尾时这一帧必须进账（写不下就计 dropped），不能凭空消失。
    const limited = await startRecorder(directory, { blockBytes: 300, maxFileBytes: 1, queueBlocks: 64 });
    let arrived = 0;
    for (let index = 0; index < 11; index += 1) {
      limited.recorder.recordFrame(BridgeChannel.Debug, BridgePayloadKind.Json, Buffer.from(EVENT_JSON));
      arrived += 1;
    }

    while (limited.recorder.active) {
      await tick();
    }

    const limitedFooter = await limited.recorder.stop();
    assert.equal(limitedFooter.endedReason, "sizeLimit");
    assert.ok(limitedFooter.droppedRecords > 0, `expected dropped frames before hitting the cap: ${JSON.stringify(limitedFooter)}`);
    assert.equal(
      limitedFooter.records + limitedFooter.droppedRecords,
      arrived,
      `records + droppedRecords must equal every arrived frame (arrived=${arrived})`,
    );
    assert.equal(await countRecordedFrames(limited.filePath), limitedFooter.records);
  });
});

test("the recording monitor waits for finalize and forwards the footer summary (F5-05)", () => {
  let state = {
    active: true,
    filePath: "C:/recordings/session.vbdrec",
    records: 0,
    droppedRecords: 0,
    droppedBytes: 0,
    endedReason: undefined as "sizeLimit" | undefined,
    finalized: false,
    deliverable: false,
    failure: undefined as string | undefined,
  };
  const stops: { filePath: string; summary: unknown }[] = [];
  const monitor = new DebugRecordingMonitor({
    bridge: () => ({ recordingState: state }),
    onStopped: (filePath, summary) => stops.push({ filePath, summary }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
  });
  monitor.start("C:/recordings/session.vbdrec");

  monitor.check();
  assert.deepEqual(stops, [], "录制中不提示");

  // 已自动收尾但 footer/sync/close 未完成：仍不能提示（当前实现会在这里就 toast + undefined）。
  state = { ...state, active: false, records: 5, droppedRecords: 2, droppedBytes: 90, endedReason: "sizeLimit", finalized: false };
  monitor.check();
  assert.deepEqual(stops, [], "finalize 之前绝不能提示可打开回看");

  state = { ...state, finalized: true, deliverable: true };
  monitor.check();
  assert.deepEqual(stops, [{
    filePath: "C:/recordings/session.vbdrec",
    summary: { records: 5, droppedRecords: 2, droppedBytes: 90, endedReason: "sizeLimit" },
  }], "finalize 后交付完整 footer 摘要（不是 undefined）");

  monitor.check();
  assert.equal(stops.length, 1, "同一次录制只提示一次");
  monitor.dispose();
});

test("a failed footer is reported as an error, never as 'saved' (P2-4)", () => {
  const failures: { filePath: string; message: string }[] = [];
  const stops: unknown[] = [];
  const monitor = new DebugRecordingMonitor({
    bridge: () => ({
      recordingState: {
        active: false,
        filePath: "C:/recordings/broken.vbdrec",
        records: 7,
        droppedRecords: 0,
        droppedBytes: 0,
        endedReason: "disconnect",
        finalized: true,
        deliverable: false,
        failure: "footer write failed: EIO",
      },
    }),
    onStopped: (filePath, summary) => stops.push({ filePath, summary }),
    onFailed: (filePath, message) => failures.push({ filePath, message }),
    schedule: () => 1,
    cancelSchedule: () => undefined,
  });
  monitor.start("C:/recordings/broken.vbdrec");
  monitor.check();

  assert.deepEqual(stops, [], "footer 没写成时不能提示『已保存/可打开回看』");
  assert.deepEqual(failures, [{ filePath: "C:/recordings/broken.vbdrec", message: "footer write failed: EIO" }]);
  monitor.check();
  assert.equal(failures.length, 1, "同一次收尾只报一次错");
  monitor.dispose();
});

test("replay keeps records beyond the live per-instance budget (F5-07)", async () => {
  await withTempDir(async (directory) => {
    const contracts = await primaryContracts();
    const events = 20_005;
    const { recorder, filePath } = await startRecorder(directory, {
      contracts: serializeRecordedContracts(contracts),
      blockBytes: 256 * 1024,
      queueBlocks: 64,
    });
    const live = new DebugInstanceManager({ now: () => FIXED_CLOCK });
    const ingress = new DebugIngress({
      contracts,
      recorder: { recordFrame: (channel, payloadKind, payload) => recorder.recordFrame(channel, payloadKind, payload) },
    });
    const key = debugInstanceKey("graph", "hero");
    ingestFrame(ingress, live, jsonFrame(CREATE_JSON), contracts);
    for (let index = 0; index < events; index += 1) {
      ingestFrame(ingress, live, jsonFrame(EVENT_JSON), contracts);
    }

    const footer = await recorder.stop();
    assert.equal(footer.records, events + 1);
    assert.equal(live.storeFor(key)?.recordCount, 20_000, "在线 manager 仍按 2 万条预算淘汰");

    const session = await DebugReplaySession.load(filePath);
    try {
      assert.equal(
        session.manager.storeFor(key)?.recordCount,
        events,
        "回看必须保持文件里的全部记录（不是 >= 在线条数，也不是再次淘汰后的条数）",
      );
    } finally {
      session.dispose();
    }
  });
});

test("a start failure closes the sink exactly once and stop() rejects instead of leaking (P2-8)", async () => {
  await withTempDir(async (directory) => {
    sequence += 1;
    const openFailed = new DebugSessionRecorder({
      filePath: path.join(directory, "open-failed.vbdrec"),
      header: headerInput(),
      now: () => FIXED_CLOCK,
      openSink: async () => {
        throw new Error("open failed");
      },
    });
    await assert.rejects(openFailed.start(), /open failed/u);
    assert.equal(openFailed.stats.active, false, "启动失败后不能再显示为录制中");
    assert.equal(openFailed.stats.deliverable, false);
    await assert.rejects(openFailed.stop(), /open failed/u, "stop() 收到同一个 reject，不产生未处理错误");

    let closeCalls = 0;
    const headerFailSink: DebugRecorderSink = {
      write: async () => {
        throw new Error("header write failed");
      },
      sync: async () => undefined,
      close: async () => {
        closeCalls += 1;
      },
    };
    sequence += 1;
    const headerFailed = new DebugSessionRecorder({
      filePath: path.join(directory, "header-failed.vbdrec"),
      header: headerInput(),
      now: () => FIXED_CLOCK,
      openSink: async () => headerFailSink,
    });
    await assert.rejects(headerFailed.start(), /header write failed/u);
    assert.equal(closeCalls, 1, "半开的 sink 必须恰好 close 一次");
    assert.equal(headerFailed.stats.active, false);
    assert.equal(headerFailed.stats.finalized, true);
    assert.equal(headerFailed.stats.deliverable, false, "没有 footer ⇒ 不可交付");
    assert.match(headerFailed.stats.failure ?? "", /header write failed/u);
    await assert.rejects(headerFailed.stop(), /header write failed/u);
  });
});

test("a footer write failure makes the recording non-deliverable (P2-4)", async () => {
  await withTempDir(async (directory) => {
    let closeCalls = 0;
    const sink: DebugRecorderSink = {
      write: async (bytes) => {
        if (bytes.readUInt8(0) === DEBUG_RECORD_BLOCK_FOOTER) {
          throw new Error("footer write failed");
        }
      },
      sync: async () => undefined,
      close: async () => {
        closeCalls += 1;
      },
    };
    sequence += 1;
    const recorder = new DebugSessionRecorder({
      filePath: path.join(directory, "footer-failed.vbdrec"),
      header: headerInput(),
      now: () => FIXED_CLOCK,
      openSink: async () => sink,
    });
    await recorder.start();
    recorder.recordFrame(BridgeChannel.Debug, BridgePayloadKind.Json, Buffer.from(CREATE_JSON));
    await assert.rejects(recorder.stop(), /footer write failed/u);

    const stats = recorder.stats;
    assert.equal(closeCalls, 1, "sink 恰好 close 一次");
    assert.equal(stats.finalized, true, "sink 已关，可以判定结果");
    assert.equal(stats.deliverable, false, "footer 没写成 ⇒ 不能提示『已保存』");
    assert.match(stats.failure ?? "", /footer write failed/u);
    assert.equal(stats.endedReason, undefined, "没有 footer 就没有 endedReason");
  });
});

test("frames arriving during finalize are neither counted nor written (F5-06)", async () => {
  await withTempDir(async (directory) => {
    const blocks: Buffer[] = [];
    let releaseFooter!: () => void;
    const footerGate = new Promise<void>((resolve) => {
      releaseFooter = resolve;
    });
    let footerStarted!: () => void;
    const footerStartedPromise = new Promise<void>((resolve) => {
      footerStarted = resolve;
    });
    const sink: DebugRecorderSink = {
      write: async (bytes) => {
        blocks.push(Buffer.from(bytes));
        if (bytes.readUInt8(0) === DEBUG_RECORD_BLOCK_FOOTER) {
          footerStarted();
          await footerGate;
        }
      },
      sync: async () => undefined,
      close: async () => undefined,
    };
    sequence += 1;
    const recorder = new DebugSessionRecorder({
      filePath: path.join(directory, "finalize-race.vbdrec"),
      header: headerInput(),
      now: () => FIXED_CLOCK,
      openSink: async () => sink,
    });
    await recorder.start();
    recorder.recordFrame(BridgeChannel.Debug, BridgePayloadKind.Json, Buffer.from(CREATE_JSON));

    const stopping = recorder.stop();
    await footerStartedPromise;
    // footer 已经构建、正在写：此刻到达的帧既不能改 footer，也不能进文件。
    recorder.recordFrame(BridgeChannel.Debug, BridgePayloadKind.Json, Buffer.from(EVENT_JSON));
    releaseFooter();
    const footer = await stopping;

    assert.equal(footer.records, 1, "finalize 期间到达的帧不入账");
    assert.equal(footer.droppedRecords, 0, "也不计入本次收尾的丢弃（它不属于这一轮的账）");
    const dataBlocks = blocks.filter((block) => block.readUInt8(0) === DEBUG_RECORD_BLOCK_DATA);
    assert.equal(dataBlocks.length, 1);
    assert.equal(splitFrames(zlibInflate(dataBlocks[0]!)).length, 1, "文件里也只有 finalize 前的那一帧");
  });
});

test("the recorder's record cap equals the replay budget, so anything recorded can be opened (P1-A invariant)", async () => {
  await withTempDir(async (directory) => {
    const cappedRecords = 50;
    const { recorder, filePath } = await startRecorder(directory, {
      maxRecords: cappedRecords,
      blockBytes: 64 * 1024,
    });
    recorder.recordFrame(BridgeChannel.Debug, BridgePayloadKind.Json, Buffer.from(CREATE_JSON));
    for (let index = 0; index < 119; index += 1) {
      recorder.recordFrame(BridgeChannel.Debug, BridgePayloadKind.Json, Buffer.from(EVENT_JSON));
    }

    while (!recorder.stats.finalized) {
      await tick();
    }

    const footer = await recorder.stop();
    assert.equal(footer.records, cappedRecords, "达到记录上限的那一帧必须进文件（footer.records 正好等于上限）");
    assert.equal(footer.endedReason, "sizeLimit", "记录条数上限复用 sizeLimit（C.6 的枚举没有第三种）");
    assert.equal(footer.droppedRecords, 120 - cappedRecords, "上限之后的帧如实计为丢弃");

    // 用**同一份预算**打开：不会被拒绝；footer.records 就是打开前预检看到的条数。
    const session = await DebugReplaySession.load(filePath, { preflight: { maxRecords: cappedRecords } });
    try {
      assert.equal(session.footer?.records, cappedRecords);
      const key = debugInstanceKey("graph", "hero");
      assert.equal(
        session.manager.storeFor(key)?.recordCount,
        cappedRecords - 1,
        "能录出来的帧数 == 预检条数；回看重放出的业务记录 = 帧数 - 1 条 debugCreate",
      );
    } finally {
      session.dispose();
    }
  });
});

test("without the recorder cap the same budget rejects the file (P1-A red state)", async () => {
  await withTempDir(async (directory) => {
    const cappedRecords = 50;
    // 模拟修复前：录制端只有 maxFileBytes（文件很小，所以一定录得出来）。
    const { recorder, filePath } = await startRecorder(directory, {
      maxRecords: Number.MAX_SAFE_INTEGER,
      blockBytes: 64 * 1024,
    });
    for (let index = 0; index < 120; index += 1) {
      recorder.recordFrame(BridgeChannel.Debug, BridgePayloadKind.Json, Buffer.from(EVENT_JSON));
    }

    const footer = await recorder.stop();
    assert.equal(footer.records, 120, "只有文件字节上限时，120 帧全都录得出来");

    await assert.rejects(DebugReplaySession.load(filePath, { preflight: { maxRecords: cappedRecords } }), (errorValue: unknown) => {
      const message = errorValue instanceof Error ? errorValue.message : String(errorValue);
      assert.match(message, /120 条记录/u, "拒绝信息必须给出实际条数");
      assert.match(message, /超过回看上限（50 条/u, "拒绝信息必须给出预算");
      return true;
    });
  });
});

test("replay preflight rejects a footer that declares more records than the budget, before decoding", async () => {
  await withTempDir(async (directory) => {
    const declared = DEBUG_REPLAY_MAX_RECORDS + 1;
    const filePath = await writeRawRecording(
      directory,
      rawHeader(),
      [Buffer.concat([frameBytes(jsonFrame(CREATE_JSON))])],
      rawFooter({ records: declared }),
    );

    // 旧路径（不经预检的 FileDebugSource.replay）照常接受：拒绝来自新的打开前预检，而不是别处。
    const legacy = await FileDebugSource.open(filePath);
    try {
      const legacyResult = await legacy.replay();
      assert.equal(legacyResult.footer?.records, declared);
    } finally {
      await legacy.close();
    }

    await assert.rejects(DebugReplaySession.load(filePath), (errorValue: unknown) => {
      const message = errorValue instanceof Error ? errorValue.message : String(errorValue);
      assert.match(message, new RegExp(String(declared), "u"), "错误信息必须含文件声明的条数");
      assert.match(message, new RegExp(String(DEBUG_REPLAY_MAX_RECORDS), "u"), "错误信息必须含回看上限");
      assert.match(message, /超过回看上限/u);
      assert.match(message, /分段录制/u, "给出可执行的下一步");
      return true;
    });
  });
});

test("replay preflight rejects an oversized truncated file that has no footer", async () => {
  await withTempDir(async (directory) => {
    const filePath = await writeRawRecording(
      directory,
      rawHeader(),
      [Buffer.concat([frameBytes(jsonFrame(CREATE_JSON))])],
    );
    // 不写 128 MB 内容：把文件截成超过磁盘兜底上限的稀疏文件（footer 在截断处丢失）。
    const handle = await fs.open(filePath, "r+");
    try {
      await handle.truncate(DEBUG_REPLAY_MAX_FILE_BYTES + 1);
    } finally {
      await handle.close();
    }

    const stat = await fs.stat(filePath);
    assert.equal(stat.size, DEBUG_REPLAY_MAX_FILE_BYTES + 1);
    // 旧路径：没有 footer 也照常"打开"（0 条记录）——这正是需要预检拦住的形态。
    const legacy = await FileDebugSource.open(filePath);
    try {
      const legacyResult = await legacy.replay();
      assert.equal(legacyResult.footer, undefined);
    } finally {
      await legacy.close();
    }

    await assert.rejects(preflightRecordingFile(filePath), (errorValue: unknown) => {
      const message = errorValue instanceof Error ? errorValue.message : String(errorValue);
      assert.match(message, /超过回看上限/u);
      assert.match(message, /没有可用的文件尾/u, "必须说明是按截断文件兜底拒绝的");
      return true;
    });
    await assert.rejects(DebugReplaySession.load(filePath), /没有可用的文件尾/u);
  });
});

test("the wire-byte budget catches 1 MB repeating payloads that pass both old caps (P1-A red state A)", async () => {
  await withTempDir(async (directory) => {
    const frames = 200;
    const payload = Buffer.alloc(1024 * 1024 - FRAME_HEADER_BYTES, 0x41);
    // 模拟上一轮：只有 records 与压缩后文件上限，没有线上字节上限。
    const { recorder, filePath } = await startRecorder(directory, {
      maxWireBytes: Number.MAX_SAFE_INTEGER,
      blockBytes: 256 * 1024,
      queueBlocks: 2_048,
    });
    for (let index = 0; index < frames; index += 1) {
      recorder.recordFrame(BridgeChannel.Debug, BridgePayloadKind.Binary, payload);
    }

    const footer = await recorder.stop();
    const stat = await fs.stat(filePath);
    assert.equal(footer.records, 200, "记录数远低于 20 万上限");
    assert.equal(footer.wireBytes, frames * 1024 * 1024, "footer 必须如实记下 200 MB 原始线上字节");
    assert.ok(footer.wireBytes > DEBUG_REPLAY_MAX_WIRE_BYTES);
    assert.ok(
      stat.size < DEBUG_REPLAY_MAX_FILE_BYTES,
      `重复载荷压缩后只有 ${(stat.size / (1024 * 1024)).toFixed(1)} MB，旧的 128 MB 文件上限拦不住`,
    );

    // 旧预检只看 footer.records，会放行这 200 MB；新预检按 wireBytes 拒绝。
    const reader = await DebugRecordingReader.open(filePath);
    try {
      const parsed = await reader.readFooter();
      assert.equal(parsed?.records, 200, "被伪装成'记录数正常'的录制");
      assert.equal(parsed?.wireBytes, frames * 1024 * 1024);
    } finally {
      await reader.close();
    }

    await assert.rejects(DebugReplaySession.load(filePath), (errorValue: unknown) => {
      const message = errorValue instanceof Error ? errorValue.message : String(errorValue);
      assert.match(message, /原始帧字节/u);
      assert.match(message, /200\.0 MB/u, "拒绝信息必须给出实际线上字节");
      assert.match(message, /64\.0 MB/u, "拒绝信息必须给出线上字节预算");
      return true;
    });
  });
});

test("replay preflight rejects a footer whose wireBytes alone exceeds the budget (P1-A red state B)", async () => {
  await withTempDir(async (directory) => {
    const declared = 96 * 1024 * 1024;
    const filePath = await writeRawRecording(
      directory,
      rawHeader(),
      [Buffer.concat([frameBytes(jsonFrame(CREATE_JSON))])],
      rawFooter({ records: 1, wireBytes: declared }),
    );

    // 旧路径（不经预检的 replay）只看到 1 条记录；新预检拒绝，信息带 96.0 / 64.0 两个数。
    const legacy = await FileDebugSource.open(filePath);
    try {
      const legacyResult = await legacy.replay();
      assert.equal(legacyResult.footer?.wireBytes, declared);
    } finally {
      await legacy.close();
    }

    await assert.rejects(DebugReplaySession.load(filePath), (errorValue: unknown) => {
      const message = errorValue instanceof Error ? errorValue.message : String(errorValue);
      assert.match(message, /96\.0 MB/u, "拒绝信息必须含实际 wireBytes");
      assert.match(message, /64\.0 MB/u, "拒绝信息必须含预算");
      assert.match(message, /原始帧字节/u);
      return true;
    });
  });
});

test("a 32 MB-class recording (70k records, ~74 MB decoded) still opens (P1-A green)", async () => {
  await withTempDir(async (directory) => {
    const records = 70_000;
    const { recorder, filePath } = await startRecorder(directory, {
      blockBytes: 256 * 1024,
      queueBlocks: 2_048,
    });
    for (let index = 0; index < records; index += 1) {
      // 随机值让压缩比接近真实载荷（否则 32 MB 的录制会被压成 2 MB，测不到磁盘规模）。
      const value = randomBytes(480).toString("base64url");
      recorder.recordFrame(
        BridgeChannel.Debug,
        BridgePayloadKind.Json,
        Buffer.from(JSON.stringify({
          type: "debug",
          category: "f5-big",
          instance: "big",
          iface: "IGraphDebuger",
          method: "NodeStarted",
          frame: index % 1_000,
          args: [{ tag: 1, name: "nodeId", type: "string", value }],
        })),
      );
    }

    const footer = await recorder.stop();
    const stat = await fs.stat(filePath);
    assert.equal(footer.records, records);
    assert.equal(footer.endedReason, "disconnect");
    assert.ok(
      stat.size >= 28 * 1024 * 1024 && stat.size <= 40 * 1024 * 1024,
      `expected a 32 MB-class file, got ${(stat.size / (1024 * 1024)).toFixed(1)} MB`,
    );
    assert.ok(
      footer.wireBytes > stat.size,
      "原始线上字节应大于压缩后文件（否则下一条断言没有区分力）",
    );
    assert.ok(
      footer.wireBytes < DEBUG_REPLAY_MAX_WIRE_BYTES,
      `70k 小帧的线上字节 ${(footer.wireBytes / (1024 * 1024)).toFixed(1)} MB 必须低于 64 MB 预算`,
    );

    const preflight = await DebugReplaySession.preflight(filePath);
    assert.equal(preflight.records, records);
    assert.equal(preflight.wireBytes, footer.wireBytes);
    assert.ok(preflight.records < DEBUG_REPLAY_MAX_RECORDS);
    assert.ok(preflight.wireBytes !== undefined && preflight.wireBytes < DEBUG_REPLAY_MAX_WIRE_BYTES);

    const session = await DebugReplaySession.load(filePath);
    try {
      assert.equal(session.footer?.records, records);
      assert.equal(session.footer?.wireBytes, footer.wireBytes);
      const key = debugInstanceKey("f5-big", "big");
      assert.equal(
        session.manager.storeFor(key)?.recordCount,
        records,
        "70k 条记录（约 74 MB 解码）必须完整进回看，不能被上限挡在门外",
      );
    } finally {
      session.dispose();
    }
  });
});

test("a recorded contract conflict round-trips and still reports contract-conflict (F5-03)", async () => {
  await withTempDir(async (directory) => {
    const supplemental = path.join(repositoryRoot, "TestData", "DebugContracts", "Supplemental");
    const set = await new DebugContractRegistry().load({
      projectRoots: [unityProject],
      supplementalDirectories: [supplemental],
    });
    const snapshot = set.snapshots[0];
    assert.ok(snapshot !== undefined);
    assert.equal(snapshot.conflicts.length, 1);

    const recorded = serializeRecordedContracts(snapshot);
    assert.ok(recorded !== null);
    assert.deepEqual(recorded.conflicts, [{ kind: "interface", key: "Sample.Graph.IGraphDebuger" }]);

    // 文件头往返：冲突摘要必须原样落盘、原样读回。
    const { recorder, filePath } = await startRecorder(directory, { contracts: recorded });
    await recorder.stop();
    const reader = await DebugRecordingReader.open(filePath);
    try {
      assert.deepEqual(reader.header.contracts?.conflicts, recorded.conflicts);
    } finally {
      await reader.close();
    }

    // 用文件内快照重建：冲突接口的方法仍然判定为 contract-conflict（不是 matched）。
    const restored = snapshotFromRecordedContracts(recorded);
    assert.equal(restored.resolveMessage("graph", 11, undefined, undefined).state, "contract-conflict");
    assert.equal(restored.isConflicted("Sample.Graph.IGraphDebuger"), true);
  });
});
