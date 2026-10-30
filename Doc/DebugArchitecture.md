# 调试架构

## 1. 文档定位

本文是 VisualBridge 调试数据面的正式说明：接口式调试契约、生成器产物、线上消息格式、宿主消费层、录制与回看边界、扩展方式，以及**当前实现已知的限制与取舍**。

它描述的是**调试数据面**，不是执行级调试器：VisualBridge 不实现节点调度、断点、单步或变量求值。Graph 的“执行调试”是游戏侧执行引擎产生事实、VisualBridge 采集与展示的观察链路；Unity 侧接入步骤见 [`UnityGraphExecutionDebug.md`](UnityGraphExecutionDebug.md)，宿主激活期接线见 [`VSCodeHost.md`](VSCodeHost.md)，协议冻结语义见 [`UnityIntegrationArchitectureRuntime.md`](UnityIntegrationArchitectureRuntime.md) 与 [`ProtocolContracts.md`](ProtocolContracts.md)。

模块与宿主的分工、模块生命周期与故障定位见 [`ModuleSystem.md`](ModuleSystem.md)；模块通过 `debug` facet 认领分类并渲染窗口（见 §5.3）。

## 2. 链路总览

```mermaid
flowchart LR
  Engine["游戏侧执行引擎"] --> Capture["VisualBridgeGraphExecutionCapture<br/>采集门面"]
  Capture --> Observer["VisualBridgeGraphDebugEmitter<br/>UnityProject 侧观察者"]
  Observer --> Generated["生成的 GraphDebuger writer"]
  Generated --> Session["VisualBridgeDebug 会话<br/>实例 / 槽位 / 编码器"]
  Session --> Transport["VisualBridgeDebugTransport<br/>debug wire 栈"]
  Transport --> Channel["Runtime Bridge 连接的 ch1"]
  Channel --> Ingress["VS Code 扩展宿主<br/>DebugChannelSession"]
  Ingress --> Manager["DebugInstanceManager<br/>store / router / keyframe"]
  Manager --> Facet["Graph 模块 graphDebugFacet"]
  Facet --> Panel["Graph 执行调试面板"]
```

三段边界：

1. **采集**（`VisualBridge.Runtime`）：游戏侧把引擎事件转发给 `VisualBridgeGraphExecutionCapture`。采集门面分配执行实例 ID（`exec-<n>`）、维护实例注册表，并把每条事实同步回调给注入的观察者。Runtime 程序集不引用调试程序集，观察者由宿主注入。
2. **编码与传输**（`VisualBridge.Debug` / `VisualBridge.Debug.Bridge`，UnityProject 装配）：`VisualBridgeGraphDebugEmitter` 把采集事实转成 `category = "graph"` 的契约事件，经生成的 writer 写进统一调试会话；会话把消息编码后经 debug wire 栈发到 Runtime Bridge 连接的 **ch1**。
3. **消费**（VS Code 扩展宿主 + Graph 模块）：宿主解码 ch1 帧，按 `(category, instanceId)` 建实例、入 store、按文档路由增量；Graph 模块的 `graphDebugFacet` 把记录映射成时间轴增量，Webview 负责高亮、回放与界面。

`ch0` 仍是 Editor/Runtime Bridge 的控制队列（JSON 消息），`ch1` 是调试通道；两者共用一条 TCP 连接与同一套 6 字节帧头（`u32` = channel(1) | payloadKind(2) | payloadLength(29)，后接只覆盖前 4 字节的 CRC-16/CCITT-FALSE）。实现见 [`VisualBridgeDebugTransport.cs`](../Packages/com.kyle.visualbridge/Runtime/Debug/Bridge/VisualBridgeDebugTransport.cs)。

## 3. 契约分层

### 3.1 游戏侧接口与生成产物

