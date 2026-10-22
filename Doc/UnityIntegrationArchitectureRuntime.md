# Unity Editor 接入架构：Runtime Bridge 与 Graph 执行观察

本文是 [VisualBridge Unity Editor 接入架构](UnityIntegrationArchitecture.md) 的子文档，覆盖 Runtime 产物形态冻结决策、Runtime 实例发现、Runtime Bridge 协议、Graph 执行过程可视化与接口式调试通道。

### 13.7 Runtime 产物形态冻结决策（VB-UX-07，2026-08-31）

本节是 Runtime 产物形态 spike 的正式决策记录（阶段 B 首个任务，输入为四领域产物设计留档 §13.1/13.2/13.4/13.6）。

**实测负载**（Unity 包同款 Newtonsoft.Json 3.2.2，.NET harness）：

| 负载 | 大小 | 解析耗时 |
| --- | --- | --- |
| Structured 单文档产物 | 1,154 B | 0.084 ms |
| Entity 单文档产物 | 1,378 B | 0.035 ms |
| Table 单文档产物（2 行） | 1,128 B | 0.028 ms |
| Graph 单文档产物 | 2,210 B | 0.049 ms |
| 合成 10k 行 Table 产物 | 835,831 B | 32-36 ms（冷/热一致） |

规模化外推约 3.5 μs/行：10 万行 ≈ 350 ms 一次性加载成本，属加载屏可接受量级；内存由 JObject 分配主导，未来可用 typed reader 优化而不改格式。

**备选方案**：A（Editor 侧物化为 Unity 原生资产，Player 走常规加载）vs B（`VisualBridge.Runtime` 升级为 Player 运行时库直读编译产物）。

**决策：B，分两步走。**

- V1（阶段 B 内）：`VisualBridge.Runtime` 从纯 metadata marker 升级为 Player 可见的加载库，直接读取 `Library/VisualBridge/Compiled` 下带 `formatVersion`/`kind` 判别的编译产物；Newtonsoft 3.2.2 既是包既有依赖又提供 AOT 程序集，Player 兼容。
- 产物格式**保持内部但版本化**，不声明公开跨语言 Schema：公开化决策已于 2026-08-31 随 VB-UX-09 关闭，保持内部格式、公开化未采用（见 [`UnityIntegrationArchitectureContracts.md`](UnityIntegrationArchitectureContracts.md) 产物公开化决策）。内部格式演进边界：结构性变更必须递增 `formatVersion` 或新增 `kind` 值；`inputs`/`mappings` 可增字段，既有字段语义永不改变。

拒绝 A 的理由：物化会在编译产物之外制造第二份派生数据（新的 drift 面与同步问题）；每域需要第二套 Unity 资产 schema；`ScriptableObject` 载体已被排除（§13），物化只能走代码生成或反射序列化，成本高于收益；调试映射（VB-UX-10 的稳定身份回溯）在物化资产中会丢失或需要重复携带。B 不排斥未来的物化导出——若出现 Addressables 等具体需求，物化器可作为消费同一产物的下游步骤叠加。

**边界与遗留项**：独立 Player 构建不含工程的 `Library` 目录，产物进入构建（如 StreamingAssets 拷贝或构建后处理）属独立 Player 产物接线的工程工作，已登记在 [`Backlog.md`](Backlog.md)；此项不影响本格式决策。

## 17. Runtime 实例发现（冻结设计，VB-UX-08，2026-08-31）

本节由 spike 实测冻结，是阶段 B 各任务（含已关闭的 VB-UX-09）实现 Runtime 通道的发现层契约；实测证据为本机 Windows 10 + Unity 6000.3.10f1 batchmode 驱动。

### 17.1 注册记录

- 位置：`<系统临时目录>/visualbridge-runtime/<instanceId>.json`（与 Editor Bridge 的 `visualbridge-bridge` 目录分离，互不读写对方记录）。
- instanceId：Play 模式实例 `editor-<Editor进程pid>`，Player 实例 `player-<Player进程pid>`——同一 Editor 的多次 Play 会话复用同一 instanceId。
- 字段：`kind`（`"editor-play"` | `"player"`）、`protocolVersion`、`capabilities`、`tcpPort`（仅监听 `127.0.0.1`）、`token`（≥192 位十六进制）、`pid`、`generation`、`startedAt`。
- 心跳：每秒 touch 记录 mtime；陈旧判定 = **心跳 >5 秒或 pid 已死双信号**——mid-play domain reload 窗口内 pid 仍活而心跳冻结（实测 Run A：泄漏记录冻结 2 分 17 秒仍可检测），此时只有心跳超时可用。

### 17.2 生命周期语义（实测冻结）

