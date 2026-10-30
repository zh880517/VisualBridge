# 附录 C · VS Code 消费契约（固化自草案 C）

> 本附录是消费侧的**唯一契约依据**。标注「回填」的由对应任务实现后写回。

## C.1 数据源与传输接口

```ts
export interface DebugTransport {
  connect(target: DebugTarget): Promise<DebugWelcome>;
  disconnect(): Promise<void>;
  sendQuery(request: DebugQueryRequest, timeoutMs: number): Promise<DebugQueryResult>;
  onEnvelope(listener: (envelope: DebugEnvelope) => void): Disposable;
  onStateChange(listener: (state: DebugConnectionState) => void): Disposable;
  readonly state: DebugConnectionState;
}

export interface DebugSource {
  readonly kind: "network" | "file";
  // 回填：文件源的 open/close 与 network 的 connect/disconnect 的具体形状由 F5 定义
}
```

- `DebugQueryRequest` 与 `DebugQueryClient.query(instanceKey, interfaceId, method, args, options)` 一一对应；`instance`/`category` 取自实例，`methodId` 从契约补齐。
- 收到 `debug` / `debugResult` / `debugCreate` / `debugFinish` → 交给 `DebugIngress`。
- **不做 ack、不维护序号**：读到什么按顺序交给下游。
- 查询挂起表 `requestId(u32) → { resolve, timer }`，上限 **8**（与服务端并发一致；草案 T 曾写 32，已在 2026-10-26 统一为 8）。

## C.2 归一化记录

```ts
export interface DebugRecord {
  readonly id: number;              // 实例内单调序号
  readonly category: string;
  readonly interfaceId: string;
  readonly instanceId: string;      // 协议保证已 Create
  readonly method: string;
  readonly args: ReadonlyMap<number, DebugArgValue>;  // tag → 值，只含线上实际到达的非默认参数
  readonly named: ReadonlyMap<string, DebugArgValue>; // 参数名 → 值，按契约补齐默认值后的完整表
  readonly frame: number;           // 由最近的 debugFrame 推导；-1 表示无帧
  readonly wireBytes: number;       // 载荷字节数，容量记账单位
  readonly receivedAt: number;
  readonly contractState: "matched" | "unknown-interface" | "contract-conflict";
}
```

| 字段 | 来源 | 使用方 | 约束 |
| --- | --- | --- | --- |
| `named` | JSON 自带 `name`；二进制按契约把 `tag` 翻译；**再补齐默认值** | 有状态消费者（模块 `debug` facet） | 只含契约声明过的参数，是完整表；契约缺失/未命中时为空 Map |
| `args` | 两种载荷按到达顺序 | 通用视图、导出、兜底 | 保留原始顺序与 tag；不含默认值；含契约未声明的参数 |

- 值只存一份，`args` 与 `named` 是两种索引。
- `contractState` 不阻止展示，只影响是否标参数名与类型。
- 契约缺失时通用视图标注"仅列出非默认值"；参数名缺失时显示 `arg#<tag>`。

## C.3 实例与包络不变式

- 身份三元组 `(sessionId, category, instance)`；`sessionId` 来自 `welcome`。
- `debugCreate` 每实例一条；`resName` 为空回退为 `instance`；`debugInfo` 原样展示、不解析。
- 槽位映射 `slot → { instance, category }`，`Finish` 或断线时移除。
- 未收到 `Create` 就收到记录：最多暂存 **64 条或 1 秒**，超时按占位实例接收并标 `descriptorMissing`，`instance` 显示为 `slot#7`。
- 重复 `Create`：保留首次内容，忽略后续并告警。
- 续接会话里旧实例已标 `reason: "reconnect"`，若又收到同 ID 的 `Create`：**新建一条实例记录，旧实例原样保留**（Domain Reload 后 Unity 实例表清空，业务很可能复用同名 id）。
- 可恢复中断（15 s 内同 `sessionId`）：保留实例、记录、游标，把未再出现的旧实例标 `endedAt` + `reconnect`；真断开才清空。

## C.4 容量、淘汰与游标