游戏侧声明一个带 `[VisualBridgeDebuger]` 的接口，方法名就是调试流的**唯一真源**。Graph 的契约是 `IGraphDebuger`（六个方法：`InstanceStarted` / `NodeStarted` / `NodeOutput` / `DataNode` / `EdgeValueChanged` / `InstanceStopped`），声明在 [`IGraphDebuger.cs`](../UnityProject/Assets/VisualBridgeGraphDebug/IGraphDebuger.cs)。

生成器（`npm run generate:protocol` 之外的 Unity 侧工具，见 [`UnityGraphExecutionDebug.md`](UnityGraphExecutionDebug.md)）输出三类产物：

- `UnityProject/Assets/VisualBridgeGenerated/Debug/debug-contracts.json`：契约清单（`manifest.schemaVersion`、每个用于载荷的参数 tag、枚举底层类型），消费端与守卫用例读它；
- 生成的 C# writer（`GraphDebuger` / `VisualBridgeGeneratedGraphDebuger`）：把 `Start → PushParam → End` 收成一次生成调用；
- TypeScript 声明 `graph.g.ts`：**当前没有消费者**（见 §8.3），`Check` 仍把它纳入 drift 校验。

参数规则（生成器与运行期共同遵守）：显式 `[VisualBridgeDebugTag]` 优先且同方法唯一；未标记的载荷参数按声明顺序从 `1` 起自动分配、跳过已被显式占用的 tag；`0` 保留给系统字段与查询结果；二进制按 tag 升序写出；默认值在门面层、调用编码器之前跳过。

### 3.2 会话 API

`VisualBridgeDebug` 是游戏侧唯一的静态入口（[`VisualBridgeDebugSession.cs`](../Packages/com.kyle.visualbridge/Runtime/Debug/Internal/VisualBridgeDebugSession.cs)）：

| 成员 | 语义 |
| --- | --- |
| `isDebugBuild` / `isConnected` / `ConnectType` | 编译期开关、连接态、运行环境类型 |
| `Create(instanceId, category, resName, debugInfo)` | 注册执行实例；已挂接但无连接时描述入待发队列 |
| `Finish(instanceId)` | 结束实例并注销活跃登记 |
| `SetFrame(long)` / `SetEncoder(...)` | 会话帧号、编码器注入 |
| `Start` / `StartResult` / `RejectRequest` | 事件与查询结果的发送入口 |
| `Attach()` / `Detach()` | 连接事件的显式表达（见 §4） |

`Start` 返回 `false` 后生成代码必须立即返回，不得继续 `PushParam` / `End`；同一条消息的 `Start → PushParam → End` 必须同线程连续调用。

### 3.3 传输接口

`IVisualBridgeDebugTransport` 由宿主注入：`SendCreate` / `SendEvent` / `SendResult` / `SendReject` / `SendQueryError` / `SendControl` 加连接态与 `ConnectionGeneration`。业务与生成代码不接触它；它约定不得阻塞、不得回调调试 API、不得自行重试。

## 4. 实例、槽位与会话复位

- 实例集合上限 **1024**；`Create` 重复同一 id 不重发描述、返回 `true` 并告警；`Finish` 移除实例并注销登记。
- 槽位是 `u16`，`0` = 未分配。**同一连接内从 1 单调递增、绝不复用**；会话复位后的重放/重建**沿用登记的首选槽位**，避免消费端按 `(category, instanceId, instanceSlot)` 建立的查询归属在重连前后失效。
- 会话复位分三种，触发点与保留内容不同：
  - `Install` / `Uninstall`（换传输）：实例、槽位、待发描述、活跃登记、连接代次全部作废；
  - 宿主 `Detach`：快照复位但**保留活跃实例登记与槽位游标**，重连或 `Attach` 时按原槽位重放 `debugCreate`；
  - 静默换代（没有 `Detach`，会话自己发现 `ConnectionGeneration` 变化）：登记一起清空，不重放。
- `IsConnected` 看的是**栈内任一绑定仍打开**（F9 起，见 §8.1）：新连接压栈接管、断开后弹回上一条仍存活的连接；只有最后一条也断开时才 `Detach` 并重置会话。

## 5. 线上格式与宿主消费