- **Play 实例**：进入 Play（含其触发的 domain reload）后 `RuntimeInitializeOnLoadMethod` 每次执行——注册或恢复磁盘记录（同 instanceId 下 `generation` 递增；实测 Run D：gen 1→2 且旧端口重绑成功，证明退出 Play 的 reload 已释放 socket）；正常退出 Play 时回收线程并删除记录。
- **关键否定事实**：mid-play domain reload（如 play 中脚本重编译）**不会**重跑 `RuntimeInitializeOnLoadMethod`——监听与心跳线程随 `ThreadAbortException` 全灭，记录泄漏且 pid 仍活。冻结对策：实现（VB-UX-09，已完成）由编辑器侧 `[InitializeOnLoad]` 兜底——reload 后检测「记录存在但监听已死」并标记失效或重新拉起；V1 允许的最坏行为是记录短暂泄漏、由心跳超时判定陈旧。
- **禁 Domain Reload 场景**：statics 跨 Play 周期存活且 `RuntimeInitializeOnLoadMethod` 仍每次执行（实测 Run B）——实现必须带 static 守卫防双重初始化，且每次 init 重置生命周期标志（否则心跳/accept 线程立即退出、记录泄漏——实测直接复现）。
- **generation 必须持久在磁盘记录中**，不能只存 static（mid-play reload 清空 statics；跨会话恢复靠磁盘，同 Editor Bridge 的 server generation 模式）。
- **Player 实例**：进程启动约 1 秒内注册；干净退出（`Application.quitting`）回收并删记录；强杀由 pid 死 + 心跳冻结双信号检测（实测 `taskkill /F` 后 mtime 冻结于死亡时刻）。Windows x64 Player 构建实测 97.5 MB / 36.7 秒（空场景），注册、TCP 监听、心跳与定时退出在 `-batchmode -nographics` 下全部正常。
- **多实例**：Play 与 Player 实例并发注册实测并存（instanceId/kind/端口互不冲突，心跳独立），VS Code 侧枚举后由调用方显式指定 `instanceId`（不设全局「当前实例」、不弹选择 UI），沿用 Editor Bridge 的「无全局当前实例」原则。

### 17.3 威胁模型（本机信任边界）

- **信任域**：本机同用户进程视为同一信任域（与 Editor Bridge 一致）。token 首条消息握手防「无意连接与陈旧会话」，不防同用户恶意进程（其本可直接读写磁盘与内存）。
- **攻击面与处置**：(a) 临时目录记录被同用户进程伪造/篡改/覆盖——接受（同信任域）；记录写入用原子替换，读取方校验 token 格式与代际。(b) 恶意进程抢占端口诱导连接——连接后 token 握手失败即断开（对齐 Editor Bridge `bridge.invalidToken` 语义）。(c) 记录残留——心跳/pid 双信号陈旧判定，绝不连接陈旧记录。(d) 端点暴露——仅 `127.0.0.1`，远程场景属阶段 C，另行威胁模型。
- **与 Editor Bridge 威胁模型的分界**：Editor Bridge 记录由 VS Code 写、Unity 读；Runtime 记录由 Unity/Player 写、VS Code 读。两套目录、token、代际与能力集完全独立，互不通用——Editor Bridge 保持 open/reveal 只读语义，Runtime 通道的写语义（调试控制）只存在于本模型的 token 握手之后。

### 17.4 工程告示

`BuildPipeline.BuildPlayer` 会改写被跟踪的 ProjectSettings（Standalone batching、Graphics、URP、UnityConnect 等，实测确认）——将来把「构建带 VisualBridge Runtime 的 Player」接入工具链时（关联 §13.7 的 StreamingAssets 遗留项），构建步骤必须隔离或回滚这些脏文件，不进入产品 diff。


## 18. Runtime Bridge 协议（冻结设计，VB-UX-09，2026-08-31）

本节冻结本机 Runtime 通道的协议设计；Schema 见 `visualbridge-runtime-bridge.schema.json`（`runtimeBridge` 版本 1），发现层遵循第 17 章。

### 18.1 共享协议核的实现方式

Editor Bridge Schema 字节冻结不改。共享核落地为：Runtime Bridge Schema 中与 Editor Bridge 语义一致的 core 形状（hello/welcome/error 消息结构、NDJSON 行分帧、≥192 位 hex token 首条消息认证、协议版本/能力协商、实例 generation）+ 每条 hello/welcome 携带的 `coreVersion: 1` 声明字段。Editor Bridge V1 事后认定为 core 兼容先例；其未来 V2 升级时才改为 `$ref` 共享 defs。新通道必须复用 core 形状并声明 coreVersion——这是本仓库的协议规范，不是可选建议。共享核独立于各通道的 `protocolVersion` 演进，互不牵连。

