# 附录 A · 线上协议契约（固化自草案 T / U）

> 本附录是**唯一协议依据**。草案删除后，任何实现与评审都以这里为准。
> 标注「回填」的条目：草案只给了原则、未给精确表，由指定任务在实现时确定并把最终值写回本节。

## A.1 帧头（6 字节）

```text
偏移  宽度  字段
+0    u32   channel(1) | payloadKind(2) | payloadLength(29)   大端
+4    u16   crc16（覆盖前 4 字节）                              大端
+6    ...   载荷（payloadLength 字节）
```

```text
 bit 31    bit 30..29       bit 28..0
+--------+----------------+--------------------------------+
| channel|  payloadKind   |        payloadLength           |
+--------+----------------+--------------------------------+
```

```csharp
public enum DebugChannel : byte { Editor = 0, Debug = 1 }
public enum DebugPayloadKind : byte { Binary = 0, Json = 1 }
```

- 前 4 字节按**大端（网络序）**读写；第一个字节的最高位就是 `channel`。
- `crc16` = **CRC-16/CCITT-FALSE**（poly `0x1021`、init `0xFFFF`、不反射、xorout `0`），**只覆盖前 4 字节**；**载荷不参与校验**。
- 分帧：先读 6 字节头并校验 CRC，通过后再读满 `payloadLength`。
- **CRC 失败或长度非法立即断开**，不尝试重同步（长度字段已不可信）。这是唯一的"失败即断"路径。
- 不设魔数；载荷内出现 `\n` 无协议含义（原 NDJSON 行分帧作废）。
- 一条连接上两个通道、两类载荷可任意交错；`protocolVersion = 4`（唯一连接层版本）。

## A.2 通道与消息

| 消息 | 通道 | 方向 | 载荷 |
| --- | --- | --- | --- |
| `hello` | 0 | 拨号方 → 监听方 | JSON |
| `welcome` | 0 | 监听方 → 拨号方 | JSON |
| `error` | 0 | 任一方 | JSON，随后断开 |
| `ping` / `pong` | 0 | 双向 | JSON |
| `open` / `reveal` | 0 | Unity → VS Code | JSON（仅编辑器模式） |
| `response` | 0 | VS Code → Unity | JSON（应答编辑器操作） |
| `debugSetEnabled` | 0 | VS Code → Unity | JSON |
| `debugEnabled` | 0 | Unity → VS Code | JSON |
| `Create` / `debugCreate` | 1 | Unity → VS Code | 二进制 / JSON |
| `Finish` / `debugFinish` | 1 | Unity → VS Code | 二进制 / JSON |
| `debugFrame` | 1 | Unity → VS Code | JSON |
| `debug` | 1 | Unity → VS Code | 二进制 / JSON |
| `debugResult` | 1 | Unity → VS Code | 二进制 / JSON |
| `request` | 1 | VS Code → Unity | JSON |
| `response` | 1 | Unity → VS Code | JSON（应答查询失败） |
| `dropped` | 1 | Unity → VS Code | JSON（累计计数） |

`response` 在两个通道方向不同，靠通道位区分，**不共享**请求空间。

## A.3 握手

`hello`（拨号方 → 监听方）：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `protocolVersion` | 是 | `4` |
| `role` | 是 | `editor` / `vscode`；监听方据此拒绝错配 |
| `clientEndpointId` | 是 | 拨号方**端点**标识（不是调试实例 id） |
| `token` | 否 | 编辑器模式必填；Player 为空 |
| `contractHash` | 是 | 16 位十六进制；无契约时为空串 |
| `payloads` | 是 | `["json","binary"]` 的子集，必须含 `json` |
| `debugCategories` | 否 | 空/省略 = 全部 |
| `debugInstances` | 否 | 空/省略 = 全部 |
| `resumeSessionId` | 否 | Domain Reload 后重连带上次 `sessionId` |

`welcome`（监听方 → 拨号方）：

| 字段 | 说明 |
| --- | --- |
| `protocolVersion` | `4` |
| `endpointId` | 监听方端点标识（**不是**调试实例 id） |
| `sessionId` | `endpointId#bootId`，跨 Domain Reload 稳定 |
| `resumed` | 是否续接 |
| `connectType` | `editor` / `editor-player` / `player` 等 |
| `generation` | 每次传输建立 +1，只用于日志与陈旧判定，**不参与** `sessionId` |
| `bootId` | 每次进程启动随机 |
| `contractHash` | 服务端指纹 |
| `payloads` | 协商结果；`contractHash` 不一致时**去掉 `binary`** |
| `debugEnabled` | debug 总开关当前值 |
| `startedAt` | ISO 时间 |