| 项 | 值 |
| --- | --- |
| 每实例字节 | 32 MB（`wireBytes` 记账，只算 `payloadLength`） |
| 全局字节 | 128 MB（硬上限） |
| 每实例条数 | 20000（辅助上限） |
| 实例数 | 32（按**最后活跃时间**淘汰，选中实例受保护） |
| 关键帧 | 每 1 MB 或 2000 条一个，每实例最多 64 个 |

- 淘汰只抑制被淘汰实例的**数据帧**；`debugCreate` / `debugFinish` / `debugFrame` 永不抑制；面板标"历史未记录"。
- 游标越界 → 夹到最早可用记录并标 `partial`，不重置。
- 关键帧按 `filterKey` 归属；过滤变化后全部失效并从头重放、标 `partial`。

## C.5 路由与消费者

- 按 `category` 精确匹配模块 `debug` facet；一个分类至多一个 facet，冲突按 `modules` 顺序保留第一个（`module.editorConflict`）。
- 每条记录**恰好一个主消费者**聚合，同时**总是**进入 `GenericDebugConsumer`（观察者）。
- 无模块认领 / 模块未加载：`GenericDebugConsumer` 兼任主消费者。
- facet 抛错：捕获、计数、记日志，该分类回退通用视图，**不影响其他分类与记录**。

```ts
export interface DebugConsumer {
  readonly categories: readonly string[];
  accepts(record: DebugRecord): boolean;      // 回填：与 facet 的等价关系由 F4 明确
  consume(record: DebugRecord): void;
  reset?(): void;
}
```

## C.6 录制容器（`.vbdrec`）

- 帧：6 字节协议头 + 载荷（原样），与实时连接收到的字节一致。
- 块：`type`(0 头 / 1 数据 / 2 尾) + `length` + `CRC32` + zlib 压缩的 64 KB 数据块。
- 文件头 JSON：`recordVersion`(1) / `protocolVersion`(4) / `contractSchemaVersion`(2) / `contractHash` / `sessionId` / `endpointId` / `bootId` / `connectType` / `startedAt` / `contracts`（录制时的合并契约原文）。
- 录制点在解码之前；**只录通道 0 业务帧与通道 1 数据帧**，握手/保活/`response` 不录。
- 文件尾：`{ records, droppedRecords, droppedBytes, endedAt, endedReason: "disconnect" | "sizeLimit" }`。
- 写入：独立异步队列，满则丢块并计数、不阻塞接收；每块 flush；`maxFileBytes` 到达写尾并停止。
- 回看：`FileDebugSource` 用文件头合成 `welcome`（`payloads` 固定 `["json","binary"]`、`resumed=false`、`debugEnabled=true`），丢弃流内握手帧；`recordVersion` 不符直接拒绝，不做迁移。

## C.7 面板规范

- 独立 Debug 面板：实例列表（关键词筛选匹配 `instanceId`/`resName`/`category`/`interface`/`debugInfo`）、工具条、消息队列、类型窗口区域、通用窗口。
- 工具条：`Debug 上报 [开/关]`（仅编辑器模式，状态以 `welcome.debugEnabled` 与广播为准，**不做本地乐观更新**）；清空；暂停/继续；录制；步进粒度；上一步/下一步。
- 步进：按记录（一条）与按帧（整帧）两种；同帧号不连续视为两帧；`frame == -1` 独立成组；帧号回退或重复不重排。
- Player 模式：开关置灰、不发 `debugSetEnabled`。
- 状态栏：连接状态、`endpointId`、目标地址、当前帧。

## C.8 契约解析

- 主来源：Unity 生成器的 `ArtifactsRoot` 下 `debug-contracts.json`；客户端从 Project 对应的 Unity 工程根按约定推导，**无需配置**。
- 补充/覆盖：`visualbridge.debug.contractDirectories`（工作区相对路径，递归查找）。
- 合并键是接口全名；补充与主来源冲突时保留主来源并标红，记录不丢。
- 两处都找不到 → 不加载契约，全部走通用视图；目录不存在只警告一次。
- 回看以文件内快照为准，不读工作区契约。