### 18.2 消息集

- `hello`（client→instance）：token、protocolVersion(1)、coreVersion(1)、clientInstanceId(uuid)、capabilities。
- `welcome`（instance→client）：instanceId（`editor-<pid>`/`player-<pid>`）、kind、generation、capabilities(`snapshot`/`events`)、startedAt。
- `request`/`response`（requestId 配对）：动作 `getSnapshot`（可选 `documentTypeIds` 过滤）与调试语义动作 `acquireLease`/`releaseLease`/`getDocumentSources`（见 18.3）；ok 响应携带 `documents[]`（`{documentTypeId, documentId, kind, data}`——data 为解析后的编译产物）或 `sources[]`（互斥），error 响应携带 `runtime.*` 错误码。
- `event`（instance→client）：V1 仅 `artifactsChanged`——Play 模式下监听编译产物目录变化并向已订阅客户端推送新快照。
- `error`（连接级）：`runtime.invalidToken/invalidJson/invalidMessage/unknownMessageType/protocolVersionMismatch/unknownRequest/internalError`；首条消息必须 hello，token 不符即断开（对齐 Editor Bridge）。
- 传输：仅 `127.0.0.1` TCP（无命名管道端点——发现记录无 pipePath 字段）；客户端单线程同步请求/响应模型（Mono 管道死锁教训，见 §12）。

### 18.3 调试语义与权限模型（VB-UX-10 增补，2026-08-31）

**范围裁定**：当前 `VisualBridge.Runtime` 是数据运行时（加载编译产物快照），不存在可打断点的执行引擎。按「不以占位 Schema 伪装成已完成能力」原则，断点/调用栈/变量/求值消息**不进入 Schema**——它们在真实执行运行时出现时再冻结（重开条件：出现承载业务逻辑的执行运行时，或阶段 C 远程设备调试需要）。V1 落地的真实调试面：

2026-08-31 增补：项目方确认游戏侧 Graph 执行引擎（执行过程观察需求），触发上述重开条件的前一半——执行**观察**语义按第 19 章冻结进入协议；断点/调用栈/变量求值仍不进入 Schema（项目方明确不做断点）。

- **单控制者租约模型**（「后续 Unity 连接与 Debug 设计入口」多客户端权限待决项的裁决）：同一 Runtime 实例同一时刻至多一个**连接**持有调试租约（绑定连接对象而非 clientInstanceId——同客户端重连视为新连接）；`acquireLease` 幂等、他人持有时 `runtime.leaseDenied`（detail 含持有者）；`releaseLease` 三态（ok/`leaseNotHeld`/`leaseDenied`）；连接断开自动释放；`getDocumentSources` 要求持有租约（无租约 `runtime.leaseRequired`）；`getSnapshot` 与事件订阅为观察者语义、不要求租约。抢占不静默——后来者得到明确拒绝，控制权转移只能经持有者主动释放或断线。
- **文档级 Source 映射与漂移防护**：`getDocumentSources` 返回每个运行中文档的 Authoring 源路径与 SHA-256——structured/entity/graph 取产物 `inputs.document`（严格必填），table 取其 sourceMapping 的 `sources[]`（每源文件一条）。VS Code 侧对照工作区当前文档字节计算漂移；漂移必须在调用方显式呈现（当前 Hash 与运行时 Hash 并列），阻止把新 Authoring 身份静默映射到旧 Runtime 数据。会话状态绝不写回 Authoring 源。
- 消息集增量为 Schema 内扩展（`protocolVersion` 维持 1）：capability 增 `lease`/`sources`；request action 增 `acquireLease`/`releaseLease`/`getDocumentSources`（`documentTypeIds` 仅 `getSnapshot` 允许，allOf 条件约束）；ok 响应 `documents`/`sources` 互斥（oneOf）；错误码增 `runtime.leaseRequired`/`leaseDenied`/`leaseNotHeld`。三方 parity fixture 扩至 36 例。

### 18.4 实现边界

