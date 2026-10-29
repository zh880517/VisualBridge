/**
 * `.vbdrec` 会话录制容器（附录 C.6）：块编解码、文件头/文件尾、录制定向判定。
 *
 * 字节布局（全部大端）：
 * ```text
 * 文件      = 文件头块(0) + 数据块(1)* + 文件尾块(2)?
 * 每个块    = type(u8: 0/1/2) + length(u32: 压缩后字节数) + crc32(u32: 解压后字节的 CRC-32)
 *             + zlib(payload，解压后 ≤ 64 KB 目标)
 * 数据块载荷 = 原样线上帧串联：6 字节协议头 + 载荷（与实时连接收到的字节逐字节一致）
 * 文件头载荷 = UTF-8 JSON（DebugRecordingHeader）
 * 文件尾载荷 = UTF-8 JSON（DebugRecordingFooter）
 * ```
 *
 * **两级校验是分开的**（任务书 §评审清单 P0）：
 * - 块 CRC 覆盖**解压后**的数据块载荷，用来判断"这个块能不能用"；块坏只跳过该块（`length`
 *   是压缩字节数，可据此定位下一个块）。
 * - 帧 CRC 是 6 字节协议头自带的 CRC-16（`framing.ts`），用来判断"块内这一帧能不能解"；
 *   帧头 CRC 失败时长度字段不可信，只能停在该帧、由调用方在下一个块边界恢复
 *   （`DebugIngress.resumeRecordedStream`）。
 *
 * 录制只发生在**入站方向**（Unity → VS Code）：上方 A.2 的方向列决定"根本收不到"的消息，
 * 本模块的 {@link shouldRecordInboundFrame} 决定"收到了也不录"的消息。两件事分开表达，
 * 避免把"方向不对"误写成"过滤掉"。
 */

import { deflateSync } from "node:zlib";
import { BridgeChannel, BridgePayloadKind, FRAME_HEADER_BYTES, encodeFrame } from "./framing";

/** 录制格式版本；不兼容即拒绝回看（不做迁移，附录 C.6）。 */
export const DEBUG_RECORD_VERSION = 1;

/** 块类型。 */
export const DEBUG_RECORD_BLOCK_HEADER = 0;
export const DEBUG_RECORD_BLOCK_DATA = 1;
export const DEBUG_RECORD_BLOCK_FOOTER = 2;

/** 块头固定字节数：type(1) + length(4) + crc32(4)。 */
export const DEBUG_RECORD_BLOCK_HEADER_BYTES = 9;

/** 解压后一个数据块的目标字节数（C.6 的 64 KB）。单帧超过它时该块会更大。 */
export const DEBUG_RECORDING_BLOCK_TARGET_BYTES = 64 * 1024;

/** 读块时的解压上限：目标块 + 一个最大帧（1 MB），防御压缩炸弹。 */
export const DEBUG_RECORDING_MAX_DECOMPRESSED_BYTES = DEBUG_RECORDING_BLOCK_TARGET_BYTES + 1024 * 1024 + FRAME_HEADER_BYTES;

/** 读块时的压缩上限：正常 zlib 不会超过解压上限；超过即视为长度字段不可信。 */
export const DEBUG_RECORDING_MAX_COMPRESSED_BYTES = DEBUG_RECORDING_MAX_DECOMPRESSED_BYTES + 64 * 1024;

/** 默认文件上限（未在 A.8 中规定，取一个可回看又不至于撑爆内存的值）。 */
export const DEBUG_RECORDING_DEFAULT_MAX_FILE_BYTES = 128 * 1024 * 1024;

