# VisualBridge Backlog

> 本文件登记仓库中**明确未实现**的能力，不构成实施承诺。整理日期：2026-10-22；各项决策日期以其记录文档为准。已完成的历史路线图见 [`Archive/`](Archive/)，当前正式架构见 [VisualBridge 架构设计](VisualBridgeArchitecture.md) 与 [Unity Editor 接入架构](UnityIntegrationArchitecture.md)。

Backlog 中的能力都不是当前协议或产品契约的一部分。任何一项开始实施前，都必须先完成对应的设计或 spike、威胁模型（涉及连接与安全时）与验收门槛，再进入 Protocol Schema 或公开产品面；不得用占位 Schema 或未接线的入口伪装成已完成能力。

## 1. 远程与设备连接（阶段 C）

- **状态**：未实现。项目方于 2026-08-31 明确推迟，未分配任务号。
- **范围边界**：跨网络边界的端点安全暴露（防火墙、设备/实例寻址）、配对与凭据生命周期（首次信任建立、撤销、轮换）、传输加密、跨机器审计与错误恢复。不承诺与阶段 B 同协议版本；若远程要求传输层换形，按其自身版本演进。不得绕过单一权威源原则与 `ScriptableObject` 排除条款。
- **验收标准**：独立 spike 与威胁模型先行并冻结进架构文档；跨机器实例发现、配对、撤销与重连有自动化或可复现手工验证；本机阶段全部门槛回归不受影响；远程能力不改变 Authoring 源文件的权威地位。
- **未实施原因/决策日期**：阶段 B 只承诺本机回环（`127.0.0.1`）；远程/设备需要独立的发现、凭据、端点安全与审计设计，不能在阶段 B 协议上直接外推。2026-08-31 项目方决策推迟。
- **相关文档**：[Unity Editor 接入架构](UnityIntegrationArchitecture.md)、[阶段 C 范围登记](Archive/UnityDomainAndRuntimeRoadmap.md#6-阶段-c远程与设备连接范围登记不分配任务号)、[仍待决项](VisualBridgeArchitectureIntegration.md#仍待决项)。

## 2. 独立 Player 构建产物接线

- **状态**：未实现。Runtime 产物格式已冻结，独立 Player 构建的产物进入构建与加载接线尚未落地。
- **范围边界**：独立 Player 构建不包含工程的 `Library` 目录；需要确定编译产物如何进入构建（如 `StreamingAssets` 拷贝或构建后处理）、Player 侧产物根如何解析与校验，以及构建步骤如何隔离或回滚 `BuildPipeline.BuildPlayer` 对受跟踪 ProjectSettings 的改写。不改变已冻结的产物格式，不包含远程传输或 Graph 执行引擎。
- **验收标准**：干净 checkout 构建出的独立 Player 能在没有 `Library` 的条件下加载所需产物；Runtime 实例发现、连接、快照、租约、Source 映射与事件链路在 Player 构建上通过 E2E；构建后受跟踪 ProjectSettings 无产品 diff（或已隔离/回滚）；文档记录产物根与构建接线方式。
- **未实施原因/决策日期**：VB-UX-07（2026-08-31）只冻结产物形态，明确把独立 Player 的构建接线留给后续 Runtime 任务；同时实测确认 `BuildPipeline.BuildPlayer` 会改写受跟踪 ProjectSettings，必须先解决构建隔离。
- **相关文档**：[Runtime 产物形态冻结决策](UnityIntegrationArchitectureRuntime.md#137-runtime-产物形态冻结决策vb-ux-072026-08-31)、[实现边界](UnityIntegrationArchitectureRuntime.md#184-实现边界)、[Unity 集成与 Bridge 边界](VisualBridgeArchitectureIntegration.md#unity-集成与-bridge-边界)。

## 3. WebSocket 传输

- **状态**：未实现。当前 Editor Bridge 与 Runtime Bridge 的本机传输是 `127.0.0.1` TCP + NDJSON 行分帧 + 首条消息 token 握手；WebSocket 只是候选技术选项，不是已定协议。
- **范围边界**：定义 WebSocket 作为传输绑定时的握手、认证、配对、版本/能力协商、消息分帧、重连、错误信封与安全策略；不得改变各通道的语义 Schema，不得向 Editor Bridge 增加 Runtime/Debug/Player 字段。Project Discovery File 与 loopback/network WebSocket 都需要单独设计与威胁模型验证。
- **验收标准**：独立设计与威胁模型先冻结进架构文档；Protocol 中形成可生成的传输绑定契约；认证、版本协商、断线与重连有自动化测试；本机 WebSocket E2E 与现有 TCP Bridge E2E 均通过；文档明确适用的网络边界与不支持项。
- **未实施原因/决策日期**：架构基线刻意不预选 Discovery File 或 WebSocket；阶段 B 仅监听本机回环。2026-08-31 决策记录将 WebSocket 保留为候选，进入 Schema 前必须完成单独验证。
- **相关文档**：[仍待决项](VisualBridgeArchitectureIntegration.md#仍待决项)、[实例发现与通信：已冻结的答复](VisualBridgeArchitectureIntegration.md#实例发现与通信已冻结的答复)、[Runtime Bridge 实现边界](UnityIntegrationArchitectureRuntime.md#184-实现边界)。

## 4. 断点、调用栈与表达式求值

- **状态**：未实现。断点、暂停/继续/单步、调用栈、变量求值与表达式求值均**不进入 Schema**；DAP 适配器以只检查会话形态落地，断点一律 `verified:false`、能力声明如实为空。
- **范围边界**：只有出现承载业务逻辑、可暂停的执行运行时后才重新冻结这些语义；届时需要定义断点集合、暂停/继续/单步、调用栈、变量与表达式求值的消息集与权限模型。Graph 执行过程可视化只做观察与回放，不提供断点；执行引擎与产物导入器归游戏侧。
- **验收标准**：真实 Unity Play/Player 上存在可暂停的执行运行时；Runtime 协议扩展与 DAP 能力声明一致且不伪造状态；断点、调用栈、变量/表达式求值在真实执行实例上有 E2E；适配器内不建立第二份调试状态；现有只检查会话与本机门槛保持通过。
- **未实施原因/决策日期**：当前 `VisualBridge.Runtime` 是数据运行时（加载编译产物快照），不存在可打断点的执行引擎；按“不以占位 Schema 伪装成已完成能力”原则不落占位协议。2026-08-31 裁定；同日项目方确认 Graph 执行**观察**可进入协议，但断点/调用栈/变量求值仍不进入。
- **相关文档**：[调试语义与权限模型](UnityIntegrationArchitectureRuntime.md#183-调试语义与权限模型vb-ux-10-增补2026-08-31)、[DAP 检查适配器](UnityIntegrationArchitectureRuntime.md#185-vs-code-dap-检查适配器vb-ux-112026-08-31)、[Graph 执行过程可视化的范围与定位](UnityIntegrationArchitectureRuntime.md#191-范围与定位)、[Debug 边界：已冻结的答复](VisualBridgeArchitectureIntegration.md#debug-边界已冻结的答复)。

## 5. 独立产品 CLI

- **状态**：未实现。仓库当前没有独立发布的 VisualBridge CLI；命令行入口是 npm scripts、VS Code 命令、stdio MCP Server 与 Unity batchmode `-executeMethod`。
- **范围边界**：独立 CLI 可覆盖工程发现、Catalog/Document 校验、Export/Compile、Operation、诊断与机器可读输出，但必须复用 Core Parser、Operation、Lifecycle、Project Transaction 与 `baseHash` 规则，不得形成第二套业务规则；CLI 不替代 MCP 或 VS Code 扩展，也不通过 Provider V2 绕过既有约束。
- **验收标准**：稳定的 CLI 入口与命令集；结构化诊断、稳定退出码、`check`/dry-run 模式与机器可读输出；所有业务语义来自共享 Core 服务并有自动化测试；发布与安装文档完整；现有 MCP、VS Code 与 Unity batch 门槛不受影响。
- **未实施原因/决策日期**：路线图明确“当前不发布独立产品 CLI”；Provider V2 也明确排除独立 VisualBridge CLI。现有 npm scripts 与 Unity batchmode 已覆盖维护者工作流，独立 CLI 会新增分发、兼容与支持面，需单独立项。2026-08-31 范围裁定。
- **相关文档**：[命令与验证层级](UnityIntegrationArchitectureEditorBridge.md#14-命令与验证层级)、[Project Provider V2](ProjectProvider.md)、[Unity Editor 接入任务清单（已归档）](Archive/UnityIntegrationRoadmap.md)。

## 6. Unity 侧 XLSX 载体编译

- **状态**：未实现。Table V1 的 Unity 侧离线编译只支持 CSV family；`.xlsx` 路由到 table documentType 时以 `table.xlsxUnsupported` 明确拒绝。
- **范围边界**：在 Unity 侧直接消费 XLSX（OOXML zip+xml）并产出与 CSV family 等价语义的编译产物，包括工作表/分区映射、cell encoding、有效行去重与 Source 映射。不得建立 Table Exporter 或 `ScriptableObject` 包装层；不包含宏、`.xls`、透视表、图表、外部链接、公式编辑与任意工作簿往返保真。
- **验收标准**：Unity 编译器可直接读取 XLSX 并产出与同一 Catalog/数据等价于 CSV family 的产物；工作表顺序、分区、cell encoding、`error`/`keepFirst`/`keepLast` 去重策略有 parity 测试；不新增违反依赖策略的第三方解压/解析依赖（或先完成依赖决策）；`table.xlsxUnsupported` 仅保留给不受支持的 XLSX 子集；文档更新。
- **未实施原因/决策日期**：XLSX 是 OOXML zip+xml，Unity 侧没有内置等价物，且 Package 不引入第三方解压/解析依赖；V1 先以 CSV family 收敛载体边界。2026-08-31 范围裁定。
- **相关文档**：[Table Import / Compile 设计记录](UnityIntegrationArchitectureContracts.md#134-table-import--compile-设计记录vb-ux-042026-08-31)、[Table Semantic Model V1 的 XLSX 边界](TableSemanticModel.md#9-xlsx-边界)、[Unity 领域扩展任务清单（已归档）](Archive/UnityDomainAndRuntimeRoadmap.md)。

## 7. 调试通道传输层与 VS Code 消费

- **状态**：部分实现。Unity 侧接口式调试通道（阶段 U）已落地：`VisualBridge.Debug` 程序集、`VisualBridgeDebugerAttribute` / `VisualBridgeDebugTagAttribute`、运行时门面 `VisualBridgeDebug`、`NdjsonFramer`、代码生成器与样例生成物均可用。传输层（阶段 T）与 VS Code 对新通道的消费（阶段 C，消费侧；区别于第 1 项的远程连接阶段 C）未实现：`StartTransport()` 只挂载 `NullDebugTransport`，`isConnected` 恒为 `false`，消息不会离开进程。
- **范围边界**：传输层负责端点发现、端口与 token 协商、握手与 ack、断线与重连、入站请求解码；VS Code 侧负责调试会话注册、实例树、事件流与查询结果的呈现。两端都不得改变已冻结的消息类别（`debug` / `debugResult` / `debugInstance`）与字段语义，也不得在 `Protocol/` 之外另立线格式。本通道只在本机回环内工作，跨网络与设备连接仍归第 1 项，不在本项范围。调试通道只观察运行时，不提供断点、暂停或表达式求值；这些仍属第 4 项。
- **验收标准**：Unity Player 与 Editor Play 能按启动策略建立连接，`ConnectType` 与 `isConnected` 反映真实状态；事件按 `seq` 有序到达且超过队列上限时按既有计数丢弃；查询请求能在时限内返回带同一 `requestId` 的结果，`invalidArgument` / `unregistered` / `handlerError` 可复现；断线重连与退出清理有自动化或可复现手工验证；VS Code 侧能列出实例、订阅事件并展示查询结果；现有本机 Editor/Runtime Bridge 门槛不回归。
- **未实施原因/决策日期**：阶段 U 只冻结并实现 Unity 侧契约、生成与成帧，刻意把传输与客户端消费拆分为独立阶段，避免在协议未验证前扩散到 VS Code。2026-10-22 实施计划裁定。
- **相关文档**：[调试通道](UnityIntegrationArchitectureRuntime.md#20-调试通道)、[Unity Graph 执行过程调试接入指南](UnityGraphExecutionDebug.md#7-接口式调试通道)、[VS Code Host](VSCodeHost.md)。

## 8. 旧 `graphExecution` 路径移除

- **状态**：待移除。`graphExecution` 消息、`VisualBridgeGraphExecutionCapture` 采集门面与相应 VS Code 消费仍在仓库中，作为调试通道迁移期的唯一可用数据路径保留。
- **范围边界**：阶段 T 完成后删除旧路径的采集门面、`graphExecution` 消息与能力声明、对应的四个请求动作（`getGraphExecutionInstances`、`subscribeGraphExecution`、`unsubscribeGraphExecution`、`getGraphExecutionSnapshot`）、VS Code 消费、fixture 与测试。删除前必须先确认新路径具备等价的事件覆盖与实例标识能力；不得为了过渡保留两套并行上报。
- **验收标准**：仓库内不再有 `graphExecution` 消息类型或采集门面的引用；新接口路径通过原有 Graph 执行观察的 E2E；VS Code 调试会话只消费新通道；文档与生成产物同步更新，Backlog 本项关闭。
- **未实施原因/决策日期**：旧路径是新通道的当前数据来源，阶段 T 未接入前删除会造成功能空窗。2026-10-22 实施计划决定在阶段 T 完成后删除。
- **相关文档**：[迁移状态](UnityGraphExecutionDebug.md#0-迁移状态)、[与 Graph 执行观察的关系](UnityIntegrationArchitectureRuntime.md#207-与-graph-执行观察的关系)、[Unity Graph 执行过程调试接入指南](UnityGraphExecutionDebug.md)。