拒绝层级：方向层 `runtime.roleMismatch`；连接层 `runtime.unsupportedProtocolVersion`；契约层（`manifest.schemaVersion` 不等 → 该目录契约不加载）；指纹层（降级为 JSON，**保留连接**）。

## A.4 二进制载荷

```text
偏移  宽度  字段
+0     u16  methodId
+2     u16  instanceSlot
+4     ...  载荷主体
```

`methodId` 统一号段：`0` = `None`（保留）；`1`/`2` = `Create`/`Finish`；`3–9` 预留系统；`10+` 分类方法（只在同分类内唯一；不同分类可重复）。

载荷主体：

| 消息 | 主体 |
| --- | --- |
| `debug` | 参数区 |
| `debugResult` | `u32 requestId` + 参数区 |
| `Create` | 参数区（固定 tag 表） |
| `Finish` | 参数区（固定 tag 表） |

系统消息固定 tag 表（不查契约）：`Create`：`0 category` / `1 instanceId` / `2 resName` / `3 debugInfo`（全 `string`）；`Finish`：`0 instanceId`。

参数区（稀疏）：`u16 tag + u8 type + value`，按 `tag` 升序，只写非默认值。载荷内所有多字节整数与长度字段一律**大端（网络序）**。

**type 码表（D3 回填，与 TS 解码器共用同一张表）**：

| type | 类型 | 线上值 | 默认值（不写） | JSON 表示 |
| --- | --- | --- | --- | --- |
| 0 | None | 保留 | — | — |
| 1 | `bool` | `u8`：`0`/`1` | `false` | `false` / `true` |
| 2 | `int` | `i32` | `0` | number |
| 3 | `long` | `i64` | `0` | 字符串（避免 JS 精度丢失） |
| 4 | `ulong` | `u64` | `0` | 字符串 |
| 5 | `float` | IEEE754 `f32` 位模式 | `+0.0`（按位判断） | number；`-0.0` 写 `-0.0`，NaN/±Infinity 写字符串 |
| 6 | `double` | IEEE754 `f64` 位模式 | `+0.0`（按位判断） | 同上 |
| 7 | `enum` | 底层整型（宽度按契约 `underlyingType`，1/2/4/8 字节） | 底层值 `0` | 成员名；未命名值用底层十进制字符串 |
| 8 | `string` | `u16` 字节长度 + UTF-8 字节 | `null` 或 `""` | string |
| 9 | `byte[]` | `u32` 字节长度 + 原始字节 | `null` 或长度 `0` | base64 string |

读取**按契约声明推进**，不按载荷末尾；缺中间 `tag` 即默认值。解码端先用 `(category, methodId)` 查 `debug-contracts.json`，再按 `tag` 匹配参数声明与类型。

- JSON `args[].type` 使用**线上类型名**：`uint` / `short` 等经生成代码收窄后表现为 `long` / `int`，enum 统一为 `enum`；具体声明类型（含枚举完整名与 `underlyingType`）以 `debug-contracts.json` 为准。
- 单条消息上限 **1 MB**（含 `methodId`/`instanceSlot`/`requestId` 头），超限丢弃并计数；二进制 `string` 另受 `u16` 长度上限（65535 字节）约束，超限时整条消息丢弃。

分类入口只有 `Create`：`category` 与槽位在此绑定；`slot → instance → category` 是二进制路由的唯一依据；槽位未知或 `(category, methodId)` 未命中 → 丢弃并计数。

## A.5 语义消息

`debugCreate`：`{ type: "debugCreate", category, instance, instanceSlot, resName, debugInfo }`，每实例一条，连接建立时先 flush 待发项。
`debugFinish`：`{ type: "debugFinish", category, instance }`，每实例最多一条，语义是生命周期结束。
`debugFrame`：`{ type: "debugFrame", frame }`，连接建立后先发一条当前值；数据包不带帧号；`Create`/`Finish` 不参与帧分组。
`debug`：`{ type: "debug", category, instance, iface, method, args: [{ tag, name, type, value }] }`。
`request`：`{ type: "request", requestId: "req-<n>", action: "debugQuery", category, instance, iface, method, methodId, args: [{ tag, name, type, value }] }`；`instance` 必填且必须存活；`methodId` 必填（u16，A.4 的分类方法号段 `10+`）。
`debugResult`：`{ type: "debugResult", category, instance, iface, method, requestId: "req-<n>"（JSON）/ u32（二进制）, args: [{ tag, name, type, value }] }`，与事件同一条流。