/**
 * 回看/录制的**原始线上字节**预算（P1-A 返修第 3 轮）：64 MB。
 *
 * 计量单位必须是“原始线上字节”（每帧 6 B 帧头 + 载荷），既不是压缩后文件大小，也不是单纯的记录条数。
 *
 * **逐条解码开销量不出单一倍数**（F8-§7-f）：实测 2 参事件 ≈3.5×（213.9 B raw → 739.6 B 解码）、
 * 空参 ≈6.11×、无参 ≈6.97×、6 参事件 ≈2.4×。载荷越小，逐字段/逐对象的固定开销占比越大。
 * 所以内存上界是**两个上限的联合**，任何一侧单独放开来算都会出错：
 * - 记录数侧（{@link DEBUG_REPLAY_MAX_RECORDS}）：20 万条 × 740–1107 B ⇒ 148–221 MB。
 *   极小帧（如 77 B 的 no-args 事件）连 15.4 MB 线上字节都不到，字节预算**根本管不到**，
 *   只能靠记录数兜住；
 * - 字节侧（本常量）：200_000 × 335 B = 67.0 MB（63.9 MiB）线上字节 ⇒ ×2.4 ≈ 161 MB 解码，
 *   更大的载荷按 ≈1× 递增，64 MiB ⇒ ≈64 MB（Buffer 为主）。
 *
 * **两个上限不能同时取到**：221 MB 需要 20 万条 1107 B 的记录，而 1107 B 的记录来自约 460 B
 * 的帧，20 万条就是 ≈92 MB 线上字节，早已越过 64 MiB 的字节上限；反过来在 64 MiB 里塞满
 * 335 B 的帧也就 20 万条 ⇒ ≈161 MB 解码。所以真实最坏 ≈161 MB，221 MB 只是记录数侧单独取满
 * 的保守值（不可达）。联合上界取 221 MB 是**故意保守**：两个上限各自独立成立，不依赖载荷分布。
 *
 * 221 MB 低于扩展宿主 old-space；且 64 MiB > 在线每实例 32 MB 上限，保留
 * “回看能完整看到超出在线视图的录制”这一验收语义。
 *
 * **不能**再取 `200_000 × MAX_MESSAGE_BYTES = 200 GB` 这种名义上界：重复载荷压缩比可达 ~1000×，
 * 13 万条 1 MB 帧能装进 128 MB 压缩文件，预检若只看记录数会放行 128 GB 的解码。
 */
export const DEBUG_REPLAY_MAX_WIRE_BYTES = 64 * 1024 * 1024;

/** 录制端默认线上字节上限：与回看预算**同一个数**（单一真源，见 {@link DEBUG_REPLAY_MAX_WIRE_BYTES}）。 */
export const DEBUG_RECORDING_DEFAULT_MAX_WIRE_BYTES = DEBUG_REPLAY_MAX_WIRE_BYTES;

/**
 * 回看解码后的**记录条数**上限（P1-A）：20 万条。
 *
 * 它是线上字节预算之外的独立上限：小记录（约 740 B 解码/条）很多、原始字节却不大时，
 * 逐条对象/Map 的固定开销仍需兜住。200_000 × 1107 B ≈ 221 MB / 200_000 × 740 B ≈ 148 MB。
 *
 * 录制端也用**同一个常量**作为默认记录上限（{@link DEBUG_RECORDING_DEFAULT_MAX_RECORDS}），
 * 从而保证“能录出来的文件一定能打开”，不把用户挡在一堵只有回看才存在的墙前。
 */
export const DEBUG_REPLAY_MAX_RECORDS = 200_000;

/** 录制端默认记录上限：与回看预算**同一个数**（单一真源，见 {@link DEBUG_REPLAY_MAX_RECORDS}）。 */
export const DEBUG_RECORDING_DEFAULT_MAX_RECORDS = DEBUG_REPLAY_MAX_RECORDS;

/** 评审实测的保守单条解码占用（6 参事件 1107 B 取整）；只用于拒绝信息里的估算。 */
export const DEBUG_REPLAY_DECODED_BYTES_PER_RECORD = 1_107;

