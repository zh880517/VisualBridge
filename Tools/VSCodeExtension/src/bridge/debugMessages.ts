/**
 * 调试消息层（附录 A.2/A.4/A.5）：通道 1 的七种消息与通道 1 的 `response` 的编解码，
 * 以及二进制槽位路由 `instanceSlot → 实例 → category`。
 *
 * 职责边界：
 * - 只做「字节 ↔ 信封」，不做实例存储、契约解析、面板展示（F1/F2/F3）；
 * - 二进制参数区自带 `type`，因此除 `enum` 外无需契约即可解码；`enum` 的宽度按契约
 *   `underlyingType` 决定（A.4），拿不到契约时整条消息按「未知方法」丢弃并计数；
 * - 未知槽位、未知方法一律返回失败结果而不是抛异常（调用方计数后丢弃，不断连）。
 */

import { BridgePayloadKind } from "./framing";

/**
 * 分类方法号段起点（附录 A.4）：`0` = None、`1`/`2` = Create/Finish、`3–9` 预留系统、`10+` 分类方法。
 * 与 C# 的 `VisualBridgeDebugMethodIdRange.FirstCategoryMethodId` 同值；查询信封的 `methodId`
 * 低于它按 `invalidRequest` 拒绝（C# 侧对应 `invalid-method-id`）。
 */
const FIRST_CATEGORY_METHOD_ID = 10;

/** A.4 的 type 码表（与 C# 侧 `VisualBridgeDebugWireType` 同一张表）。 */
export enum DebugWireType {
  None = 0,
  Bool = 1,
  Int = 2,
  Long = 3,
  Ulong = 4,
  Float = 5,
  Double = 6,
  Enum = 7,
  String = 8,
  ByteArray = 9,
}

/** 二进制里的一个载荷参数：`tag + type + value`，按 tag 升序到达（A.4）。 */
export interface DebugArg {
  readonly tag: number;
  readonly name?: string;
  readonly type: string;
  readonly value: unknown;
}

/** 槽位绑定：`Create` 建立，`debugFinish` 或断连移除（A.4/C.3）。 */
export interface DebugSlotBinding {
  readonly instance: string;
  readonly category: string;
}

export interface DebugCreateMessage {
  readonly kind: "debugCreate";
  readonly category: string;
  readonly instance: string;
  readonly instanceSlot: number;
  readonly resName: string;
  readonly debugInfo: string;
}

export interface DebugFinishMessage {
  readonly kind: "debugFinish";
  readonly category: string | undefined;
  readonly instance: string;
}

export interface DebugFrameMessage {
  readonly kind: "debugFrame";
  readonly frame: number;
}

export interface DebugEventMessage {
  readonly kind: "debug";
  readonly category: string | undefined;
  readonly instance: string | undefined;
  readonly instanceSlot: number;
  readonly methodId: number;
  readonly iface: string | undefined;
  readonly method: string | undefined;
  readonly args: readonly DebugArg[];
}

export interface DebugResultMessage {
  readonly kind: "debugResult";
  readonly category: string | undefined;
  readonly instance: string | undefined;
  readonly instanceSlot: number;
  readonly methodId: number;
  readonly iface: string | undefined;
  readonly method: string | undefined;
  readonly requestId: string;
  readonly args: readonly DebugArg[];
}

export interface DebugRequestMessage {
  readonly kind: "request";
  readonly requestId: string;
  readonly action: "debugQuery";
  readonly category?: string;
  readonly instance: string;
  readonly iface?: string;
  readonly method?: string;
  /**
   * 方法号（附录 A.5）：与二进制信封载荷头的 `u16 methodId` 同一语义，分类方法从 `10` 起。
   * JSON 信封必须带它——`method` / `iface` 只是名字，服务端的分发与参数声明表都只认方法号。
   */
  readonly methodId: number;
  readonly args: readonly DebugArg[];
}

export interface DebugResponseMessage {
  readonly kind: "response";
  readonly requestId: string;
  readonly ok: boolean;
  readonly code?: string;
  readonly detail?: string;
}