- Unity 侧：`VisualBridge.Runtime` 按第 13.7 节决策 B 升级——asmdef 增加 Newtonsoft 预编译引用，新增 `VisualBridgeRuntimeArtifactStore`（产物根由调用方解析：Editor Play 宿主固定传 `Library/VisualBridge/Compiled`，Player 约定为 `StreamingAssets/VisualBridge/Compiled`，但 Player 侧接线尚未落地）与 `VisualBridgeRuntimeBridgeServer`（监听/注册记录/心跳，遵循第 17 章生命周期语义）；`VisualBridge.Editor` 以 `[InitializeOnLoad]` 兜底 mid-play reload 窗口。调试语义（断点/调用栈）不进入本版本——属 VB-UX-10。
- VS Code 侧：`RuntimeBridgeService` 枚举 `visualbridge-runtime` 发现目录、按调用方给定的 `instanceId` 连接与订阅（含租约控制与 Source 映射查询），并以测试命令暴露状态供自动化。DAP 只读检查适配器与 Graph 执行调试 UI 已落地（见 [`VSCodeGraphEditor.md`](VSCodeGraphEditor.md) 与 [`UnityGraphExecutionDebug.md`](UnityGraphExecutionDebug.md)）；仍不支持断点、单步与表达式求值。
- 三方 parity fixture：`visualbridge-runtime-bridge-cases.json` 由 AJV（generate.mjs）、Unity 严格校验器（EditMode）与扩展宿主测试共同消费；用例数随协议增量扩展（VB-UX-10 为 36 例，VB-UX-13 起为 56 例），以 fixture 文件为准。

### 18.5 VS Code DAP 检查适配器（VB-UX-11，2026-08-31）

DAP 适配器以**只检查会话**形态落地（范围裁定与 18.3 一致——无执行引擎即无断点/单步/暂停语义）：debug type `visualbridge-runtime`、仅 attach；会话生命周期映射为连接实例 + `acquireLease`（断开即 releaseLease）；单伪线程/单帧/单 scope 仅满足 DAP 结构要求，变量树即 getSnapshot 的真实运行时数据（惰性展开、单层 500 上限、`__sourcePath`/`__sourceDrifted` 信息变量来自 getDocumentSources 与工作区字节比对）；断点一律 `verified:false`、能力声明如实为空——不伪造执行状态。适配器是纯翻译层：全部状态来自 Runtime Bridge 协议（单一事实源），断开释放租约后其他客户端可立即接管（E2E 有断言）。E2E 覆盖：真实 Unity Play 实例 attach→变量树/漂移全零断言→断开；host 测试以假实例验证租约抢占/释放语义。

## 19. Graph 执行过程可视化（冻结设计，VB-UX-13~16，2026-08-31）

### 19.1 范围与定位

项目方期望（2026-08-31 逐项确认）：从运行时获取 Graph 的执行过程，在 VS Code Graph 页面中显示（调试指定图），获取浅快照状态；**不做断点**。这触发了 18.3 记录的重开条件的一半——「执行运行时出现」：Graph 的执行发生在**游戏侧引擎**（项目方参考实现：ActionEditor `FlowGraph` Runtime——节点 Start/Output/DataNode/边值变化四类事件、`IFlowDebugerProvider` 插桩缝、`NodeUIDs` 稳定 ID 表）。VisualBridge 的职责因此是**采集、传输、订阅与可视化**，不是执行引擎：`VisualBridge.Runtime` 保持数据运行时定位（13.7 决策 B）不变，不引入节点调度或求值语义。

边界裁决：

- **创作权在 VisualBridge（方案 A）**：`.vbflow` 文档是唯一创作源；编译导出游戏执行数据时 VisualBridge 节点稳定 ID 一路带入游戏侧 UID 表（`NodeUIDs` 的等价物），调试事件回传时携带 VisualBridge 稳定 ID，页面直接点亮对应节点。
- **导入器归游戏侧**：`.vbflow` 编译产物 → 游戏执行数据的转换（含稳定 ID 进 UID 表）是游戏工程职责，不进 VisualBridge 仓库；VisualBridge 保证图编译产物节点稳定 ID 完整保留（现有产物已满足），并以文档写清映射规则（游戏侧接入指南，随 VB-UX-14 落地）。
- 与 18.3 的关系：执行**观察**语义进入协议（本章）；断点/调用栈/变量求值仍不进入 Schema——项目方明确不做。

### 19.2 事件与实例模型

- **执行实例**：游戏侧上报 `(graphId, graphName, debugKey)`（debugKey 为游戏侧执行者标识，如角色）→ VisualBridge 分配 `instanceId`；实例停止上报 `instanceId`。同一张图可被多个执行者并发执行，每个 Start 一个实例。
- **事件类型**：`instanceStarted` / `instanceStopped` / `nodeStart` / `nodeOutput` / `dataNode` / `edgeValueChanged`。
- **字段**：每条事件携带 `executionId`（执行实例 ID，区别于 Runtime 实例的 `instanceId`）、`frameIndex`（逐条携带，非整批一个）、`nodeId`（VisualBridge 文档稳定节点 ID）；端口类事件含 `outputIndex`；值变化事件含值字符串。回放支持**事件级与帧级**两种步进粒度，同帧事件保持原始顺序。
- **单实例跟踪**：页面一次只跟一个执行实例，实例列表可切换；事件按 `instanceId` 分流，不聚合混显。