/**
 * 没有文件尾（崩溃/截断）时的磁盘字节兜底上限：录制端默认文件上限（128 MB）。
 *
 * 有文件尾时以 `footer.records` + `footer.wireBytes` 为准——磁盘字节推不出解码内存；
 * 没有文件尾时无从知道这两个数，只能用“文件本身不该比录制上限还大”做保守拒绝线
 * （这也正是 `dispose` 时 fire-and-forget 收尾可能留下的形态）。
 */
export const DEBUG_REPLAY_MAX_FILE_BYTES = DEBUG_RECORDING_DEFAULT_MAX_FILE_BYTES;

/** 写队列默认容量（块数）：满则丢块并计数，绝不阻塞接收（C.6）。 */
export const DEBUG_RECORDING_DEFAULT_QUEUE_BLOCKS = 16;

export type DebugRecordingBlockType =
  | typeof DEBUG_RECORD_BLOCK_HEADER
  | typeof DEBUG_RECORD_BLOCK_DATA
  | typeof DEBUG_RECORD_BLOCK_FOOTER;

/** 录制结束原因。C.6 只有两个值；手动停止复用 `disconnect`（录制结束，会话语义不变）。 */
export type DebugRecordingEndReason = "disconnect" | "sizeLimit";

/** 连接类型（A.3 的 `connectType`）。 */
export type DebugRecordingConnectType = "editor" | "editor-player" | "player";

/**
 * 录制时的契约快照（文件头 `contracts`）。
 *
 * F1 的 {@link DebugContractSnapshot} 只保留**规范化后的合并结果**（方法/参数/枚举宽度），
 * 不保留源文件字节；这里序列化的就是那份合并结果，字段与 `debug-contracts.json` 的语义一一
 * 对应，回看时可直接重建快照、不读工作区（满足 C.8"回看以文件内快照为准"）。
 */
export interface RecordedDebugContracts {
  readonly contractHash: string;
  readonly schemaVersion: number;
  /** 是否加载到了主来源：决定二进制未知方法按"约定产物在手"丢弃还是走通用视图。 */
  readonly hasPrimary: boolean;
  readonly methods: readonly RecordedDebugMethod[];
  /**
   * 合并冲突的**最小**摘要（F5-03）：回看据此重建 `contract-conflict`。
   * 只保留 `contractState` 判定需要的键；目录、detail 属于加载期诊断，不写进文件。
   * 旧文件没有该字段时按空数组读取（recordVersion 仍是 1，不做迁移）。
   */
  readonly conflicts: readonly RecordedDebugConflict[];
}

/** 文件头里的冲突摘要：`interface` 冲突只用 key，`method` 冲突另带分类与方法号。 */
export interface RecordedDebugConflict {
  readonly kind: "interface" | "method";
  readonly key: string;
  readonly category?: string;
  readonly methodId?: number;
}

/** 与 `DebugContractMethod` 结构相同（单独声明避免格式模块反向依赖注册表实现）。 */
export interface RecordedDebugMethod {
  readonly category: string;
  readonly interfaceId: string;
  readonly interfaceFullName: string;
  readonly name: string;
  readonly methodId: number;
  readonly kind: string;
  readonly parameters: readonly RecordedDebugParameter[];
  readonly result: RecordedDebugParameter | undefined;
}

export interface RecordedDebugParameter {
  readonly tag: number;
  readonly name: string;
  readonly declaredType: string;
  readonly wireType: string;
  readonly enumName: string | undefined;
  readonly enumWidth: 1 | 2 | 4 | 8 | undefined;
  readonly optional: boolean;
}

/** 文件头（C.6 的字段顺序即序列化顺序，便于人工阅读）。 */
export interface DebugRecordingHeader {
  readonly recordVersion: number;
  readonly protocolVersion: number;
  readonly contractSchemaVersion: number;
  readonly contractHash: string;
  readonly sessionId: string;
  readonly endpointId: string;
  readonly bootId: string;
  readonly connectType: DebugRecordingConnectType;
  /** ISO 时间；由注入时钟产生，不散落 `Date.now()`。 */
  readonly startedAt: string;
  /** 开始录制那一刻的合并契约快照（P0：不是结束时）。 */
  readonly contracts: RecordedDebugContracts | null;
}