### 5.1 消息形态

- 二进制：`debug` / `debugResult` 在字节上同构，`debugResult` 多一个 `u32 requestId`，**没有类型位**；接收端靠帧头的 `payloadKind` 与上下文区分。
- JSON：`type` / `category` / `instance` / `iface` / `method` / `requestId`（`"req-<n>"`）与 `args`。失败结果可省略 `iface` / `method`，消费端按 `requestId` 兜底归属。
- `debugFrame`（控制消息）只带 `{"type":"debugFrame","frame":N}`，在连接建立与帧值变化且确有数据要发时写出；它先于之后的数据消息。

### 5.2 宿主存储与路由

宿主 `DebugChannelSession` 解码帧后交给 `DebugInstanceManager`（[`debugInstanceManager.ts`](../Tools/VSCodeExtension/src/bridge/debugInstanceManager.ts)）：

- `debugCreate` 建实例；重复 `Create` **保留首条描述**（含首个槽位）并计 `duplicateCreates`，不静默合并；`debugFinish` 标结束并抑制之后的数据帧。
- 记录先于 `Create` 到达时最多暂存 64 条或 1 秒，超时按占位实例（`descriptorMissing`）接收。
- 实例数上限 32、全局内存上限 128 MB，按最后活跃时间淘汰；被淘汰实例只抑制数据帧，界面标 `historyMissing`。
- 关键帧回放按**分类**保存，每个分类最多 **64** 个关键帧（不是每实例）。

### 5.3 模块 debug facet

模块在 `ModuleRegistration` 里声明 `debug` facet：`categories` 精确匹配它认领的分类，`windowTitle` 只是建议标题，`onRecord(record)` 必须**每条记录独立派生**、不累积状态（宿主的关键帧回放与分类级重建会把同一批记录再投一次）。宿主拥有窗口结构、工具条与投递目标；模块取消认领或装载失败时回退通用视图。

Graph 的分类是 `graph`，facet 在 [`Modules/Graph/src/graphDebugFacet.ts`](../Modules/Graph/src/graphDebugFacet.ts)；它把契约方法名归一成界面事件种类（`NodeStarted → nodeStart` 等），并把 `InstanceStarted` / `InstanceStopped` 载荷里**恰好出现**的 `documentId` 原样透传，作为宿主按文档投递增量的提示。

## 6. 录制与回看

录制文件 `.vbdrec` 只录 Unity→VS Code 方向的帧，录制与回看的服务在 [`Tools/VSCodeExtension/src/debug/`](../Tools/VSCodeExtension/src/debug/)：录制按“第一个可用源”绑定（Editor 腿优先），Runtime 腿只覆盖 ch1。

- `footer.records` 是**落盘帧数**（含 `debugCreate` / `debugFinish` / `debugFrame`），**不是业务记录数**；界面文案应说“帧”。
- 二进制查询应答（`debugResult`）在回看里**不可归属**：文件里没有请求侧，而 `debug` / `debugResult` 在线上字节上同构、无类型位。回看把它们计数为 `unattributableBinaryFrames` 并明示，不伪造归属；回看只承诺**帧完整**，不承诺语义完整。
- JSON `debugResult` 在回看里按“到达帧”落成查询结果，在线按“发起帧”归属——录制没有请求侧，二者不可对齐。
- 回看统计**不可跨腿比较**：Runtime 腿的 `.vbdrec` 只有 ch1，`controlFrames` 语义与 Editor 腿（ch0+ch1）不对等；对比时只看 `records`。

## 7. 扩展方式

新增一个调试分类 / 模块窗口的最小步骤：

1. 在模块（或游戏工程）声明带 `[VisualBridgeDebuger(category, Kind = Event)]` 的接口，方法参数用 `[VisualBridgeDebugInstance]` 标出实例 id；
2. 生成契约与 writer，`Check` 通过（`debug-contracts.json` 与生成产物都在 drift 校验内）；
3. 游戏侧在事实发生处调用生成方法，保证同一会话里每个实例只 `Create` 一次、`Finish` 一次；
4. 模块注册 `debug` facet 认领该分类，实现每条记录独立派生的 `onRecord`；
5. 用守卫用例锁住“facet 别名表 = 生成契约的方法名集合”，避免契约改名后界面静默失效。