### 19.3 协议扩展（Runtime Bridge 纯增量）

- 新请求动作：`getGraphExecutionInstances`（可选按 `documentId` 过滤，返回执行实例列表：`executionId`、`documentTypeId`/`documentId`、图名、`debugKey`、运行状态、当前节点、`frameIndex`）、`subscribeGraphExecution` / `unsubscribeGraphExecution`（按 `executionId`；退订即停采）、`getGraphExecutionSnapshot`（浅快照：实例元信息 + 当前节点 + 运行状态，不含变量池 dump——边的值由事件流补齐，游戏侧 provider 缝无需状态查询能力）。
- 新事件消息 `graphExecution`：**批量数组**承载（载荷键 `executionEvents`，非空），冲刷节奏「每 100ms 或满 64 条，先到先冲」；不要求同帧送达（项目方确认）。
- **权限语义：观察者级别，不占租约**——与 `getSnapshot`/`artifactsChanged` 同级；多个客户端可并行观察同一实例，与 DAP 租约、MCP 连接互不影响。
- Schema 纪律（VB-UX-13 落地裁定，2026-08-31）：**能力门控的纯增量扩展**——新增 `graphExecution` 能力值与 `runtime.executionNotFound` 错误码，全部新消息由能力门控；沿用 VB-UX-10 增补 lease/sources 的先例，`protocolVersion`、发现记录 `formatVersion` 与 manifest `versions.runtimeBridge` 均保持 1（该注册值绑定发现记录 formatVersion，递增即破坏既有客户端的记录解析，与纯增量目标冲突）。fixtures 三方（AJV / Unity 严格校验器 / 扩展宿主）一致，56 例共存于既有 parity fixture；MCP 侧协议镜像同步接受新能力值（其 hello 声称集仍为四能力——MCP 不消费执行观察）。

### 19.4 Unity 侧采集缝

- `VisualBridge.Runtime` 提供静态门面 `VisualBridgeGraphExecutionCapture`：`OnInstanceStarted(documentTypeId, documentId, graphName, debugKey, out executionId)` / `OnInstanceStopped(executionId)` / `OnNodeStart` / `OnNodeOutput` / `OnDataNode` / `OnEdgeValueChanged`（均含 executionId + frameIndex，节点参数用 VisualBridge 稳定节点 ID）。**执行实例 ID（`exec-<n>`）由 VisualBridge 分配**，游戏侧不自造 ID 体系。
- **待移除**：本节采集门面与 §19.3 的 `graphExecution` 协议在阶段 T 完成后删除；新接入使用 §20 的接口式调试通道，不要再新增本路径的消费者。
- **零订阅零开销**：`static bool` 快速路径，无人订阅时全部方法直接返回；不采用参考实现的 `[Conditional]` 编译宏——无需重编译即可开关。
- 采集与传输解耦：门面只负责收集进缓冲；订阅驱动的转发由现有 `VisualBridgeRuntimeBridgeServer` 通道承载（与 `artifactsChanged` 同级生命周期）。mid-play domain reload 语义沿用第 17 章（generation/心跳）。
- **游戏侧职责**：写一个小适配器实现其引擎自身的 debug provider 接口，把事件转发到上述门面；引擎与 VisualBridge 互不引用。

### 19.5 VS Code 页面交互

- **调试入口在 Graph 编辑器页内**：工具栏「执行调试」按钮打开面板，面板内的「刷新」按钮拉取当前打开图的活跃实例列表（debugKey、运行状态、当前节点、frameIndex）→ 选择实例 attach 并订阅。入口只服务当前打开的图。落地实现不自动拉取：打开面板时的再水化消息（`graphExecutionDebugState`）只恢复订阅态、事件记录与停止标记，不含实例列表与运行时连接态，因此未点「刷新」前面板恒显示「未发现运行时实例」，不能据此判断 Unity 是否在 Play 模式。
- **实时态**：当前执行节点持续高亮（描边/呼吸），刚经过的边短暂流光，数据边旁显示最近值（值变化事件驱动）；时间轴默认跟随最新。
- **回放态**：扩展宿主留存本会话完整事件记录（内存，不落盘）；拖动时间轴或按步进（事件级/帧级）暂停实时进入回放，可「回到实时」；实例停止时自动停在记录末尾，可从实例列表切换新实例。
- **断开语义**：关闭页面或点击停止调试即退订，Unity 侧采集随之停止；记录随会话丢弃。
- 单一事实源不变：执行流与 DAP 检查、MCP 工具同源（Runtime Bridge 协议），可并行使用。