/** 文件尾（C.6）。 */
export interface DebugRecordingFooter {
  /** 写进文件的数据帧条数（成功落盘的记录数）。 */
  readonly records: number;
  /**
   * 录制期间**接受**的帧的原始线上字节总和（每帧 = 6 字节帧头 + 载荷）。
   *
   * 这是回看解码内存的计量单位（P1-A 返修第 3 轮）：压缩后文件大小不是上界，
   * 记录条数也不够——1 MB 重复载荷压缩后可小到 1 KB/帧，20 万条记录能装下约 128 GB
   * 解压后的原始字节。录制端按同一预算截断，预检按它拒绝超大文件。
   *
   * 队列满导致整块丢弃时，块内帧不写进文件、但仍算“接受”，所以它是文件实际内容的保守上界；
   * 逐帧丢弃（帧本身超限/编码失败/到上限）不计入。
   */
  readonly wireBytes: number;
  /** 未写进文件的帧条数（队列满 / 到大小上限 / 启动窗口外到达）。 */
  readonly droppedRecords: number;
  /**
   * 丢弃帧的**未压缩**字节数：6 字节帧头 + 载荷（块里存的就是原样线上帧）。
   * 两条丢弃路径同口径：整块丢（`dropBlock` 用块字节数）与单帧丢（`dropFrame` 用载荷 + 帧头）。
   */
  readonly droppedBytes: number;
  readonly endedAt: string;
  readonly endedReason: DebugRecordingEndReason;
}

export type DebugRecordingErrorCode =
  | "recording.invalidHeader"
  | "recording.unsupportedVersion"
  | "recording.invalidFooter"
  | "recording.truncated"
  | "recording.corruptBlock"
  /** 预检拒绝回看：文件/记录数超过回看预算（P1-A）。 */
  | "recording.tooLarge";

/** 录制文件层错误：带稳定 code，调用方据此区分"拒绝回看"与"跳过损坏块"。 */
export class DebugRecordingError extends Error {
  public constructor(
    public readonly code: DebugRecordingErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "DebugRecordingError";
  }
}

/** 一条入站帧的录制判定（报告里的逐消息表即由它生成）。 */
export interface FrameRecordingDecision {
  /** 是否写入录制文件。 */
  readonly record: boolean;
  /** 线上消息名（通道 1 二进制按 methodId 归类；未知时为 `undefined`）。 */
  readonly messageType: string | undefined;
  /** 判定理由（英文，进日志；报告用中文对照）。 */
  readonly reason:
    | "debug-data"
    | "editor-operation"
    | "handshake"
    | "keepalive"
    | "protocol-error"
    | "control"
    | "unknown-control";
}

/** 通道 0 允许录制（业务帧）的 JSON 消息：A.2 的 `open` / `reveal`。 */
const RECORDED_CONTROL_TYPES: ReadonlySet<string> = new Set(["open", "reveal"]);

/** 通道 0 明确不录的消息（握手/保活/错误/控制/应答）。 */
const UNRECORDED_CONTROL_TYPES: ReadonlyMap<string, FrameRecordingDecision["reason"]> = new Map([
  ["hello", "handshake"],
  ["welcome", "handshake"],
  ["ping", "keepalive"],
  ["pong", "keepalive"],
  ["error", "protocol-error"],
  ["response", "control"],
  ["debugSetEnabled", "control"],
  ["debugEnabled", "control"],
]);

/** 二进制载荷头的方法号（A.4）：`1` = Create、`2` = Finish，`10+` 分类方法。 */
const BINARY_METHOD_ID_BYTES = 2;
const BINARY_CREATE_METHOD_ID = 1;
const BINARY_FINISH_METHOD_ID = 2;
const FIRST_CATEGORY_METHOD_ID = 10;