/**
 * 通道 1 `response` 的公开错误码（附录 A.6 的查询子集，E6 登记）。
 * `runtime.queryRejected` 是**业务拒绝**的码：业务实现 `RejectRequest` 主动拒绝、生成的 Dispatcher
 * 捕获业务异常后拒绝、handler 返回 false 且未回发结果（含非生成处理器抛异常，由运行期兜底）三条路径
 * 都回它，可区分的原因在 `detail`（`handler-returned-false`、`handler-exception: <异常类型>`、
 * 以及业务自定义原因）。本清单与 C# 的 `VisualBridgeDebugQueryErrors` 一一对应，由 `check:protocol` 双向核对。
 */
export const DEBUG_QUERY_ERROR_CODES = [
  "runtime.instanceNotFound",
  "runtime.invalidArgument",
  "runtime.queryBusy",
  "runtime.queryRejected",
  "runtime.queryTimeout",
  "runtime.queryUnregistered",
] as const;

export type DebugQueryErrorCode = (typeof DEBUG_QUERY_ERROR_CODES)[number];

/** 线上拿到的 `code` 是否属于 A.6 的查询错误码（客户端据此决定是否映射成 UI 文案）。 */
export function isDebugQueryErrorCode(value: string | undefined): value is DebugQueryErrorCode {
  return value !== undefined && (DEBUG_QUERY_ERROR_CODES as readonly string[]).includes(value);
}

/** `dropped` 的累计计数（A.5，E4 定稿）。 */
export interface DebugDroppedMessage {
  readonly kind: "dropped";
  readonly filteredByServer: number;
  readonly unknownMethod: number;
  readonly unknownSlot: number;
  readonly invalidRequest: number;
  readonly encodeFailed: number;
  readonly oversize: number;
  readonly queueOverflow: number;
}

export type DebugEnvelope =
  | DebugCreateMessage
  | DebugFinishMessage
  | DebugFrameMessage
  | DebugEventMessage
  | DebugResultMessage
  | DebugRequestMessage
  | DebugResponseMessage
  | DebugDroppedMessage;

export type DebugDecodeFailureReason =
  | "unknownSlot"
  | "unknownMethod"
  | "invalidRequest"
  | "ambiguousEnvelope"
  | "malformed";

export type DebugDecodeResult =
  | { readonly ok: true; readonly message: DebugEnvelope }
  | { readonly ok: false; readonly reason: DebugDecodeFailureReason; readonly detail: string };

export interface DebugDecodeContext {
  /** 槽位 → 绑定；未知槽位返回 undefined，解码按 unknownSlot 丢弃并计数。 */
  readonly resolveSlot: (instanceSlot: number) => DebugSlotBinding | undefined;
  /** 枚举参数宽度（1/2/4/8 字节，按契约 underlyingType）；缺省时含枚举的载荷按 unknownMethod 丢弃。 */
  readonly resolveEnumWidth?: (category: string | undefined, methodId: number, tag: number) => 1 | 2 | 4 | 8 | undefined;
  /**
   * **二进制路径必需**：A.4 的信封不带「debug 还是 debugResult」的标志位，`debugResult` 只在
   * `methodId + instanceSlot` 之后多一个 `u32 requestId`。解码器用挂起表判定该 u32 是否为请求号；
   * 缺少本回调（且没有 {@link isKnownRequest}）时二进制载荷一律返回 `ambiguousEnvelope` 失败，
   * 绝不把请求号当参数区静默解析。
   */
  readonly isPendingRequest?: (requestId: number) => boolean;
  /**
   * **已知请求号**（在途 + 已结算/已作废）：与 {@link isPendingRequest} 同时给出时本回调优先。
   * 存在的意义是**晚到结果**：请求超时/结算后已不在挂起表里，只查挂起表会把它的 `u32 requestId`
   * 当成参数区解出垃圾，或按 `unknownMethod` 丢掉一条本可按 `requestId` 关联进流的结果（A.5）。
   * 消费端据此仍把它解成 `debugResult`，再由查询客户端判定「已完成 / 已超时」。
   */
  readonly isKnownRequest?: (requestId: number) => boolean;
}

/** 槽位路由表：`Create` 建立、`debugFinish` 与断连立即失效（A.4/A.9）。 */
export class DebugSlotRegistry {
  private readonly slots = new Map<number, DebugSlotBinding>();

  public get size(): number {
    return this.slots.size;
  }

  public register(instance: string, category: string, instanceSlot: number): void {
    this.slots.set(instanceSlot, { instance, category });
  }

  public resolve(instanceSlot: number): DebugSlotBinding | undefined {
    return this.slots.get(instanceSlot);
  }