## 20. 调试通道

本节记录 2026-10-22 落地的接口式调试通道（阶段 U）。它把调试契约从字符串事件改为 C# 接口：业务代码调用生成的静态门面，门面在未连接时短路，生成实现通过 `VisualBridgeDebug` 拼装消息。本节只覆盖 Unity 侧；VS Code 消费（阶段 C）与两端连接/传输（阶段 T）尚未实现。

### 20.1 分层与程序集边界

```
业务 / 引擎代码
  → <X>Debuger（生成，static 门面，唯一短路点）
  → VisualBridgeGenerated<X>Debuger / ...Dispatcher（生成实现）
  → VisualBridgeDebug（手写门面）
  → DebugMessageBuilder + 有界队列 + 写线程
  → IDebugFramer（默认 NdjsonFramer）
  → IDebugTransport（阶段 T 接入）
```

- 生成的事件与查询结果门面只在 `isDebugBuild && isConnected` 为真时继续调用；否则直接返回，不构造消息、不入队。生成门面中的 `DescribeInstance` 由运行时门面按 `isConnected` 短路。
- `VisualBridgeDebug` 不认识任何具体模块、接口或参数类型；生成代码负责把接口调用翻译成 `Start` / `PushParam` / `End`。
- 程序集 `VisualBridge.Debug`（`Packages/com.kyle.visualbridge/Runtime/Debug/`，rootNamespace `VisualBridge.Debug`）自包含：不引用 `VisualBridge.Runtime`，也不引用编辑器程序集；`autoReferenced: true`，业务程序集无需显式引用即可使用特性与门面。它预编译引用 `Newtonsoft.Json.dll`，并允许 UnityEngine API（`ConnectType` 判定与 `RuntimeInitializeOnLoadMethod` 引导）。
- `VisualBridge.Editor` 引用 `VisualBridge.Debug`，承载代码生成器、菜单与 batch 入口。生成物写入接口声明的目录（`Assets/` 或 `Packages/` 下），不进入包运行时程序集。
- 宏关闭时程序集仍然存在（不使用 `defineConstraints`），公开 API 退化为空方法；因此插桩代码在任何构建下都能编译。

### 20.2 编译宏与短路

- 实现由 `UNITY_EDITOR || VISUALBRIDGE_RUNTIME_BRIDGE` 隔离：宏开启时 `isDebugBuild` 为编译期常量 `true`，队列、写线程与请求注册表存在；宏关闭时 `isDebugBuild` 为 `false`，上述方法全部为空实现。
- `isConnected` 只在传输已挂载且报告连接成功时为 `true`；它不决定代码是否参与构建。
- `Start` / `PushParam` / `End` 在 `isConnected == false` 时直接返回，是零分配、零编码路径。`PushParam` 共 9 个重载：`bool`、`int`、`long`、`ulong`、`float`、`double`、`Enum`、`string`、`byte[]`。
- 生成器产出的 `enum` 参数编码为成员名，`byte[]` 编码为 Base64，`long` / `ulong` 编码为字符串（避免 JSON 数值精度丢失）。
- 运行时计数器 `VisualBridgeDebug.Counters` 除测试用 `Reset()` 外只增不减：`malformed`（未 `End` 就再次 `Start`、成帧异常等）、`droppedQueue`（队列溢出）、`oversize`（单条超限）、`filtered`（未 `Start` 就调用 `PushParam` / `End`）、`handlerErrors`（查询处理器异常）。

### 20.3 启动策略

`VisualBridgeConnectType` 由运行环境判定：`Application.isEditor && Application.isPlaying` → `EditorPlayer`；`Application.isEditor` → `Editor`；否则 → `Player`。

| `ConnectType` | 自动启动 | 说明 |
| --- | --- | --- |
| `Editor` | 否 | 编辑器非播放态永不启动任何调试传输。 |
| `EditorPlayer` | 默认否 | 仅当 `Enabled && AutoStartInEditorPlay` 为真时自动启动；默认 `AutoStartInEditorPlay = false`。 |
| `Player` | 是 | 仅当 `Enabled && AutoStartInPlayer` 为真时自动启动；默认两者均为 `true`。 |

- 引导入口是 `VisualBridgeDebugBootstrap` 的 `[RuntimeInitializeOnLoadMethod(BeforeSceneLoad)]`；`Application.quitting` 时调用 `StopTransport()`。
- 手动入口：菜单 `Tools/VisualBridge/Debug/Start Debug Bridge (Editor Play)`，仅在播放模式生效，调用幂等的 `StartTransport()`。
- `StartTransport()` 在 `Editor` 下无效；`StopTransport()` / `Detach()` 可重复调用。Domain Reload 会重置静态状态，`EditorPlayer` 下的手动启动状态不跨 reload 保留。
- **当前限制（阶段 T 未接入）**：`StartTransport()` 只挂载 `NullDebugTransport`，`isConnected` 保持 `false`，并在 Console 输出 `debug transport not available`；菜单同样报告「调试传输尚不可用」。启动策略与插桩可以先落地，但数据不会发出。