/**
 * 入站帧是否录制（唯一判定点）。
 *
 * - 通道 1 是**数据面**：解码之前无法（也不应该）判断消息是否合法，一律原样录制；
 *   坏帧留给回看端计数（"帧坏只计数"）。
 * - 通道 0 只录业务帧 `open` / `reveal`；握手、保活、错误与 `debugEnabled` 控制广播不录。
 *   `ping` / `pong` 更早一层：它们在 {@link BridgeSocket} 的接收循环里已被消化，根本到不了
 *   本函数（见 `bridgeSocket.ts` 的 `classifyKeepAlive`）。
 */
export function shouldRecordInboundFrame(
  channel: number,
  payloadKind: BridgePayloadKind,
  payload: Uint8Array,
): FrameRecordingDecision {
  if (channel === BridgeChannel.Debug) {
    return {
      record: true,
      messageType: debugMessageTypeOf(payloadKind, payload),
      reason: "debug-data",
    };
  }

  if (channel !== BridgeChannel.Control) {
    return { record: false, messageType: undefined, reason: "unknown-control" };
  }

  const type = jsonTypeOf(payloadKind, payload);
  if (type === undefined) {
    return { record: false, messageType: undefined, reason: "unknown-control" };
  }

  if (RECORDED_CONTROL_TYPES.has(type)) {
    return { record: true, messageType: type, reason: "editor-operation" };
  }

  return { record: false, messageType: type, reason: UNRECORDED_CONTROL_TYPES.get(type) ?? "unknown-control" };
}

/** 通道 1 消息名（仅用于诊断/报告；二进制按 A.4 的方法号归类）。 */
export function debugMessageTypeOf(payloadKind: BridgePayloadKind, payload: Uint8Array): string | undefined {
  if (payloadKind === BridgePayloadKind.Binary) {
    if (payload.length < BINARY_METHOD_ID_BYTES) {
      return undefined;
    }

    const methodId = (payload[0]! << 8) | payload[1]!;
    if (methodId === BINARY_CREATE_METHOD_ID) {
      return "Create";
    }

    if (methodId === BINARY_FINISH_METHOD_ID) {
      return "Finish";
    }

    return methodId >= FIRST_CATEGORY_METHOD_ID ? "debug" : undefined;
  }

  return jsonTypeOf(payloadKind, payload);
}

function jsonTypeOf(payloadKind: BridgePayloadKind, payload: Uint8Array): string | undefined {
  if (payloadKind !== BridgePayloadKind.Json) {
    return undefined;
  }

  try {
    const value: unknown = JSON.parse(Buffer.from(payload).toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }

    const type = (value as Record<string, unknown>).type;
    return typeof type === "string" ? type : undefined;
  } catch {
    return undefined;
  }
}

/** 把一帧编码成线上字节（6 字节头 + 载荷）；超限时抛 `BridgeFrameError`（调用方计数后丢弃）。 */
export function encodeRawFrame(channel: number, payloadKind: BridgePayloadKind, payload: Buffer): Buffer {
  return encodeFrame(channel as BridgeChannel, payloadKind, payload);
}

/**
 * CRC-32/ISO-HDLC（与 zlib/PNG 同表）：初值 `0xffffffff`、反射、xorout `0xffffffff`。
 * 自己实现而不依赖 `node:zlib` 的新 API，保证格式在 Node 版本间稳定、单测可直接核对已知向量。
 */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

const CRC32_TABLE = buildCrc32Table();

function buildCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? (0xedb88320 ^ (value >>> 1)) >>> 0 : value >>> 1;
    }

    table[index] = value >>> 0;
  }

  return table;
}

/** 编码一个块：块头 + zlib 压缩的载荷。 */
export function encodeRecordBlock(type: DebugRecordingBlockType, payload: Uint8Array): Buffer {
  const compressed = deflateSync(payload);
  if (compressed.length > DEBUG_RECORDING_MAX_COMPRESSED_BYTES) {
    throw new DebugRecordingError("recording.corruptBlock", `Compressed block is ${compressed.length} bytes.`);
  }

  const header = Buffer.alloc(DEBUG_RECORD_BLOCK_HEADER_BYTES);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(compressed.length, 1);
  header.writeUInt32BE(crc32(payload), 5);
  return Buffer.concat([header, compressed]);
}