## 8. 已知限制与取舍

§8.1 逐条分段、§8.2–§8.7 与 §8.11 用四列表格，均给出**现象 / 原因 / 用户可见后果 / 归属**；§8.8–§8.10、§8.12 是按专题写的运行边界与语义说明，末尾各自给出归属。归属为“接受”的是本轮或上游任务明确接受的取舍；为任务 ID 的是尚未完成的待办。

### 8.1 传输层窗口（F9 交付时接受）

1. **弹回窗口内 `debugResult` 先落定后丢弃**。
   - 现象：活动 wire 进入 `stopping` 后，`StartResult` 已把请求句柄移出在途表（结算完成），随后 `End` 的 `SendResult` 发送失败，只计一次 `dropped`。
   - 原因：按“丢弃计数、不重置会话”的取舍，结算与发送不再原子。
   - 后果：`QueryQueue` 的执行超时不会再补发 `runtime.queryTimeout`，面板只能等**自己的客户端超时**；结果一样拿不到，但错误可见性变差。
   - 归属：F9 接受的取舍（继续由面板侧超时兜底）。
2. **栈顶死 wire 会放大既有的 P3**。
   - 现象：新 wire 的 `Closed` 若在 `Add` 与 `Subscribe` 之间到达会永久丢失，死连接留在栈顶；若栈里还有一条仍打开的旧 wire，`IsConnected` 一直为 `true`。
   - 原因：`IsConnected` 看“任一绑定仍打开”，而死 wire 的关闭事件没有被观察到。
   - 后果：会话不再被下一次调试调用惰性复位，长期停在“已连接”却每条消息都丢；用户症状与旧实现相同（面板收不到东西），只是内部状态更久地显示已连接。
   - 归属：既有 P3 的放大，F9 记录、未修（修法要改订阅时机或绑定后自检）。
3. **`IVisualBridgeDebugWire` 是 public 接口**。
   - 现象：`IsConnected` 现在在 transport 锁**内**调用 `IsOpen`。
   - 原因：F9 需要“存活”语义，只能在持锁期间判断。
   - 后果：仓库内两个实现的 `IsOpen` 都是无锁读；第三方实现若在 `IsOpen` 里取锁会引入锁序风险。接口注释已要求“必须无锁且短小”，但没有编译期约束。
   - 归属：F9 接受的接口契约（文档化约束）。
4. **探针检测不到“`Install` 移到注册之前”**。
   - 现象：F9 的装配探针位置固定在“注册之后、`Install` 之前”，只能判别“字段发布是否早于注册”。
   - 原因：探针只观察字段，不替生产调用 `Install`。
   - 后果：若将来把 `Install` 整体移到注册之前，现有探针与用例不会变红；该顺序回归只能靠代码审查。
   - 归属：F9 的测试判别力边界（方法级缺口，未排任务）。
5. **§1② 的判别力针对“过宽”变异，不针对旧实现**。
   - 现象：`IsConnectedIsFalse...` 用例杀的是 `IsConnected => !disposed`、`IsConnected => wireStack.Count > 0` 与“删掉 `ResetSessionLocked()`”这类**过宽**实现。
   - 原因：它由“先 `CloseWithoutNotifying()` 再断言未连接”构造，旧实现（只看活动 wire）在该断言下本来就绿。
   - 后果：这条用例不能证明“旧实现会红”；“过窄”方向由 §1① 覆盖，两条合起来才完整。
   - 归属：F9 已记录的测试判别力分工，不是缺陷。

### 8.2 面板身份与连接语义（G1a 遗留）

面板（[`GraphDebugPanel.tsx`](../Modules/Graph/src/webview/debug/GraphDebugPanel.tsx)）仍沿用旧展示模型，三项语义与新的多腿连接模型不一致：

