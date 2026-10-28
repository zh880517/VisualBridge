/**
 * 契约快照的序列化/反序列化（录制文件头的 `contracts` 字段）。
 *
 * **规范措辞说明（P2-10）**：附录 C.6 写的是"存合并契约原文"，而本实现存的是**归一化子集**。
 * 原因是 F1 不保留源字节（只保留合并结果），运行时无法再拿到"原文"；本文件存的就是那份合并
 * 结果的规范化字段，语义等价。G2 会据此处修正 C.6 的措辞，本任务**不改规范**、也不改实现。
 *
 * F1 的 {@link DebugContractSnapshot} 是"合并后的规范化结果"：方法号、参数 tag/名字/声明类型/
 * 线上类型/枚举宽度都在里面，足以在没有工作区契约的情况下按同一套规则解码（C.8：
 * 回看以文件内快照为准）。因此录制时序列化它、回看时用
 * {@link snapshotFromRecordedContracts} 直接重建，**不读磁盘、不重新合并**——
 * 否则"录制后改了契约再回看"会得到与在线不同的参数名（P0 验收项）。
 *
 * 文件头**不**保存的字段（F5-03：评审确认验收项成立，这里逐项说明为何不影响回看；
 * 这些字段在线解码/展示链路本来也不消费）：
 * - `skipped`（目录/原因/详情）：加载期诊断；回看不重新加载契约，无法也无需复现。
 * - 来源计数与路径（`directory` / `file` / `interfaces` / `methods` / `supplemental[]`）：
 *   只用于"契约从哪来"的诊断面板；回看只需要 `hasPrimary` 布尔（决定二进制未知方法
 *   按"约定产物在手"丢弃还是走通用视图）与 `contractHash` / `schemaVersion` 做展示。
 * - 枚举成员表（`enums[].members` 的名字/值）：在线链路只消费 `enumName` + `enumWidth`
 *   （由 `underlyingType` 归一化），成员名从不参与解码或展示。
 * - `className` / `namespace` / `returnType`：生成期元数据，在线解码与面板都不读。
 * - 冲突的 `detail` / `primaryDirectory` / `supplementalDirectory`：加载期诊断；
 *   回看只需要冲突的 `kind` + `key`（+ 方法冲突的 `category`/`methodId`）来得到
 *   `contractState: "contract-conflict"`，因此只写入这份最小摘要。
 */

import { BRIDGE_CONTRACT_SCHEMA_VERSION } from "./bridgeProtocol";
import {
  DebugContractSnapshot,
  type DebugContractEnumWidth,
  type DebugContractMethod,
  type DebugContractParameter,
  type DebugContractSourceInfo,
  type DebugContractWireType,
} from "./debugContractRegistry";
import type { RecordedDebugContracts, RecordedDebugMethod, RecordedDebugParameter } from "./debugRecordingFormat";

/** 把当前快照序列化成文件头可存的 JSON 结构；没有快照时返回 `null`（= 无契约）。 */
export function serializeRecordedContracts(
  snapshot: DebugContractSnapshot | undefined,
): RecordedDebugContracts | null {
  if (snapshot === undefined) {
    return null;
  }

  return {
    contractHash: snapshot.contractHash,
    schemaVersion: snapshot.schemaVersion ?? BRIDGE_CONTRACT_SCHEMA_VERSION,
    hasPrimary: snapshot.primary !== undefined,
    methods: snapshot.methods.map(recordMethod),
    // 冲突只需最小摘要：回看用 kind/key（+ 方法冲突的 category/methodId）重建
    // `contractState: "contract-conflict"`，目录与 detail 是加载期诊断（F5-03）。
    conflicts: snapshot.conflicts.map((conflict) => ({
      kind: conflict.kind,
      key: conflict.key,
      ...(conflict.category === undefined ? {} : { category: conflict.category }),
      ...(conflict.methodId === undefined ? {} : { methodId: conflict.methodId }),
    })),
  };
}

/**
 * 从文件头重建快照。字段在 {@link parseRecordingHeader} 已做过类型校验；这里只做结构映射。
 * `primary` 是否存在会影响二进制未知方法的处置（`DebugIngress.resolveContract`），因此
 * `hasPrimary` 原样还原成一个最小的来源描述，而不是伪造"没有主来源"。
 */
export function snapshotFromRecordedContracts(recorded: RecordedDebugContracts): DebugContractSnapshot {
  const methods = recorded.methods.map(methodFromRecorded);
  const source: DebugContractSourceInfo = {
    directory: "",
    file: "",
    contractHash: recorded.contractHash,
    schemaVersion: recorded.schemaVersion,
    interfaces: 0,
    methods: methods.length,
    role: recorded.hasPrimary ? "primary" : "supplemental",
  };
  return new DebugContractSnapshot({
    unityRoot: undefined,
    primary: recorded.hasPrimary ? source : undefined,
    supplemental: recorded.hasPrimary ? [] : (methods.length > 0 ? [source] : []),
    // `contract-conflict` 只看 kind/key：目录与 detail 是加载期诊断，回看不复现（F5-03）。
    conflicts: recorded.conflicts.map((conflict) => ({
      kind: conflict.kind,
      key: conflict.key,
      detail: "Recorded contract conflict (source directories are not part of the recording).",
      primaryDirectory: "",
      supplementalDirectory: "",
      ...(conflict.category === undefined ? {} : { category: conflict.category }),
      ...(conflict.methodId === undefined ? {} : { methodId: conflict.methodId }),
    })),
    skipped: [],
    methods,
    contractHash: recorded.contractHash,
    schemaVersion: recorded.schemaVersion,
  });
}

function recordMethod(method: DebugContractMethod): RecordedDebugMethod {
  return {
    category: method.category,
    interfaceId: method.interfaceId,
    interfaceFullName: method.interfaceFullName,
    name: method.name,
    methodId: method.methodId,
    kind: method.kind,
    parameters: method.parameters.map(recordParameter),
    result: method.result === undefined ? undefined : recordParameter(method.result),
  };
}

function recordParameter(parameter: DebugContractParameter): RecordedDebugParameter {
  return {
    tag: parameter.tag,
    name: parameter.name,
    declaredType: parameter.declaredType,
    wireType: parameter.wireType,
    enumName: parameter.enumName,
    enumWidth: parameter.enumWidth,
    optional: parameter.optional,
  };
}

function methodFromRecorded(method: RecordedDebugMethod): DebugContractMethod {
  return {
    category: method.category,
    interfaceId: method.interfaceId,
    interfaceFullName: method.interfaceFullName,
    name: method.name,
    methodId: method.methodId,
    kind: method.kind,
    parameters: method.parameters.map(parameterFromRecorded),
    result: method.result === undefined ? undefined : parameterFromRecorded(method.result),
  };
}

function parameterFromRecorded(parameter: RecordedDebugParameter): DebugContractParameter {
  return {
    tag: parameter.tag,
    name: parameter.name,
    declaredType: parameter.declaredType,
    // 文件头的 wireType 是字符串（JSON 无枚举）；重建时按契约类型收窄。
    wireType: parameter.wireType as DebugContractWireType,
    enumName: parameter.enumName,
    enumWidth: parameter.enumWidth as DebugContractEnumWidth | undefined,
    optional: parameter.optional,
  };
}