### 20.4 契约与代码生成

契约是带 `[VisualBridgeDebuger]` 的 C# 接口。特性字段：

| 字段 | 语义 |
| --- | --- |
| `Category`（构造参数） | 协议分类，如 `graph`；必须是非空文件名片段。 |
| `GeneratedDirectory` | 生成物目录，必填；必须是工程根下 `Assets/` 或 `Packages/` 内的路径。 |
| `Version` | 接口版本，默认 `1`，写入每条消息的 `version`。 |
| `Kind` | `Event`（默认）或 `Query`。 |
| `InstanceParameter` | 承载调试实例标识的参数名；必须是 `string`。为空表示无实例维度（`instance = ""`）。 |
| `FrameParameter` | 承载帧号的参数名；必须是 `int` 或 `long`。为空表示不支持按帧步进。 |

参数可用 `[VisualBridgeDebugTag(n)]` 显式指定 tag；未标注时从 `0` 起按声明顺序递增，显式值必须严格大于前一个 tag。

接口硬性规则：必须 `public`、顶层、非泛型、不继承其它接口；只允许方法，不允许属性/索引器/事件；方法必须返回 `void`，不允许重载、泛型方法、`ref`/`out`/`in`、可选参数或 `params`。参数类型限定为 `bool`、`int`、`long`、`ulong`、`float`、`double`、`string`、`byte[]`、`enum`；`byte` / `sbyte` / `short` / `ushort` / `char` 收窄为 `int`，`uint` 收窄为 `long`。结构化数据由调用方自行序列化为 `string` 或 `byte[]`。违反规则时生成器以 `VBDBG001`–`VBDBG019` 诊断失败，不写半成品。

生成物（与接口同命名空间）：

- 命名根（stem）= 接口名去掉前导 `I` 与后缀 `Debuger`；门面文件名 = stem + `Debuger.g.cs`，实现类名 = `VisualBridgeGenerated` + stem + `Debuger`。以 `IGraphDebuger` 为例：`GraphDebuger.g.cs` + `VisualBridgeGeneratedGraphDebuger.g.cs`。
- 事件接口：静态门面含与接口同名的方法和可选的 `DescribeInstance`；生成实现只做 `Start` / `PushParam` / `End`。
- 查询接口：静态门面含 `Register` / `Unregister` / `Send<Method>Result`；另生成 `VisualBridgeGenerated<stem>DebugerDispatcher.g.cs`（按方法名分发入站请求）。以 `IGraphQueryDebuger` 为例：`GraphQueryDebuger.g.cs` + `VisualBridgeGeneratedGraphQueryDebugerDispatcher.g.cs`。
- 每个生成目录输出一份 `debug-contracts.json`（`schemaVersion: 1`），列出接口 id、category、version、kind、实例/帧参数、方法参数与 tag、枚举成员，供客户端与传输层共用。
- 目录已在既有 asmdef 覆盖范围内时直接写入；接口位于 asmdef 程序集且目录无 asmdef 时，生成器补一个引用接口程序集与 `VisualBridge.Debug` 的 asmdef；预定义程序集（`Assembly-CSharp` 等）不写 asmdef。既有 asmdef 内容不符时拒绝覆盖。

入口：

- 菜单 `Tools/VisualBridge/Debug/Generate Debug Contracts`。
- batch `VisualBridge.Editor.VisualBridgeDebugContractBatch.Generate` / `.Check`；`Check` 逐字节比较磁盘产物，发现漂移以退出码 `1` 结束，成功为 `0`。
- 扫描通过 `TypeCache.GetTypesWithAttribute<VisualBridgeDebugerAttribute>()`，跳过名称以 `.Tests` / `.Test` 结尾的程序集。
- 样例接口与生成物位于 `Packages/com.kyle.visualbridge/Tests/Editor/Debug/Fixtures/` 与 `Packages/com.kyle.visualbridge/Tests/Editor/Debug/Generated/`。
- **`Check` 的覆盖边界**：由于上述跳过规则，本仓库唯一的契约样例位于 `VisualBridge.Editor.Tests`，因此 `Check` 在本仓库发现 0 个接口并恒成功。样例生成物的门禁是 `Packages/com.kyle.visualbridge/Tests/Editor/Debug/VisualBridgeDebugGeneratedContractTests.cs`，不是 `Check`；`Check` 只用于校验游戏工程里非测试程序集中的接口。
- **生成目录的 asmdef 前提**：若 `GeneratedDirectory` 位于一个既有 asmdef 下，该 asmdef 必须显式引用 `VisualBridge.Debug`（`autoReferenced` 只对预定义程序集生效）；查询接口生成的门面使用 `UnityEngine.Debug.LogWarning`，因此所在 asmdef 必须 `noEngineReferences: false`。生成器目前不会自动校验这两点（已知限制）。