| 现象 | 原因 | 后果 | 归属 |
| --- | --- | --- | --- |
| 状态栏显示 `运行时：${runtimeInstanceId}`，实际值是首条记录的 `sessionId` | 面板只从记录里取一个字符串，没有腿名/实例描述字段 | 用户会把 sessionId 误读成“连的是哪个 Unity 实例” | G1a 遗留，未排独立任务（需同时改 Webview 消息契约） |
| 实例行只显示裸 `instanceId` | 面板没有 `graphName` / `debugKey` 字段 | 同一个 `exec-1` 在不同 Graph 文档/执行者下无法区分 | 同上 |
| `runtimeConnected = instances.length > 0` | 面板按“有没有记录”推断连接；宿主按 `DebugPanelState.runtime.state === "connected"` 判定 | 会话断开但记录仍在时仍显示“已连接”，误导排障 | 同上；真正的连接来源应看宿主状态栏（§8.8 第 5 条） |

### 8.3 Graph 发射端与生成产物（G1c 交付时接受）

| 现象 | 原因 | 后果 | 归属 |
| --- | --- | --- | --- |
| `graph.g.ts` 是生成产物但没有消费者 | 生成器固定输出三类产物，TypeScript 声明暂无读取方 | 仓库多一份只靠 `Check` 保活的死代码，容易被误认为存在 TS 侧契约消费 | G1c 接受；删除会牵动生成器的“三类产物”契约 |
| `SetFrame` 是进程级全局 | `VisualBridgeDebug` 只有一个静态 `s_frame`，E9 宿主装配与 Graph 发射端共用 | 多个发射端/多个图同时上报时，会话帧号由最后写入者决定，`record.frame` 可能错位 | G1c 接受（单 Play 会话场景足够） |
| 自愈只覆盖 `graph` 一个分类 | “每条事实前复核登记、丢了就重建”只写在 Graph 发射端；通用重放 E11 才进会话层 | 其它分类在会话复位后若不自发重发 `Create`，事件仍会丢 | E11 已提供会话层重放；其它分类待接入（未排任务） |
| `record.frame` 来自 `s_frame`，`ResetSessionLocked` 不重置它 | 会话帧号不参与会话复位 | 重连后的新记录可能带着上一会话的帧号，直到下一次 `SetFrame` | G1c 接受（帧号是诊断展示值，不参与路由） |
| `node_start` 不再归一成 `nodeStart` | 契约方法是 `NodeStarted`，facet 别名表只映射契约里真实存在的方法 | 仍按旧词形发事件的代码不会点亮节点，会作为未知方法进时间轴 | G1c 刻意删除多余别名（契约是唯一真源），有守卫用例 |
| `frameIndex == 0` 不可观测 | 默认值规则在编码前跳过 `0`，线上不出现 `frameIndex` | 消费端读不到按 `0` 处理，“第 0 帧”与“没有帧信息”不可区分 | 编码前跳过默认值的规则，接受的语义坑（与 `outputIndex = 0` 同类） |

### 8.4 文档作用域与归属（G1d 交付时接受）

| 现象 | 原因 | 后果 | 归属 |
| --- | --- | --- | --- |
| `documentId` 只随 `InstanceStarted` / `InstanceStopped` 出现 | 契约只在这两条载荷里带文档身份，facet 不缓存、不推断 | 其余事件无法直接归属文档，宿主按“身份未知”处理 | G1d 的投递提示设计（不改变 `DebugRecord` 形状） |
| 学到归属前的增量与快照按 editor 面投递 | 实例开始前不知道 `documentId`，只能按 editor 兜底 | 可能出现**多显示**（同一记录出现在多个文档窗口），但不是**错归属** | G1d 接受 |
| 快照 / resync 会追溯，实时增量不可追溯 | 宿主用关键帧/快照补历史，但已实时投递的增量不保留可重放的路由历史 | 晚打开的文档能看到历史；已经投到别处的增量不会“搬家” | G1d 接受 |
| 旧路径能覆盖中途接入，新路径覆盖不了 | 旧 `graphExecution` 订阅可按实例补历史；新数据面按文档投递 | 中途打开面板只能看到接入后的增量（依赖关键帧/快照补历史） | G1b 删除旧路径后的能力缺口，待办（未排任务） |