  /** `debugFinish` 按实例 id 移除；槽位未知时按槽位兜底移除。 */
  public finish(instance: string | undefined, instanceSlot?: number): void {
    if (instance !== undefined) {
      for (const [slot, binding] of this.slots) {
        if (binding.instance === instance) {
          this.slots.delete(slot);
        }
      }

      return;
    }

    if (instanceSlot !== undefined) {
      this.slots.delete(instanceSlot);
    }
  }

  public clear(): void {
    this.slots.clear();
  }
}

/** 解码一条通道 1 载荷；失败结果由调用方按 reason 计数（未知槽位/未知方法/畸形）。 */
export function decodeDebugEnvelope(
  payloadKind: BridgePayloadKind,
  payload: Buffer,
  context: DebugDecodeContext,
): DebugDecodeResult {
  if (payloadKind === BridgePayloadKind.Binary) {
    try {
      return decodeBinary(payload, context);
    } catch (error) {
      // 载荷在参数中间截断：按畸形丢弃并计数，不抛给连接读循环（不断连）。
      return { ok: false, reason: "malformed", detail: (error as Error).message };
    }
  }

  return decodeJson(payload);
}

/** 编码一条 `request`（通道 1，JSON；A.5 的唯一入站消息）。 */
export function encodeDebugRequest(request: DebugRequestMessage): Buffer {
  // 键顺序按附录 A.5 的字段清单（type/requestId/action/category/instance/iface/method/methodId/args）。
  // 本函数是 `request` 信封的**唯一**序列化入口（C# 侧只解析、不生产），对象→字节只有这一条路径；
  // 键顺序由对象字面量的插入顺序固定（`JSON.stringify` 不排序键），跨语言靠两侧共享的 fixture 锁字节。
  // 该信封不参与任何 hash / 契约指纹计算。
  const value: Record<string, unknown> = {
    type: "request",
    requestId: request.requestId,
    action: request.action,
  };
  if (request.category !== undefined) {
    value.category = request.category;
  }

  value.instance = request.instance;
  if (request.iface !== undefined) {
    value.iface = request.iface;
  }

  if (request.method !== undefined) {
    value.method = request.method;
  }

  value.methodId = request.methodId;

  if (request.args.length !== 0) {
    value.args = request.args.map((arg) => encodeJsonArg(arg));
  }

  return Buffer.from(JSON.stringify(value), "utf8");
}

/** 编码一条 `debugFrame`（通道 1，JSON，控制类）：连接建立后先发当前值，空帧不发（A.5）。 */
export function encodeDebugFrame(frame: number): Buffer {
  return Buffer.from(JSON.stringify({ type: "debugFrame", frame }), "utf8");
}

function encodeJsonArg(arg: DebugArg): Record<string, unknown> {
  const value: Record<string, unknown> = { tag: arg.tag };
  if (arg.name !== undefined) {
    value.name = arg.name;
  }

  value.type = arg.type;
  value.value = arg.value;
  return value;
}