/** 序列化文件头 JSON（块载荷）。 */
export function encodeRecordingHeader(header: DebugRecordingHeader): Buffer {
  return Buffer.from(`${JSON.stringify(header)}\n`, "utf8");
}

/** 序列化文件尾 JSON（块载荷）。 */
export function encodeRecordingFooter(footer: DebugRecordingFooter): Buffer {
  return Buffer.from(`${JSON.stringify(footer)}\n`, "utf8");
}

/** 解析并校验文件头；字段缺失/类型不符/版本不符都拒绝（不做迁移）。 */
export function parseRecordingHeader(payload: Uint8Array): DebugRecordingHeader {
  const value = parseJsonObject(payload, "recording.invalidHeader", "file header");
  const recordVersion = requireInteger(value, "recordVersion", "recording.invalidHeader");
  if (recordVersion !== DEBUG_RECORD_VERSION) {
    throw new DebugRecordingError(
      "recording.unsupportedVersion",
      `Unsupported recordVersion ${String(recordVersion)}; expected ${DEBUG_RECORD_VERSION}.`,
    );
  }

  const connectType = value.connectType;
  if (connectType !== "editor" && connectType !== "editor-player" && connectType !== "player") {
    throw new DebugRecordingError("recording.invalidHeader", `Invalid connectType ${String(connectType)}.`);
  }

  const contracts = value.contracts;
  return {
    recordVersion,
    protocolVersion: requireInteger(value, "protocolVersion", "recording.invalidHeader"),
    contractSchemaVersion: requireInteger(value, "contractSchemaVersion", "recording.invalidHeader"),
    contractHash: requireString(value, "contractHash", "recording.invalidHeader"),
    sessionId: requireString(value, "sessionId", "recording.invalidHeader"),
    endpointId: requireString(value, "endpointId", "recording.invalidHeader"),
    bootId: requireString(value, "bootId", "recording.invalidHeader"),
    connectType,
    startedAt: requireString(value, "startedAt", "recording.invalidHeader"),
    contracts: contracts === null || contracts === undefined ? null : parseRecordedContracts(contracts),
  };
}

/** 解析并校验文件尾。 */
export function parseRecordingFooter(payload: Uint8Array): DebugRecordingFooter {
  const value = parseJsonObject(payload, "recording.invalidFooter", "file footer");
  const endedReason = value.endedReason;
  if (endedReason !== "disconnect" && endedReason !== "sizeLimit") {
    throw new DebugRecordingError("recording.invalidFooter", `Invalid endedReason ${String(endedReason)}.`);
  }

  return {
    records: requireInteger(value, "records", "recording.invalidFooter"),
    wireBytes: requireInteger(value, "wireBytes", "recording.invalidFooter"),
    droppedRecords: requireInteger(value, "droppedRecords", "recording.invalidFooter"),
    droppedBytes: requireInteger(value, "droppedBytes", "recording.invalidFooter"),
    endedAt: requireString(value, "endedAt", "recording.invalidFooter"),
    endedReason,
  };
}

function parseRecordedContracts(value: unknown): RecordedDebugContracts {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DebugRecordingError("recording.invalidHeader", "contracts must be an object or null.");
  }

  const record = value as Record<string, unknown>;
  const methods = record.methods;
  if (!Array.isArray(methods)) {
    throw new DebugRecordingError("recording.invalidHeader", "contracts.methods must be an array.");
  }

  const conflicts = record.conflicts;
  if (conflicts !== undefined && !Array.isArray(conflicts)) {
    throw new DebugRecordingError("recording.invalidHeader", "contracts.conflicts must be an array when present.");
  }

  return {
    contractHash: requireString(record, "contractHash", "recording.invalidHeader"),
    schemaVersion: requireInteger(record, "schemaVersion", "recording.invalidHeader"),
    hasPrimary: record.hasPrimary === true,
    methods: methods.map((method) => parseRecordedMethod(method)),
    conflicts: (conflicts ?? []).map((conflict) => parseRecordedConflict(conflict)),
  };
}