### 8.5 端到端证据（G1b 后）

| 现象 | 原因 | 后果 | 归属 |
| --- | --- | --- | --- |
| “真实 Unity 事件 → Graph Webview ack”没有单条端到端用例 | G1c 用例止于面板记录，G1d 用例止于合成 ingest | 链路的真实末端（Webview 回执）只能靠分段用例推断 | G3 端到端验收待补 |
| 没有反向守卫覆盖“换名复活旧事件” | 守卫锁的是“contract 方法名 = 别名表键”，两侧同时改就一致 | 有人改回旧方法名并同步改别名表时没有用例会红 | G1c 记录、待办 |

### 8.6 连接稳定性（E11 交付时接受）

| 现象 | 原因 | 后果 | 归属 |
| --- | --- | --- | --- |
| `runtime-e2e` 查询往返约 30% 偶发红，成因未定论 | 存在多个候选机制；E11 只消除了“槽位漂移”这一种，未做统计级 A/B | 不能宣称已找到唯一根因；抖动仍可能出现 | E11 接受的结论强度 |
| 重放条件是“宿主 `Detach` 结算” | 只有宿主观察到整栈断开才保留登记；静默换代无法区分抖动与真断开 | 没有 `Detach` 的静默换代后，存活实例仍可能丢失 | E11 接受的保守取舍 |
| 面板重复 `Create` 保留首条槽位 | 消费者侧 `create()` 对已存在实例保留首个描述与首个槽位 | 重放/自愈与真实重启在同一 id 上无法区分，后者可能沿用旧槽位 | 消费端保留首条 `debugCreate` 的描述与槽位、不随重复 `Create` 更新；E11 未改 |
| `InstanceStarted` 不因 replay 重发 | 重放只发 `debugCreate`，不发业务事件 | 重连后远端有实例描述、没有“开始事件”，依赖开始事件的界面需自行容错 | E11 接受的重放范围（重放业务事件会重复消费） |
| 探测的正向探活路径没有被 E2E 走到 | 现有 E2E 由发现记录直连，`probeAndConnect` 的“探测成功并采纳候选”分支只有单测 | 真实环境下的正向探测缺少端到端证据 | E11 记录、G3 待补 |
| 换链时所有 handshake 失败，旧连接仍被断开 | `probeAndConnect` 在候选握手前无条件 `disconnect()`：换链必须先释放，否则新连接 `Bind` 会压栈、代次不变 | 一次失败的换链会让面板失去可用连接，需要重试 | E11 接受的取舍（**不要理解成“探测失败不断开”**） |
| TOCTOU 残留 | `FinishAndDecideLocalDrop` 先 `Finish`、再读 `isInstanceRegistered`；两步之间可能插入 `Detach` | 重连重放后留下“活着但不再更新”的幽灵实例 | E11 记录的待办（需 `Finish` 三态返回或允许二次 `Finish`） |

### 8.7 录制回看（协议留白）

| 现象 | 原因 | 后果 | 归属 |
| --- | --- | --- | --- |
| 二进制查询应答在回看里无法归属到请求 | `.vbdrec` 只录 Unity→VS Code 的帧，没有请求侧；`debug` / `debugResult` 在字节上同构、无类型位 | 回看只能计 `unattributableBinaryFrames`，不能给出“哪条结果对应哪次查询” | 录制格式的既有边界，接受 |
| JSON `debugResult` 在回看按“到达帧”、在线按“发起帧”落位 | 录制没有请求侧，两种口径无法对齐 | 同一结果在回看与在线的帧号可能不同 | 接受 |
| `footer.records` 被当成“业务记录数” | 它统计的是落盘帧数（含 `debugCreate` / `debugFinish` / `debugFrame`） | 用业务记录数解释会偏大；界面应说“帧” | 协议语义，接受 |
| 关键帧上限按“每分类 64”而不是“每实例” | 关键帧注册表按分类保存 | 实例更多的分类不会得到更多关键帧，回看精度按分类均分 | 宿主容量策略，接受 |