### 20.5 查询方向

查询接口只声明请求方法；结果由生成的统一方法回发：

```
客户端请求（阶段 T 解码）→ VisualBridgeDebug.OnRequest
  → 按接口全名查找处理器（由 <X>QueryDebuger.Register 安装）
  → 生成分发器校验参数并调用业务实现
  → 业务实现调用 <X>QueryDebuger.Send<Method>Result(<instance>, requestId, payload)
  → Start(category, version, interface, method, instance, requestId, frame) → PushParam → End → debugResult
```

- 运行时签名：`Start(string category, int version, string iface, string method, string instance = "", string requestId = null, long frame = -1)`；`frame` 缺省 `-1` 表示无帧号。
- `Register(implementation)` 以接口 FullName 注册处理器；重复注册以最后一次为准并输出警告；`Unregister()` 移除。
- 生成分发器按下标取参（NDJSON 不写 tag；生成代码调用 `request.TryGetArg(<参数下标>, out ...)`），并做基础类型/enum 转换。参数不合法时回 `invalidArgument`；接口未注册时回 `unregistered`；处理器抛异常时回 `handlerError` 并累加 `handlerErrors`。
- 结果签名固定为 `Send<Method>Result(<instance>, string requestId, string payload)`：`payload` 只支持字符串，由业务实现自行序列化；结果消息携带 `requestId`，生成的结果方法不传帧号（`frame = -1`），即使接口声明了 `FrameParameter` 也不适用于查询结果。
- `requestId` 由客户端生成、Unity 侧原样带回；超时与重试由客户端负责，Unity 侧不重试。

### 20.6 成帧与传输接缝

- 传输层只认识信封（`DebugMessageHeader`）与消息体，不认识业务接口。消息类型为 `debug`（单向事件）、`debugResult`（查询结果）、`debugInstance`（实例显示名与关键词）。
- 默认成帧器 `NdjsonFramer`：一条消息一行 UTF-8 JSON，以 `\n` 结尾；读取时接受 `\r\n` 与空行。单行上限 `1_048_576` 字节，超限丢弃并计数（读取侧按协议错误处理）。信封字段为 `type`、`seq`、`category`、`instance`、`interface`、`version`、`method`、可选的 `frame`、`args`；`debugResult` 额外携带 `requestId`。
- `args` 只写 `name` 与 `value`，不写 `tag`；接收侧先按 tag 查找，线格式无 tag 时按位置回退。
- `seq` 在入队锁内分配，随入队顺序单调递增。有界队列容量 16384，溢出丢弃最旧并累加 `droppedQueue`；写线程按「满 64 条或距上次冲刷 100 ms」批量写出；`Detach` 先最多等待写线程 100 ms，再以 100 ms 预算冲刷剩余消息；连接断开时清空队列、不补发。
- 传输接口为 `IDebugTransport`（`IsConnected`、`ConnectionChanged`、`Send`、`SendBatch`、`Dispose`）；门面通过 `Attach` / `Detach` / `StartTransport` / `StopTransport` 管理，`SetFramer` 可替换成帧器。
- **阶段 T 未接入**：当前没有 TCP 监听、端口、发现记录、握手、ack 窗口或入站解码；`Attach` 的实际传输实现、以及把入站消息还原为 `VisualBridgeDebugRequest` 后调用 `OnRequest` 都属于阶段 T。因此现阶段 `isConnected` 恒为 `false`。
- 本通道的 wire Schema 尚未进入 `Protocol/`；在阶段 T 冻结前，`NdjsonFramer` 与 `DebugMessageHeader` 是唯一实现。

### 20.7 与 Graph 执行观察的关系

- §19 的 `VisualBridgeGraphExecutionCapture` 与 `graphExecution` 批量协议是字符串事件路径，**待移除**：阶段 T 完成后与旧 VS Code 消费路径一并删除。
- 新接入使用本节的接口式通道：Graph 事件对应关系、接口声明、插桩与查询注册方式见 [Unity Graph 执行过程调试接入指南](UnityGraphExecutionDebug.md)。
- 迁移窗口内两条路径可以并存，但同一条执行链路不要重复上报；旧路径不再新增消费者。