function parseRecordedConflict(value: unknown): RecordedDebugConflict {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DebugRecordingError("recording.invalidHeader", "contracts.conflicts[] must be objects.");
  }

  const record = value as Record<string, unknown>;
  if (record.kind !== "interface" && record.kind !== "method") {
    throw new DebugRecordingError("recording.invalidHeader", `Invalid contract conflict kind ${String(record.kind)}.`);
  }

  return {
    kind: record.kind,
    key: requireString(record, "key", "recording.invalidHeader"),
    ...(typeof record.category === "string" ? { category: record.category } : {}),
    ...(typeof record.methodId === "number" && Number.isSafeInteger(record.methodId) ? { methodId: record.methodId } : {}),
  };
}

function parseRecordedMethod(value: unknown): RecordedDebugMethod {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DebugRecordingError("recording.invalidHeader", "contracts.methods[] must be objects.");
  }

  const record = value as Record<string, unknown>;
  const parameters = record.parameters;
  if (!Array.isArray(parameters)) {
    throw new DebugRecordingError("recording.invalidHeader", "contracts method.parameters must be an array.");
  }

  return {
    category: requireString(record, "category", "recording.invalidHeader"),
    interfaceId: requireString(record, "interfaceId", "recording.invalidHeader"),
    interfaceFullName: requireString(record, "interfaceFullName", "recording.invalidHeader"),
    name: requireString(record, "name", "recording.invalidHeader"),
    methodId: requireInteger(record, "methodId", "recording.invalidHeader"),
    kind: requireString(record, "kind", "recording.invalidHeader"),
    parameters: parameters.map((parameter) => parseRecordedParameter(parameter)),
    result: record.result === undefined || record.result === null
      ? undefined
      : parseRecordedParameter(record.result),
  };
}

function parseRecordedParameter(value: unknown): RecordedDebugParameter {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DebugRecordingError("recording.invalidHeader", "contracts parameter must be an object.");
  }

  const record = value as Record<string, unknown>;
  const width = record.enumWidth;
  if (width !== undefined && width !== null && width !== 1 && width !== 2 && width !== 4 && width !== 8) {
    throw new DebugRecordingError("recording.invalidHeader", `Invalid enumWidth ${String(width)}.`);
  }

  return {
    tag: requireInteger(record, "tag", "recording.invalidHeader"),
    name: requireString(record, "name", "recording.invalidHeader"),
    declaredType: requireString(record, "declaredType", "recording.invalidHeader"),
    wireType: requireString(record, "wireType", "recording.invalidHeader"),
    enumName: typeof record.enumName === "string" ? record.enumName : undefined,
    enumWidth: width === undefined || width === null ? undefined : width,
    optional: record.optional === true,
  };
}

function parseJsonObject(
  payload: Uint8Array,
  code: DebugRecordingErrorCode,
  label: string,
): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(payload).toString("utf8"));
  } catch (errorValue) {
    throw new DebugRecordingError(code, `${label} is not valid JSON: ${String(errorValue)}`);
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DebugRecordingError(code, `${label} must be a JSON object.`);
  }

  return value as Record<string, unknown>;
}

function requireInteger(record: Record<string, unknown>, key: string, code: DebugRecordingErrorCode): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new DebugRecordingError(code, `'${key}' must be an integer, received ${String(value)}.`);
  }

  return value;
}

function requireString(record: Record<string, unknown>, key: string, code: DebugRecordingErrorCode): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new DebugRecordingError(code, `'${key}' must be a string, received ${String(value)}.`);
  }

  return value;
}