### 8.8 用户可见的运行边界

1. **会话一次只服务一条活动连接，但可恢复（栈）**：新连接接管 ch1，其断开后自动回到上一条仍存活的连接；只有最后一条也断开才 `Detach` 并重置会话。**不做多播**——被压栈期间原消费方收不到帧（面板暂停更新，对方断开后恢复）；**压栈期间新建的实例**，其 `debugCreate` 只发给临时连接，恢复后对原消费方不可见（按 `unknownSlot` 丢弃），需应用重新注册。排查：看谁最后连上（MCP 每次工具调用都会建一条临时连接）。
2. **重连后存活实例的可见性（协议留白，部分收敛）**：协议只规定“断连使槽位立即失效”，没有规定重连后存活实例如何重新可见。E11 起，宿主 `Detach` 结算的断连会保留登记并按原槽位重放 `debugCreate`；**剩余边界**：静默换代清空登记、`InstanceStarted` 不重发。用户恢复步骤：重启 Play 模式、让应用重新注册、或点面板「重试连接」。
3. **编辑模式不产生调试数据**：Unity 只在 Play/Player 通过 runtime 桥发送 ch1；Editor 桥连接**不安装调试传输**，`VisualBridgeDebugSession.Create` 在 `s_transport == null` 时直接返回 `false`。未进入 Play 时面板在线实例为空是正常现象，不是故障。
4. **面板自动连接失败不阻塞、不弹窗**：Unity 未开或端口无响应时面板照常打开并显示原因，用户可点「重试连接」；不会后台无限重试。
5. **状态栏同时反映两条腿**：显示来源 Editor / Runtime / Editor+Runtime / 无；只有 Runtime 腿在线不再显示“未连接”，并给出失败原因与重试。边界：“已连接”来自宿主侧 TCP 与会话状态（同源），**不保证对端一定在产数据**；**关闭面板不断开连接**（只收 UI、保留模型与缓存，断开会让 Unity 侧重置会话并清空实例），连接收尾归扩展停用与 DAP。
6. **两条腿共享同一个实例管理器**：Editor 腿收到“非续接”握手会 `debugManager.reset()`，会**连带清掉 Runtime 腿的实例**；两个 Unity 侧同时在线时可能看到实例“消失又出现”。
7. **跨腿同名实例合并成一条时间轴**：`DebugInstanceManager` 按 `(category, instanceId)` 合并，`origin` 只保留**首条**来源，来源冲突时标 `originConflict`。同一 id 在两条腿各报一次**不会**得到两行，而是**一行 + 冲突标记**；实例行来源是“首条来源”，不是“唯一来源”，当前没有按腿分开看的能力。
8. **同机多开时连“最近启动”的 Unity**：自动连接按 `editor-play` + 最新 `startedAt` 选择，没有项目身份可匹配（协议未携带项目指纹）；同机多开时请确认连的是哪一个（既有策略，与旧 Graph controller 相同）。
9. **录制按第一个可用源绑定（Editor 腿优先）**：两条腿同时在线时录制落在 Editor 腿，暂无源选择器；Runtime 腿的 `.vbdrec` 只覆盖 ch1，`controlFrames` 语义与 Editor 腿不对等。

归属：以上均为既有运行边界（单连接模型、协议未规定重连后存活实例如何重新可见、两腿共用实例管理器）；#1 的压栈缺口与 #2 的剩余边界是已接受的取舍，恢复步骤已给出，无新增待办。

### 8.9 `local.*` 错误码命名空间