function decodeJson(payload: Buffer): DebugDecodeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.toString("utf8"));
  } catch (error) {
    return { ok: false, reason: "malformed", detail: `invalid json: ${(error as Error).message}` };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "malformed", detail: "payload is not a json object" };
  }

  const record = parsed as Record<string, unknown>;
  const type = readString(record, "type");
  switch (type) {
    case "debugCreate":
      return {
        ok: true,
        message: {
          kind: "debugCreate",
          category: readString(record, "category") ?? "",
          instance: readString(record, "instance") ?? "",
          instanceSlot: readNumber(record, "instanceSlot") ?? 0,
          resName: readString(record, "resName") ?? "",
          debugInfo: readString(record, "debugInfo") ?? "",
        },
      };
    case "debugFinish":
      return {
        ok: true,
        message: {
          kind: "debugFinish",
          category: readString(record, "category"),
          instance: readString(record, "instance") ?? "",
        },
      };
    case "debugFrame": {
      const frame = readNumber(record, "frame");
      if (frame === undefined) {
        return { ok: false, reason: "malformed", detail: "debugFrame without frame" };
      }

      return { ok: true, message: { kind: "debugFrame", frame } };
    }
    case "debug":
    case "debugResult": {
      const requestId = readString(record, "requestId");
      const args = readJsonArgs(record);
      if (args === undefined) {
        return { ok: false, reason: "malformed", detail: `${type} args is not an array` };
      }

      const common = {
        category: readString(record, "category"),
        instance: readString(record, "instance"),
        instanceSlot: 0,
        methodId: 0,
        iface: readString(record, "iface"),
        method: readString(record, "method"),
        args,
      };
      if (type === "debugResult") {
        if (requestId === undefined) {
          return { ok: false, reason: "malformed", detail: "debugResult without requestId" };
        }

        return { ok: true, message: { kind: "debugResult", ...common, requestId } };
      }

      return { ok: true, message: { kind: "debug", ...common } };
    }
    case "dropped":
      return {
        ok: true,
        message: {
          kind: "dropped",
          filteredByServer: readNumber(record, "filteredByServer") ?? 0,
          unknownMethod: readNumber(record, "unknownMethod") ?? 0,
          unknownSlot: readNumber(record, "unknownSlot") ?? 0,
          invalidRequest: readNumber(record, "invalidRequest") ?? 0,
          encodeFailed: readNumber(record, "encodeFailed") ?? 0,
          oversize: readNumber(record, "oversize") ?? 0,
          queueOverflow: readNumber(record, "queueOverflow") ?? 0,
        },
      };
    case "request": {
      const requestId = readString(record, "requestId");
      const instance = readString(record, "instance");
      if (requestId === undefined || instance === undefined) {
        return { ok: false, reason: "invalidRequest", detail: "request without requestId/instance" };
      }

      if (record.action !== "debugQuery") {
        return { ok: false, reason: "invalidRequest", detail: "request with an unknown action" };
      }

      // A.5：JSON 信封必须带方法号（与二进制载荷头的 u16 同一语义），`method` 只是诊断。
      // 号段见 A.4：0 = None、1/2 = Create/Finish、3–9 预留、10+ 分类方法。C# 侧对 < 10 回
      // `invalid-method-id`（E6），客户端也拒绝保留号段：不把必然被服务端拒的请求发出去。
      const rawMethodId = record.methodId;
      if (typeof rawMethodId !== "number" || !Number.isInteger(rawMethodId) || rawMethodId > 0xffff) {
        return { ok: false, reason: "invalidRequest", detail: "request without a u16 methodId" };
      }

      if (rawMethodId < FIRST_CATEGORY_METHOD_ID) {
        return {
          ok: false,
          reason: "invalidRequest",
          detail: `request methodId ${rawMethodId} is in the reserved 0-9 range`,
        };
      }

      const args = readJsonArgs(record);
      if (args === undefined) {
        return { ok: false, reason: "invalidRequest", detail: "request args is not an array" };
      }

      const category = readString(record, "category");
      const iface = readString(record, "iface");
      const method = readString(record, "method");
      return {
        ok: true,
        message: {
          kind: "request",
          requestId,
          action: "debugQuery",
          instance,
          methodId: rawMethodId,
          ...(category === undefined ? {} : { category }),
          ...(iface === undefined ? {} : { iface }),
          ...(method === undefined ? {} : { method }),
          args,
        },
      };
    }
    case "response": {
      const requestId = readString(record, "requestId");
      if (requestId === undefined) {
        return { ok: false, reason: "malformed", detail: "response without requestId" };
      }

      const code = readString(record, "code");
      const detail = readString(record, "detail");
      return {
        ok: true,
        message: {
          kind: "response",
          requestId,
          ok: record.ok === true,
          ...(code === undefined ? {} : { code }),
          ...(detail === undefined ? {} : { detail }),
        },
      };
    }
    default:
      return { ok: false, reason: "malformed", detail: `unknown message type '${type ?? ""}'` };
  }
}

function readJsonArgs(record: Record<string, unknown>): readonly DebugArg[] | undefined {
  const raw = record.args;
  if (raw === undefined) {
    return [];
  }

  if (!Array.isArray(raw)) {
    return undefined;
  }

  const args: DebugArg[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return undefined;
    }

    const arg = item as Record<string, unknown>;
    const tag = readNumber(arg, "tag");
    const type = readString(arg, "type");
    if (tag === undefined || type === undefined) {
      return undefined;
    }

    const name = readString(arg, "name");
    args.push({ tag, type, value: arg.value, ...(name === undefined ? {} : { name }) });
  }

  return args;
}