**D4 回填（反向查询）**：

- `request` 的完整字段清单（E6 消费）：`type`（恒 `"request"`）、`requestId`（JSON `"req-<n>"`、二进制 u32，**同一连接内唯一且非 0**）、`action`（恒 `"debugQuery"`）、`category`（分类名，缺省时服务端用槽位绑定补齐）、`instance`（实例 id，必填且必须存活）、`iface`（接口 id，**原任务文本遗漏**；缺失时服务端按分类内方法号唯一性反查）、`method`（方法名，仅诊断/展示）、`methodId`（**必填**，u16，取 A.4 的 `10+` 分类方法号；与二进制载荷头同一语义，服务端的分发与参数声明表只认它——`iface`/`method` 是名字，缺 `methodId` 按 `invalidRequest` 丢弃，见 E6）、`args`（可选，元素必须带 `tag`，值按 A.4 类型码表的线上类型）。JSON 信封**不带** `instanceSlot`（`methodId` 两种信封都带，语义相同）；二进制信封在载荷头携带 `methodId + instanceSlot`（A.4）。键顺序固定为 `type / requestId / action / category / instance / iface / method / methodId / args`；序列化只有 `Tools/VSCodeExtension/src/bridge/debugMessages.ts` 的 `encodeDebugRequest` 一个入口（键序由对象字面量的插入顺序固定），跨语言没有机械比对——两侧各自锁定：TS 用例断言该函数的输出字节，C# 侧只用 `AssertKeyOrder` 守卫共享 fixture 的键序（C# 只解析、不生产）。
- `debugResult` 的 `category` / `instance` 在能定位槽位时必填；**`iface` / `method` 允许省略**——槽位未知或手写处理器的 4 参句柄拿不到归属时省略（D4 的生产路径是生成 Dispatcher 的 7 参句柄，恒带归属）。消费端必须以 `requestId` 关联请求与结果，**不得因缺 `iface`/`method` 丢消息**（C.2 的 `DebugRecord.interfaceId/method` 由消费端按 `requestId` 兜底或留空）。
- 失败应答：服务端对未注册、实例不存在、参数不合法、排队/并发超限、排队/执行超时一律用通道 1 的 `response`（`ok: false` + A.6 错误码）回给 `requestId`，**不进入调试流**；这些错误码由 D4 的运行期产出（B.6.2/B.6.3）。
`response`（通道 1）：`{ type: "response", requestId, ok: false, code, detail }`，不进入调试流。
`response`（通道 0）：应答 `open`/`reveal`；字段由 E3 回填，见下。
`error`：`{ type: "error", code, message }`，随后断开。

**E3 回填（编辑器通道）**：

- `open`：`{ type: "open", requestId, documentPath }`。`documentPath` 是**项目根相对**的正斜杠路径：非空、≤ 1024、不以 `/` 开头、不含 `:`/`\`/`//`、不以 `/` 结尾、无 `.`/`..` 段。不合规一律 `bridge.invalidMessage`（`$.documentPath`）。
- `reveal`：`{ type: "reveal", requestId, reference }`。`reference` 是**非空字符串**（≤ 1024）或**整数**（无小数、不越安全整数）；其他类型 `bridge.invalidMessage`（`$.reference`）。
- `response`（通道 0）只有两种形状，判别字段是 `status`（**不是** `ok` 布尔）：
  - `{ type: "response", requestId, status: "ok" }`
  - `{ type: "response", requestId, status: "error", error }`，`error` 取 A.6 错误码（编辑器腿用 `bridge.*`）。
  `ok` 分支不携带 `error`；两个分支都**不带** `detail`——可读诊断留在接收端日志，线上只有错误码。
  典型码：资源不在任何项目内 → `bridge.documentUnresolved`；多项目解析到同一路径 → `bridge.documentAmbiguous`；命令失败 → `bridge.internalError`。