宿主侧在协议 7 个 `runtime.*` 码之外还有一组**本地码**：`local.notConnected`、`local.noConnection`、`local.noOwner`、`local.sendFailed`、`local.instanceNotFound`、`local.instanceFinished`、`local.instanceEvicted`、`local.unknownMethod`、`local.disconnected`、`local.cancelled`、`local.disposed`、`local.unexpectedResponse`（完整清单即 `debugQueryClient.ts` 的 `DebugQueryLocalErrorCode`）。它们表示“本地条件，不冒充服务端回答”，**不在** `Protocol/contract-manifest.json` 的 `errors.debugQuery` 里。三点注意：

1. `local.instanceFinished` 被**两种**原因复用：**真结束**（`debugFinish`）与**重连**（`reconnect()`）；容量淘汰**不**设 `endedAt`，`active` 仍为 `true`。文案可能不够精确。
2. `DebugInstanceEndReason` 的 `"evicted"` / `"disconnect"` 已由 **F8 删除**（旧版本声明过但从未赋值）；现在类型只有 `"finished" | "reconnect"`，类型里找不到这两个值。
3. E10 把路由未解析拆成两个码：`local.noOwner`（实例没有任何**存活的**调试连接持有）与 `local.noConnection`（**多连接歧义**，同时在线时不猜）。旧实现用同一句“多连接同时在线时不会猜”回答两种情况，实测 `connections=1` 时也返回它，排障被带偏。

归属：本地码语义在 E10/F8 交付时确定；第 1、3 条是已接受的现状，第 2 条已由 F8 移除、不再是限制。

### 8.10 facet 计数器的语义陷阱

`DebugFacetWindow.records` **不是**“该分类有多少条记录”：它是“**本消费者自上次 `reset` 起 `onRecord` 的次数**”，`rebuild()` 每次新建消费者时归零、重放批次投递前为 **0**，属于**瞬时/在途**计数。异步 rebuild 恰好落在取基线之前时会读到 0 而实际有 N 条。同理 `batches` / `content` / `pending` 也是消费者侧的在途状态，不是 store 的真相。要读“该分类有多少条记录”，必须读面板实例表的 `recordCount`（[`debugStore.ts`](../Tools/VSCodeExtension/src/bridge/debugStore.ts)）或 store 侧访问器。

归属：facet 契约的消费者侧在途语义（容量/淘汰与游标规则在 G1a 确定），属接受的语义陷阱；正确读法已给出，不改 API。

### 8.11 门禁质量

| 现象 | 原因 | 后果 | 归属 |
| --- | --- | --- | --- |
| `test:bridge-e2e` 在用例全 PASS 之后仍可能以 exit 1 失败 | 脚本在 VS Code 结果之后仍检查 `unityCode !== 0` | 门禁红可能来自 Unity 退出码而非往返失败，回归判断被误导 | 门禁脚本待改进（G3 前拆开“用例结果”与“Unity 生命周期”） |
| `bridge-e2e` 需要真实 Unity Editor 且独占 `UnityProject` | 启动真实 Editor；`UnityLockfile` 被占用或没有 Editor 时直接失败 | 环境缺失与产品回归在退出码上不可区分，无 Editor 的机器无法运行 | 环境门禁的既有约束，接受 |

### 8.12 安全边界

- **Player 腿的 Runtime Bridge 监听 `0.0.0.0` 且无 token**：Editor / EditorPlay 腿监听 `127.0.0.1` 并做 token 首条消息认证；Player 构建自动监听全网卡、没有认证，局域网内能连上的人拥有该桥的同等能力。Unity 侧窗口会显式提示这条风险，但这仍是项目方明确接受的边界。
- **模块不做沙箱**：模块在扩展宿主进程内执行、与宿主同特权（见 [`ModuleSystem.md`](ModuleSystem.md) §8）。宿主不把原始字节交给模块是接口约定，不是隔离。
- 归属：两条都是已接受的边界——Player 腿的无认证监听由项目方裁定；模块同特权执行是模块平台设计，不是待办。