/**
 * 解码二进制载荷（A.4）：`u16 methodId + u16 instanceSlot [+ u32 requestId] + 参数区`。
 * methodId `1`/`2` 是 `Create`/`Finish`（固定 tag 表，不查契约），`3–9` 预留、`10+` 分类方法。
 * 槽位未知 → unknownSlot；枚举参数缺少契约宽度 → unknownMethod（拿不到契约就无法确定参数边界）。
 */
function decodeBinary(payload: Buffer, context: DebugDecodeContext): DebugDecodeResult {
  if (payload.length < 4) {
    return { ok: false, reason: "malformed", detail: "binary payload shorter than the 4-byte header" };
  }

  const methodId = payload.readUInt16BE(0);
  const instanceSlot = payload.readUInt16BE(2);
  if (methodId === 1 || methodId === 2) {
    return decodeFixedTagMessage(payload, methodId === 1, instanceSlot);
  }

  if (methodId < 0x000a) {
    // 0 = None、3–9 预留：都不是分类方法号。
    return { ok: false, reason: "unknownMethod", detail: `reserved methodId ${methodId}` };
  }

  const binding = context.resolveSlot(instanceSlot);
  if (binding === undefined) {
    return { ok: false, reason: "unknownSlot", detail: `unknown instanceSlot ${instanceSlot}` };
  }

  // 已知请求号优先：只用挂起表时，超时/已结算请求的晚到结果会退化成 `debug` 事件（解出垃圾参数
  // 或按 unknownMethod 丢弃）；`isKnownRequest` 让这类结果仍按 requestId 关联进流（A.5）。
  const isKnownRequest = context.isKnownRequest ?? context.isPendingRequest;
  if (isKnownRequest === undefined) {
    // 没有挂起表就无法判断第 5–8 字节是请求号还是参数，宁可明确失败也不静默错解（A.4）。
    return {
      ok: false,
      reason: "ambiguousEnvelope",
      detail: "binary payload needs context.isPendingRequest or context.isKnownRequest to tell debug from debugResult",
    };
  }

  if (payload.length >= 8) {
    const rawRequestId = payload.readUInt32BE(4);
    if (rawRequestId !== 0 && isKnownRequest(rawRequestId)) {
      const requestId = `req-${rawRequestId}`;
      const args = decodeParameterArea(payload, 8, binding.category, methodId, context);
      if (typeof args === "string") {
        return { ok: false, reason: "unknownMethod", detail: args };
      }

      return {
        ok: true,
        message: {
          kind: "debugResult",
          category: binding.category,
          instance: binding.instance,
          instanceSlot,
          methodId,
          iface: undefined,
          method: undefined,
          requestId,
          args,
        },
      };
    }
  }

  const args = decodeParameterArea(payload, 4, binding.category, methodId, context);
  if (typeof args === "string") {
    return { ok: false, reason: "unknownMethod", detail: args };
  }

  return {
    ok: true,
    message: {
      kind: "debug",
      category: binding.category,
      instance: binding.instance,
      instanceSlot,
      methodId,
      iface: undefined,
      method: undefined,
      args,
    },
  };
}

/** `Create`/`Finish` 的固定 tag 表（A.4）：`Create` 0 category / 1 instanceId / 2 resName / 3 debugInfo；`Finish` 0 instanceId。 */
function decodeFixedTagMessage(payload: Buffer, isCreate: boolean, instanceSlot: number): DebugDecodeResult {
  const fields = new Map<number, string>();
  let cursor = 4;
  while (cursor < payload.length) {
    if (cursor + 3 > payload.length) {
      return { ok: false, reason: "malformed", detail: `truncated fixed-tag header at ${cursor}` };
    }

    const tag = payload.readUInt16BE(cursor);
    const typeCode = payload.readUInt8(cursor + 2);
    cursor += 3;
    if (typeCode !== DebugWireType.String || cursor + 2 > payload.length) {
      return { ok: false, reason: "malformed", detail: `fixed-tag ${tag} is not a string` };
    }

    const length = payload.readUInt16BE(cursor);
    cursor += 2;
    if (cursor + length > payload.length) {
      return { ok: false, reason: "malformed", detail: `fixed-tag ${tag} is truncated` };
    }

    fields.set(tag, payload.toString("utf8", cursor, cursor + length));
    cursor += length;
  }

  if (isCreate) {
    return {
      ok: true,
      message: {
        kind: "debugCreate",
        category: fields.get(0) ?? "",
        instance: fields.get(1) ?? "",
        instanceSlot,
        resName: fields.get(2) ?? "",
        debugInfo: fields.get(3) ?? "",
      },
    };
  }

  return {
    ok: true,
    message: { kind: "debugFinish", category: undefined, instance: fields.get(0) ?? "" },
  };
}