- **`requestId` 空间按通道隔离（评审 P0）**：通道 0 的 `requestId` 只对应 `open`/`reveal`，由 Unity 生成 `req-<guidN>`；通道 1 的调试查询 `requestId` 是 `req-<n>`。两者**不共享**请求表——接收端必须先按帧头通道位分派（通道 0 → 编辑器请求/应答，通道 1 → 调试查询/结果），因此即使两侧字符串相同也不会串台。回应答时只回显同通道请求的 `requestId`，通道 1 的 `response` 绝不满足通道 0 的待应答请求（反向同理）。


**E4 回填（丢弃通知）**：

- `dropped`：`{ type: "dropped", filteredByServer, unknownMethod, unknownSlot, invalidRequest, encodeFailed, oversize, queueOverflow }`，
  本次连接的**累计**计数（断连/新连接归零），键顺序固定；按周期上报（节流 500 ms，由 1 s 心跳与任意收发触发），
  计数无变化不重发。

  | 字段 | 含义 | 计数点 |
  | --- | --- | --- |
  | `filteredByServer` | 服务端筛选丢弃 | 入队前按 `debugCategories` / `debugInstances` 过滤未命中；不编码、不传输 |
  | `unknownMethod` | 方法号不在分类号段 | 事件方法号 < `10`（`0` = None、`1`/`2` = Create/Finish、`3–9` 预留）；入站二进制帧已知槽位但方法号 < `10` |
  | `unknownSlot` | 槽位未知或已失效 | 槽位未由 `Create` 建立，或已随 `debugFinish` / 断连**立即**失效；含入站二进制帧的未知槽位 |
  | `invalidRequest` | 入站帧不是合法 `request` | 通道 1 入站 JSON 畸形（含嵌套超过 32 层），或已知槽位的二进制入站帧（A.2 只允许 JSON `request`） |
  | `encodeFailed` | 会话级丢弃 | 编码失败、无连接、连接换代（会话计数，随会话重置归零） |
  | `oversize` | `encodeFailed` 中超限部分 | 单条 > 1 MB，或二进制 `string` > 65535 字节 |
  | `queueOverflow` | 队列容量淘汰 | 数据队列按字节 / 条数丢最旧（A.9），取发送侧计数 |

- 契约级未知方法（`(category, methodId)` 不在 `debug-contracts.json`）由 **F1 消费端**识别，
  不计入服务端 `dropped`：服务端只知道自己发出的号段，判断不了对端契约版本。

- 筛选只抑制 `debug`（分类 / 实例维度）；`debugCreate` / `debugFinish` / `debugFrame` / `debugResult` / `dropped`
  不受筛选：生命周期描述与查询应答缺失会让客户端无法归属后续记录（C.3/C.4）。
- 筛选缺省、空数组都表示「全部」，两者同时存在时按 AND 组合（A.9）。

## A.6 错误码

| 码 | 含义 |
| --- | --- |
| `runtime.roleMismatch` | 拨号方身份与监听方不符 |
| `runtime.unsupportedProtocolVersion` | 版本不等 |
| `runtime.unsupportedPayload` | `payloads` 交集为空或缺 `json` |
| `runtime.invalidToken` | token 错（编辑器模式） |
| `runtime.alreadyConnected` | 已有一对一连接 |
| `runtime.unknownMethod` | `(category, methodId)` 不在契约 |
| `runtime.editorChannelUnavailable` | Player 收到 `open`/`reveal` |
| `runtime.debugSwitchUnavailable` | Player 收到 `debugSetEnabled` |
| `runtime.debugNotEnabled` | 上报开关关闭 |
| `runtime.queryTimeout` | 排队或执行超时 |
| `runtime.queryBusy` | 并发超限 |
| `runtime.queryUnregistered` | 接口未注册处理器 |
| `runtime.queryRejected` | 业务拒绝：`RejectRequest` 主动拒绝、处理器抛异常、处理器返回 `false` 且未回发结果（E6 登记） |
| `runtime.instanceNotFound` | 实例未创建或已结束 |
| `runtime.invalidArgument` | 参数不合法 |
| `runtime.contractHashMismatch` | 两侧指纹不一致（仅展示，不断连） |
| `runtime.noEndpoint` | 客户端本地：端口段内无可握手端点 |