/** 参数区（稀疏）：`u16 tag + u8 type + value`，按 tag 升序。返回失败原因字符串表示丢弃。 */
function decodeParameterArea(
  payload: Buffer,
  offset: number,
  category: string,
  methodId: number,
  context: DebugDecodeContext,
): readonly DebugArg[] | string {
  const args: DebugArg[] = [];
  let cursor = offset;
  while (cursor < payload.length) {
    if (cursor + 3 > payload.length) {
      return `truncated parameter header at ${cursor}`;
    }

    const tag = payload.readUInt16BE(cursor);
    const typeCode = payload.readUInt8(cursor + 2);
    cursor += 3;

    const decoded = decodeValue(payload, cursor, typeCode, category, methodId, tag, context);
    if (typeof decoded === "string") {
      return decoded;
    }

    args.push({ tag, type: decoded.type, value: decoded.value });
    cursor = decoded.next;
  }

  return args;
}

function decodeValue(
  payload: Buffer,
  offset: number,
  typeCode: number,
  category: string,
  methodId: number,
  tag: number,
  context: DebugDecodeContext,
): { readonly type: string; readonly value: unknown; readonly next: number } | string {
  switch (typeCode) {
    case DebugWireType.Bool:
      ensureBytes(payload, offset, 1);
      return { type: "bool", value: payload.readUInt8(offset) !== 0, next: offset + 1 };
    case DebugWireType.Int:
      ensureBytes(payload, offset, 4);
      return { type: "int", value: payload.readInt32BE(offset), next: offset + 4 };
    case DebugWireType.Long:
      ensureBytes(payload, offset, 8);
      // long 超出 JS 安全整数范围：与 JSON 表示一致，用十进制字符串（A.4）。
      return { type: "long", value: payload.readBigInt64BE(offset).toString(10), next: offset + 8 };
    case DebugWireType.Ulong:
      ensureBytes(payload, offset, 8);
      return { type: "ulong", value: payload.readBigUInt64BE(offset).toString(10), next: offset + 8 };
    case DebugWireType.Float:
      ensureBytes(payload, offset, 4);
      return { type: "float", value: payload.readFloatBE(offset), next: offset + 4 };
    case DebugWireType.Double:
      ensureBytes(payload, offset, 8);
      return { type: "double", value: payload.readDoubleBE(offset), next: offset + 8 };
    case DebugWireType.Enum: {
      const width = context.resolveEnumWidth?.(category, methodId, tag);
      if (width === undefined) {
        return `enum width unknown for (${category}, ${methodId}) tag ${tag}`;
      }

      ensureBytes(payload, offset, width);
      let value: number | string;
      switch (width) {
        case 1:
          value = payload.readInt8(offset);
          break;
        case 2:
          value = payload.readInt16BE(offset);
          break;
        case 4:
          value = payload.readInt32BE(offset);
          break;
        default:
          value = payload.readBigInt64BE(offset).toString(10);
          break;
      }

      return { type: "enum", value, next: offset + width };
    }
    case DebugWireType.String: {
      ensureBytes(payload, offset, 2);
      const length = payload.readUInt16BE(offset);
      ensureBytes(payload, offset + 2, length);
      return {
        type: "string",
        value: payload.toString("utf8", offset + 2, offset + 2 + length),
        next: offset + 2 + length,
      };
    }
    case DebugWireType.ByteArray: {
      ensureBytes(payload, offset, 4);
      const length = payload.readUInt32BE(offset);
      ensureBytes(payload, offset + 4, length);
      return {
        type: "byte[]",
        value: payload.toString("base64", offset + 4, offset + 4 + length),
        next: offset + 4 + length,
      };
    }
    default:
      return `unknown wire type ${typeCode} for tag ${tag}`;
  }
}

function ensureBytes(payload: Buffer, offset: number, length: number): void {
  if (offset + length > payload.length) {
    throw new RangeError(`payload truncated at ${offset} (need ${length} byte(s))`);
  }
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