- 查询错误码（通道 1 `response` 的 `code`）的**权威清单**是 `Protocol/contract-manifest.json` 的 `errors.debugQuery`（按 UTF-16 码元排序）：上表的 `runtime.queryBusy` / `runtime.queryTimeout` / `runtime.queryUnregistered` / `runtime.queryRejected` / `runtime.instanceNotFound` / `runtime.invalidArgument`。`check:protocol` 与 C# 的 `VisualBridgeDebugQueryErrors`、客户端的 `DEBUG_QUERY_ERROR_CODES` 三方核对，任一侧多一个少一个都会红。
- `runtime.queryRejected` 的三条触发路径都回同一个码，可机器区分的原因在 `detail`：`RejectRequest(request, reason)` 原样回 `reason`；生成的 Dispatcher 捕获业务异常后回 `handler-exception: <异常类型名>`；handler 返回 `false` 且没有回发结果时回 `handler-returned-false`（非生成处理器抛出的异常由运行期兜底，也归这一条，异常信息进诊断日志而非 `detail`）。业务自定义原因因此是**开放域**（非枚举），消费端不得拒收未知 `detail`。
- 通道 0 的编辑器应答用 `bridge.*`（见 §A.5 的 E3 回填），与查询错误码不共享命名空间。

## A.7 发现记录

文件型，`os.tmpdir()/visualbridge-bridge/<windowId>.json`：`formatVersion`（**2**）、`protocolVersion`、`role`、`tcpPort`、`token`、`pid`、`generation`、`windowId`、`projectRoots`。心跳为每秒更新 mtime；陈旧判定 = mtime 龄 > 5 s 或 pid 不存活。**`formatVersion` ≠ 2 时忽略该记录**（视为无记录，不迁移）。

## A.8 配置默认值

Unity `VisualBridgeDebugConfig`：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `Enabled` | `true` | 传输总开关 |
| `DebugReportingEnabled` | `true` | debug 上报总开关（运行时开关，与传输解耦） |
| `AutoListenInPlayer` | `true` | 发布版自动监听 |
| `PortRangeStart` / `PortRangeEnd` | `28300` / `28349` | 仅 Player |
| `AutoListenInPlayer` | `true` | 发布版自动监听 |
| `BindAllInterfaces` | `true` | Player 为 true |
| `RequireToken` | `true` | 编辑器恒 true；Player 无认证 |
| `ArtifactsRoot` | `""` | 契约产物根（必须在 asmdef 覆盖内） |
| `SendBufferBytes` / `SendBufferMessages` | `16 MB` / `65536` | 数据队列 |
| `MaxMessageBytes` | `1 MB` | 单条上限 |
| `QueryQueueCapacity` | `8` | 查询队列 |
| `QueryQueueTimeoutMs` / `QueryExecutionTimeoutMs` | `2000` / `3000` | 两段超时 |
| `HandshakeTimeoutMs` | `5000` | 握手超时 |
| `HeartbeatIntervalMs` / `IdleTimeoutMs` | `10000` / `30000` | 保活与判死 |
| `ReconnectGraceMs` | `15000` | 宽限期 |

VS Code 设置：`host`/`port`/`portRangeStart`/`portRangeEnd`/`probeTimeoutMs(300)`/`probeConcurrency(8)`/`connectTimeoutMs(5000)`/`queryTimeoutMs(8000)`/`heartbeatIntervalMs(10000)`/`idleTimeoutMs(30000)`/`reconnectGraceMs(15000)`/`contractDirectories([])`/`instanceCapacityBytes(33554432)`/`totalCapacityBytes(134217728)`/`instanceRecordLimit(20000)`/`keyframeIntervalBytes(1048576)`/`keyframeIntervalRecords(2000)`/`keyframeMaxPerInstance(64)`/`maxInstances(32)`/`instanceFilter.*`。

## A.9 控件与筛选

- 控制队列 256 条、不淘汰、满则断开；数据队列按字节 16 MB / 65536 条、入队处丢最旧。
- 每条消息入队取单调序号；**写线程按序号写出**；控制消息入队时记数据队列尾序号作为屏障，写出它前必须先写出屏障前的数据消息。
- 服务端筛选：`debugCategories` / `debugInstances` 在**入队前**过滤（不编码、不传输），`debugFrame` 不受筛选；未命中计入 `filteredByServer`。
- 心跳：写线程在连续 10 s 未发任何消息时自行入队 `ping`；连续 30 s 未收到任何字节则断开。
