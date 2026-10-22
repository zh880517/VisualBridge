# VisualBridge 架构：宿主集成与边界决策

本文是 [VisualBridge 架构设计](VisualBridgeArchitecture.md) 的子文档，覆盖 Unity 集成与 Bridge 边界、AI 与 MCP、平台仓库结构、开发方案、关键风险与已确定的架构决策。

## Unity 集成与 Bridge 边界

### 定位

首个 Unity Structured offline、Editor-only 垂直切片已经实现：

- `ProjectSettings/VisualBridgeIntegration.json` Profile V1 显式登记一个 Unity Project 内的 Authoring Project、Structured export units 和固定编译输出根；
- Package metadata marker 以 Attribute 显式登记普通 C# `class` / `struct`、Catalog/Config/Field stable ID、alias、默认值和 editor hint；
- Editor Exporter 确定性生成或检查 Structured Catalog V1，不执行配置类型构造函数或业务初始化；
- Editor Compiler 严格读取 Project、Catalog 与 Document，按 `documentRoots`/`include`/`exclude` 和 Document Type ID 唯一路由，在 `Library/VisualBridge/Compiled` 生成可重建 artifact、source mapping 与 managed manifest；
- 菜单、Unity batchmode Generate/Check 与 EditMode tests 复用同一 Export/Compile 服务，VS Code 和 Bridge 均不是前置。

Graph Catalog V4 与 Entity Catalog V1 的 Unity Export、以及 Structured / Entity / Table / Graph 四域的离线 Compile 均已落地。Graph Exporter 把稳定 `catalogId`/显示根 `title`、Graph/Node Type 的显式全局无歧义 ID、节点 Catalog 归属、Graph 用途、`supportedCatalogIds`、`portConnectionRules`、允许节点 selector、实例数量约束、初始节点以及 typed subgraph 目标类型写入确定性 Catalog；C# 全名只作为 `source` 追踪信息，不能充当持久身份。Entity Catalog Exporter 只扫描正式项目中使用的普通 class / struct，不引入 `ScriptableObject` 包装层，并将数值、颜色、List 和普通自定义结构递归映射到全项目共享字段模型。Table 是纯消费方：`.vbtablecatalog` 由 VS Code 侧创作并提交，Unity 侧只校验并编译 CSV family（XLSX 载体编译不在 V1 范围）。

已冻结的决策是**不建立公开 Unity Adapter API**（不注册 Catalog Generator、Importer、Compiler 或 Debug Mapping），维持 per-domain batch 服务加 internal 共享层；Authoring 协议只冻结 Catalog/Document 输入输出和稳定身份约束，不冻结 Unity 内部注册 API。决策依据与重开条件见 [`UnityIntegrationArchitecture.md`](UnityIntegrationArchitecture.md) §13.3。

### 编译边界

VisualBridge Authoring Host 不直接加载 Unity 程序集，Unity Package 也不加载 VS Code 插件代码。双方冻结并落地的交接面有两条：离线交接面（Profile、Catalog、Authoring Document、Schema 与稳定 ID），以及本机回环 Bridge 交接面（Editor Bridge 与 Runtime Bridge 的消息 Schema、发现记录、token 认证与调试租约）。跨网络传输与 Player 产物接线仍未冻结。

```text
Current Authoring Host
  -> Node / VS Code / MCP

Current Unity Package
  -> Unity C# environment

Frozen offline handoff today
  -> Profile / Catalog / Document / Schema / stable IDs

Frozen loopback bridge handoff today
  -> Editor Bridge / Runtime Bridge message schema, discovery record, token, lease

Not frozen today
  -> remote / device transport, Player build artifact wiring
```

## AI 与 MCP

### 职责选择

在本平台中：

- MCP 是 AI 进行受校验语义查询、修改、Lifecycle 和 Refactor 的正式 API。
- AI 可以把普通文本源文件、Catalog 和 Schema 作为只读上下文，但受支持的语义写入仍必须通过 MCP；`.xlsx` 和 `.csv` Table Document 的读取与写入都必须通过 MCP Semantic Table Model。
- VS Code 是人工可视化入口。

```text
VisualBridgeCore
├─ VS Code Adapter
└─ MCP Adapter
```

MCP 不自行重复实现文档规则。VisualBridgeCore 提供 Project、Document Adapter、Field、Reference 等宿主无关公共契约；Graph、Entity、Structured、Table Built-in 包提供各自的 Parser、Catalog Registry、Operation、Validator、Reference Collector 和 Serializer；MCP 只负责路由与 Host 事务。

### MCP Server 生命周期

当前使用项目级 stdio MCP Server，由 AI Host 按会话启动：

```text
AI Host
  -> 启动 Node MCP Server 子进程
  -> 通过 stdin/stdout 调用
  -> AI 会话结束后关闭子进程
```

当前 MCP Server 独立加载 Authoring Project，不要求 VS Code 正在运行；对 Unity 的唯一连接面是只读的 `visualbridge_runtime` 检查工具（Runtime Bridge，本机临时目录发现）。多个 AI Agent 启动各自的 MCP Server，通过 `baseHash`、Project 锁、依赖 Hash 和原子文件事务协调。Unity 调试并发模型属于后续 Unity/Debug 阶段。

当前已落地的 `Tools/VisualBridgeMcp` V2 是仅面向本地 Authoring Project 的 stdio 入口。它从进程工作目录或 `VISUALBRIDGE_WORKSPACE` 环境变量确定发现根目录，只保留 Project、Catalog、Document、Apply Operations、Document Lifecycle、Reference、Refactor 和 Runtime 检查八个稳定工具；旧的 Graph、Entity、Structured、Table 专用工具不保留兼容别名。Project read/listDocuments 会保留所有合法稳定 `editor` ID，并以 `adapterAvailable` 明确当前 MCP 是否注册对应 Adapter。除 Project discover 外，所有工具都按各自 strict Schema 显式携带 `projectFile`；Catalog、Document 与 Apply Operations 还必须携带 `documentTypeId` 和 `editor`，Reference、Refactor 与 Lifecycle 则使用各自的 kind/target 或 source/target 结构。最终领域 Adapter 仍由 Project Registry 解析出的 `DocumentType.editor` 决定；未注册 ID 的语义操作返回不支持，调用方也不能借请求字段绕过文件归属或自定义扩展名规则。

Core 定义宿主无关的 `SemanticDocumentAdapter`、`DocumentCodec` 与 `CatalogAdapter` 契约，四个 Built-in 包只组合各自既有 Parser、Catalog Registry、Validator、Operation、Reference Collector 和 Serializer。MCP Host 的 Document Adapter Registry 负责路由；没有注册项时只在 Project 能力清单中报告 `adapterAvailable: false`，不会提供 Catalog、Document、Operation、Reference、Refactor 或 Lifecycle 语义。文件系统、安全路径、锁、Hash 和持久化仍留在 Host；Table 的 CSV family 与 XLSX 保持多来源/二进制 Codec，不伪装成单文本文件。MCP 支持按来源 `baseHash` 原子执行普通 Operation，并按完整依赖清单预览和提交 Document Lifecycle 与项目级引用重构。Project Provider V2 可在启动时授权后提供自定义 Reference 和 Validator，但不提供写能力。当前不提供独立 CLI，也不包含 Debug 能力；Runtime 集成仅限只读的 `visualbridge_runtime` 检查工具。具体工具、结果信封与写入流程见 [`VisualBridgeMcp.md`](VisualBridgeMcp.md)。

### MCP 能力边界

MCP 提供少量稳定的项目级能力：

- 查询工程、Document Type、Catalog 和扩展能力。
- 列出、读取、搜索和校验文档。
- 批量执行 Document Operations。
- 通过 Semantic Table Model 搜索、查询和修改 `.xlsx` 与 `.csv` Table Document。
- 搜索和解析数据引用。
- 预览并执行项目级引用重构事务。
- 预览并执行 Document 创建、复制、移动和安全删除。
- 只读检查本机 Unity Runtime 实例（发现记录、运行时快照、Source 映射与漂移）。

断点、执行控制、调用栈与变量求值经项目方裁定**不进入协议**（只观察、不做断点）；Graph 执行过程观察已按第 19 章冻结并落地。当前 `Tools/VisualBridgeMcp` 通过 `visualbridge_runtime` 提供只读 Runtime 检查，其余执行语义归游戏侧执行引擎，不是本仓库的完成条件。

不为每个节点或属性操作创建大量顶层 Tool。领域差异通过 Document Operation Schema 表达。

当前统一 V2 工具面固定为 `visualbridge_project`、`visualbridge_catalog`、`visualbridge_document`、`visualbridge_apply_operations`、`visualbridge_document_lifecycle`、`visualbridge_references`、`visualbridge_refactor_reference` 和只读检查本机 Unity Runtime 实例的 `visualbridge_runtime`（消费 Runtime Bridge 契约，每次调用独立连接并在断开时释放调试租约）。Graph、Entity、Structured 与 Table 共用同一 Project selector 和 Adapter 路由。写入必须携带读取时得到的 SHA-256 `baseHash`；所有 MCP 写入共用 Project Transaction 锁、阶段化临时来源、持久化复验与可恢复事务日志。冲突、无效事务和不确定故障使用不同的结构化状态，冲突不会自动重试或覆盖。外部非 VisualBridge 写入不参与协作锁，因此提交仍会在替换前和替换后检查 Hash；若恢复时发现未知外部字节，会保留这些字节并升级为 Tool Error。

## Unity 连接与 Debug 边界

本机回环的 Unity 连接与只读检查已落地并冻结：Editor Bridge（Unity 请求 VS Code 打开/定位文档）与 Runtime Bridge（实例发现、文档快照、Source 映射、调试租约、Graph 执行观察）。字段、错误码与状态机以 `Protocol/Schema/visualbridge-editor-bridge.schema.json`、`visualbridge-runtime-bridge.schema.json` 与 [`UnityIntegrationArchitecture.md`](UnityIntegrationArchitecture.md) 第 12、17、18、19 章为权威，本文不重复定义。

### 实例发现与通信：已冻结的答复

- 发现记录不写入 Authoring Project，而是写入系统临时目录：Editor Bridge 为 `visualbridge-bridge/<windowId>.json`（VS Code 侧按窗口发布并心跳），Runtime Bridge 为 `visualbridge-runtime/*.json`（Unity 实例自写）。
- 本机传输只监听 `127.0.0.1`，消息为 NDJSON 行分帧，首条消息完成 token 握手，并以 `formatVersion` / `coreVersion` 显式协商。
- Domain Reload、进程重启与陈旧消息由磁盘持久 generation 加心跳/pid 双信号陈旧判定处理，陈旧记录绝不连接。
- 不设全局“当前 Unity”：Editor Bridge 要求显式选择目标窗口（多窗口匹配报 `bridge.windowAmbiguous`），Runtime 实例由调用方显式指定 `instanceId`。
- 两侧各使用封闭的错误码枚举（wire 层 `bridge.*` 与 `runtime.*`），写入受单控制者租约约束。

### 仍待决项

- 远程与设备连接（阶段 C，项目方 2026-08-31 明确推迟）：跨网络传输、配对、凭据生命周期、审计与端点暴露策略。
- Unity Player 构建的产物接线（StreamingAssets 等）。
- Project Discovery File、Loopback/network WebSocket 仍只是可能的技术选项，不是本架构基线的已定协议；进入 Protocol Schema 前必须由单独设计与威胁模型验证。

### Debug 边界：已冻结的答复

- Source Document 与 Runtime Instance 的映射由 `getDocumentSources` 承担，返回 `documentTypeId`、`documentId`、`sourcePath` 与 `sourceSha256`；漂移由 VS Code / MCP 侧对照工作区当前字节计算，结果为 `true` / `false` / `unknown`。
- VS Code DAP、AI/MCP 与 Unity Bridge 共享同一 Runtime Bridge 契约与观察者语义：DAP 侧是只读检查适配器（单伪线程、文档快照变量树与漂移信息），MCP 侧每次调用独立连接并在断开时释放调试租约。
- 多客户端权限采用单控制者租约；`getSnapshot` 与 Graph 执行观察不受租约约束。
- 断点、调用栈、变量求值与执行控制经项目方裁定不进入协议：能力声明如实为空，不伪造执行状态。
- 执行过程可视化：游戏侧执行引擎经采集门面上报事件，按“满 64 条或 100ms”冲刷，VS Code Graph 页面提供实时跟踪与时间轴回放。

无论后续选择什么方案，会话状态都不能写回 Authoring 源文档，文件名、数组索引或对象地址也不能在没有正式身份契约时被当作稳定跨进程标识。

## 平台仓库结构

VisualBridge 当前使用单仓库管理平台核心、VS Code Host、MCP、Node Host、Protocol 和 Unity Package：

```text
VisualBridge/
├─ Doc/
│  ├─ README.md
│  ├─ VisualBridgeArchitecture.md
│  └─ Temp/
├─ Protocol/
│  ├─ Schema/
│  ├─ Messages/
│  ├─ Generated/
│  └─ contract-manifest.json
├─ Core/
│  ├─ Catalog/
│  ├─ Debug/
│  ├─ Diagnostics/
│  ├─ Document/
│  ├─ Edit/
│  ├─ Extension/
│  ├─ Form/
│  ├─ Ordering/
│  ├─ Project/
│  ├─ Provider/
│  └─ Reference/
├─ Editors/
│  ├─ Ui/
│  ├─ Graph/
│  ├─ Entity/
│  ├─ Form/
│  ├─ Project/
│  ├─ Structured/
│  └─ Table/
├─ BuiltInExtensions/
│  ├─ Graph/
│  ├─ Entity/
│  ├─ StructuredConfig/
│  └─ Table/
├─ Tools/
│  ├─ DependencyPolicy/
│  ├─ Documentation/
│  ├─ LargeCorpus/
│  ├─ NodeHost/
│  ├─ ProtocolContract/
│  ├─ SampleValidation/
│  ├─ VSCodeExtension/
│  └─ VisualBridgeMcp/
├─ Packages/
│  └─ com.kyle.visualbridge/
└─ UnityProject/
```

原则：

- Unity Package 源码只有一份，UnityProject 作为开发宿主。
- VS Code 插件源码不进入 UPM Package。
- Protocol 和 Schema 独立于 Unity 与 VS Code。
- VisualBridgeCore 不引用 VS Code API、Unity API 或 Webview DOM。
- MCP 和 VS Code Adapter 依赖同一 VisualBridgeCore。
- `Doc` 保存已落地的内容和正式架构文档。开发过程中的设计稿和任务文档放入 `Doc/Temp`，任务完成后删除。

## 开发方案

### 阶段一：Project 与 Document Core

- 建立 VisualBridge Project File 发现、校验和 ProjectContext。
- 建立 Document Type、稳定 ID、Parser、Operation 和诊断模型。
- 完成最小 Graph Document。
- 完成最小 MCP Server，用于检查和修改源文件。

阶段目标是证明“文本源文件 -> VisualBridgeCore -> 校验与确定性修改”。

Project、Graph Core、Entity Core、Structured Core、Table Core、共享 Form Field、Reference System、Project Refactoring、Document Index 和 stdio MCP 垂直切片现已落地。四类文档分别由 `TestData` 固定样例及 Node 自动化测试持续验证；随后新增的 Unity Structured offline slice 由独立 Profile/Package/Exporter/Compiler 与 Unity EditMode/batchmode 门槛验证。Runtime、Debug、DAP、Player 和其他三个领域的 Unity 实现仍不在当前能力内。

### 阶段二：VS Code 编辑闭环

- 注册 Custom Text Editor。
- 实现 Graph Canvas、节点内联字段和可折叠 Graph Inspector 的最小能力。
- 实现 Entity / Component 卡片编辑和共享 Form Field 的最小能力。
- 实现 CSV/XLSX Table、项目级表头行、分表标签与共享字段检查器。
- 通过 `WorkspaceEdit` 完成文本 Document 的保存和 Undo/Redo，并实现外部变更检测、覆盖确认与放弃刷新。
- 建立统一 Document Browser、跨文档搜索/创建、Problems、引用关系和状态栏。

阶段目标是人工与 AI 能编辑同一源文件，并得到一致结果。

VS Code 宿主边界使用官方 `@vscode/test-electron` 在最低支持版本 `1.105.1` 的隔离 Extension Host 中验证。固定测试工作区必须由 `TestData` 复制生成，不能修改仓库样例或用户现有 VS Code 配置；Host 测试负责自动激活、Project 发现、命令和 Custom Editor 路由，打包后的 VSIX 另由本机 VS Code CLI 在隔离 User Data / Extensions 目录中验证安装身份与完整运行资源。CLI 安装成功不等同于 Webview 功能通过，领域交互继续由 Core / Editor 测试和针对性的真实页面验证负责。

### 阶段三：Catalog、Reference 与项目扩展

- 完成 Unity 接入前的 Authoring / Catalog 交接契约、Catalog Registry、过期状态和只读 Catalog Browser；该基线最初使用已提交固定 Catalog，后续 Structured Unity slice 已增加同源 C# contract 与确定性 Catalog Exporter。
- 已落地 Reference Service、通用 Reference Picker、反向关系、项目重构和 Project Provider V2。
- 已落地 Project Provider 的独立 `.mjs` 进程、重启、诊断、Workspace Trust 与 MCP allowlist 边界。
- VB-PU-01 至 VB-PU-08 共同构成 Unity 接入前的 Authoring 基线；Project Settings、Catalog 状态、增量索引、Provider 缓存/取消、Table 虚拟化、共享 Form 与 VS Code Host 均属于该基线。其后的 Structured Catalog Export/Compile 已落地，Discovery 和连接协议仍待独立阶段。

Project Settings 的 Project Operation、文件归属校验、外部修改冲突和 Catalog Browser 行为见 [`ProjectCatalogManagement.md`](ProjectCatalogManagement.md)。Catalog 顶层 `source` 明确区分 `unknown`、`current` 与 `stale`；Host 从当前字节计算只读 `contentHash`，不在 Browser 中回写外部维护的 Catalog。

阶段目标是让项目业务能力在不修改基础插件的情况下接入。

Unity 接入前基线的历史范围与完成门槛见 [`Archive/PreUnityDevelopmentRoadmap.md`](Archive/PreUnityDevelopmentRoadmap.md)。当前 Structured Export/Compile 的准确范围见 [`UnityIntegrationArchitecture.md`](UnityIntegrationArchitecture.md)；Project Discovery、Editor Bridge transport、Runtime 与 Debug 已在此后阶段实现，设计见该架构文档，不能从离线实现推导协议字段。

### 阶段四：Unity Editor 连接

- 已完成普通 C# class/struct 到 Structured Catalog V1 的确定性 Exporter，以及 Authoring Structured Document 的最小 offline Import/Compile 垂直切片。
- 下一步先以独立设计确定 Unity Project/实例发现、传输、认证、版本协商和重连边界；不预选 Discovery File 或 WebSocket。
- 在已证明的传输与权限边界上实现最小 Editor Bridge，只允许 Unity 请求打开/定位 Authoring 文档。

### 阶段五：Debug 与 MCP

- 以真实调试用例重新设计 Debug Session、运行时身份、Source 对齐和多客户端权限，不继承 Authoring MCP 的字段或传输假设。
- 决定是否以及如何接入 VS Code DAP、MCP Runtime Attach 和 AI 调试能力；这些都不是当前 stdio MCP V2 的兼容扩展承诺。
- 用自动化和实际 Unity/Player 垂直切片验证选定的会话、断线和并发模型。

### 阶段六：更多 Document Type

- Graph、Entity、Structured、Table 与 `document`/`entity.component`/`graph.element`/`table.row` 引用和项目级重构已完成当前版本；继续增加新的 Document Type 或 Reference Provider。
- 验证 Form、Reference、Validation 和扩展机制是否真正通用。
- 根据两个垂直切片提炼共享 API，避免只为 Graph 过度抽象。

### 阶段七：Player 与生态

- 基于已验证的 Unity Bridge 协议决定 Player 是否复用传输和上层消息，而不是预设 WebSocket。
- 设计并实现设备发现、配对和安全策略。
- 增加更多 Document Type、伴生扩展和语言服务。
- 完善版本迁移、CI、发布和项目模板。

## 关键风险

### 过度通用化

平台从第一天定义通用边界，但不预先实现所有编辑器。通过 Graph 和 Structured Config 两个垂直切片验证抽象。

### Catalog 漂移

生成过程必须确定，并提供 Hash 和过期诊断。工具可以使用已提交 Catalog，但必须知道它是否与当前 C# 或外部数据一致。

### 扩展代码安全

当前 Project Provider 是可执行工程代码，必须显式声明、受 Workspace Trust/MCP allowlist 控制，并隔离于基础 Extension Host。未来若增加 Project Webview Module，也必须先设计等价的 Trust、CSP、依赖和隔离边界；当前不能通过 Project File 加载它。

### 多客户端并发

当前文档修改通过 `baseHash` 和原子事务协调，且不提供实时协同编辑。未来调试是否采用 Controller/Observer、租约或其他并发模型，必须在 Unity/Debug 阶段依据真实用例另行决定。

### Node 版本一致性

Provider 运行构建后的 `.mjs`，使用 Host 当前 Node 可执行文件；工程必须保证入口与该 Node 版本兼容，并把依赖打包或放在入口可解析的位置。版本或加载错误只隔离当前 Provider，不进入 Extension Host。

### Unity Domain Reload

Domain Reload 会使 Unity 连接和运行时身份失效。Runtime Bridge 已按此设计：磁盘持久 generation 加心跳/pid 双信号陈旧判定识别代际，mid-play domain reload 的监听失效窗口由 Editor 侧 Play 模式宿主兜底重建，陈旧记录绝不连接。远程/设备场景的重连、退避和重新握手策略仍未冻结（阶段 C 已推迟）。

### 大型工程性能

索引语义来自正式 Parser、Catalog Registry、Validator 和 Reference Collector。Document Browser 已使用按 Project、Document Type、Catalog 与逻辑物理来源依赖键的不可变增量快照：单文件变化只重跑对应语义单元，Catalog 变化重跑绑定类型，include/exclude 外事件不增加 generation。Reference 与 Index 共享快照，Provider 结果按依赖键缓存并支持取消，Table Record DOM 使用有稳定上限的虚拟化窗口。确定性生成器提供数千 Document/数万 Row 输入；正确性断言可失败 CI，耗时与内存仅生成报告。详见 [`WorkspaceIndexPerformance.md`](WorkspaceIndexPerformance.md)。

## 已确定的架构决策

- 平台定位为游戏语义内容创作工具，不替代 Unity 场景和渲染编辑。
- Authoring Project 是独立于 Unity Project 和 VS Code Workspace 的工程概念。
- Authoring Project 由本地工作区中的 Project File 和其 Project 相对 `documentRoots` 定界；当前不要求它与 Unity `Assets` 平级。
- VisualBridge Project File 固定命名为 `VisualBridge.project.vbjson`，内容为 JSON；只有发现有效 Project File 才启用插件工程功能。
- 源文档是唯一权威数据，Unity 数据是导入或编译结果。
- Catalog/Schema 描述能力，Document 保存实例。
- Document Type 是核心扩展点。
- 基础插件提供 Graph、Form、Table、Reference 等通用原语。
- 内置 Webview 通过 `@visualbridge/editor-ui` 共享主题 Token、Shell、布局、状态、图标和属性密度；该包不依赖领域模块，字段值语义继续由 `@visualbridge/form-editor` 拥有。
- 基础插件采用 N 合一扩展形式，Host 模块静态打包并在激活时注册；具体文件的 DocumentSession 和 Webview bundle 只在打开时建立。
- 用户使用 VS Code 原生 Explorer 处理普通文件，并可使用补充性的 Document Browser 浏览语义文档、诊断和引用。默认 VisualBridge 后缀可以直接进入对应 Custom Editor；Project 自定义后缀由 Document Browser、`VisualBridge: Open Document` 或工程级编辑器关联进入通配 Custom Editor，随后统一由 Project Registry 按 Document Type 路由。
- 插件实例按 VS Code 窗口隔离，每个文件创建独立 DocumentSession，多个文件共享当前窗口的 Extension Host。
- 平台专属格式可以默认关联自定义编辑器，`.xlsx` 等通用格式只通过 Authoring Project 的工作区级关联在当前工程窗口接管。
- Table Document 提供统一语义模型，Excel 是可选权威载体或导入导出 Codec；AI 不直接读写 `.xlsx` 和 `.csv`，必须通过 MCP 的搜索、查询和修改能力访问。
- 物理路径不承担语义身份。Document Lifecycle 以一个共享 Service 承担 Create、Copy、Path Move 和 Safe Delete；稳定 ID Rename 继续使用 Project Refactoring。
- Document Lifecycle V1 使用 strict preview/apply、调用方完整提交 `stableIdRemap`、Safe Delete closure、Reference coverage 和 `replace`/`create`/`delete`/`move` Project Transaction 状态；目标不存在性与来源 Hash 都是并发前置条件。
- VS Code 写入前检测目标文件是否已被外部修改；Graph、Entity、Structured 文本编辑器在脏状态下要求用户选择覆盖、放弃并刷新或取消，Table 与多来源事务始终拒绝静默覆盖并要求重新加载。
- VS Code 和 MCP 共享 VisualBridgeCore。
- MCP 是 AI 进行受校验语义查询与写入的正式 API；普通文本可作为只读上下文，但直接改写不属于受支持流程，Table 载体必须始终经 MCP。
- stdio MCP Server 由 AI Host 按会话启动。
- Project Provider V2 固定运行 Project 声明的构建后 `.mjs` 入口，不直接执行 `.ts`；当前仓库、Provider 和 MCP V2 固定使用 Node.js `22.22.1`，MCP 运行已构建的 `Tools/VisualBridgeMcp/dist/server.js`。
- 项目 `.ts` 不直接加载到 VS Code Extension Host。
- 自定义 Webview TypeScript/TSX 仍需要构建为 JavaScript/CSS。
- 内置 Graph Canvas 使用 React 与 React Flow；React Flow 的节点和连线数据由 Graph Document 派生，用户交互必须转换为 Graph Operation 后才能写入源文档。
- 内置 Entity Editor 使用 Entity Catalog V1 组织 Entity、Component Group 与 Component Type；Entity JSON 是权威数据且不依赖 `ScriptableObject`。Entity Operation 批量应用具有原子性，Serializer 确定性输出。
- Core Form Field 与共享 Form Editor 是跨 Graph、Entity、Structured 和 Table 的公共字段基础，保留 JSON 形态与运行时 `dataTypeId` 的区别，并递归支持普通自定义结构和 List。
- Graph Catalog V4 支持多 Catalog Registry、节点 Catalog 归属、显示根名、Graph Type 支持 Catalog、允许节点精筛、输入/输出连接数量规则、直接节点数量约束和 typed subgraph 调用契约；节点的 `menuPath` 是相对所属 Catalog 显示根名的扩展路径。当前 Parser 只接受 V4，并与其他领域共用 `Core/Form` 字段契约，不读取旧 Catalog V1-V3 或旧 `required` 字段方言。Graph Document 继续保持 V3，并为根图和每个内嵌图保存独立 `graphTypeId`。
- Graph Type 一经设置暂不允许任意修改；节点和子图创建、删除及安全替换必须保持数量约束，子图调用节点的静态数据端口与子图公开接口共同形成父图端口契约。
- 声明式扩展优先，项目 Provider 处理复杂逻辑。
- Unity/Player 的发现、传输、认证、多客户端调试模型和运行时身份字段均留待 Unity/Debug 阶段以真实垂直切片决定；当前 Authoring 协议不冻结 Project Discovery File、WebSocket、Controller/Observer 或 Debug ID 组合。
- VisualBridge 使用单仓库管理 Core、VS Code、MCP、Unity Package 和 Protocol，Unity Package 目录名为 `com.kyle.visualbridge`。
- 正式文档保存在 `Doc`；开发中的临时设计和任务文档保存在 `Doc/Temp`，完成后删除。

## 留待实施阶段确定

Graph V3、Graph Catalog V4、Entity/Structured/Table V1、Project V1、Project Provider V2、MCP V2、Unity Integration Profile V1、最小 Editor Bridge V1 和 Runtime Bridge V1 已由各自正式文档与 Schema 定义。`Protocol/Schema` 当前冻结 16 份正式 JSON Schema，并确定性生成四个产物：`Protocol/Generated/contracts.d.ts`、`schema-index.json`、`contracts.g.cs`，以及 Package 内的 `VisualBridgeProtocolContracts.g.cs`。两份 C# 输出是 wire/data bags，不是语义 validator；Unity Profile/Project/Catalog/Document consumer 以 strict `JObject` validator 执行 unknown-field、版本、union/value shape、ID/path/hash 与 Registry 约束。以下条目是尚未落地的扩展，不表示现有格式与工具字段未定义：

- Protocol、C# 生成物、Unity Package 与 Compiler/Bridge 的完整发布兼容矩阵；当前生成闭包、Schema Hash 与 Package `0.1.0` 基线已由 Protocol gate 固定。
- 新类型的稳定 ID 生成、alias 迁移与旧数据导入策略；当前内置类型的稳定 ID/alias 规则保持由各领域文档定义。
- Structured、Entity、Graph 与 Table 四域的 Unity offline Export/Compile 均已完成；派生产物仍是 Editor 内部格式（版本化但不公开），当前 JSON/CSV/XLSX Authoring 格式保持有效。
- 跨网络（远程/设备）传输的错误码、诊断位置与生成契约；当前 Provider JSON-RPC V2、MCP V2 Operation、Editor Bridge 与 Runtime Bridge 的错误信封已经固定。
- 可选 Provider SDK 的发布形态；当前 Provider 直接面向 [`ProjectProvider.md`](ProjectProvider.md) 与 JSON Schema，入口/Node/依赖策略已经固定。
- 面向项目自定义 Webview 的公开 UI SDK、组件模型、隔离和热重载方式；内置编辑器私有共享 UI 已由 [`AuthoringEditorUi.md`](AuthoringEditorUi.md) 固定。
- 公开 Unity Adapter 注册 API（Catalog Generator、Importer、Compiler、Debug Mapping）：已裁定不建立（决策 B，维持 per-domain batch 服务加 internal 共享层），重开条件见 [`UnityIntegrationArchitecture.md`](UnityIntegrationArchitecture.md) §13.3。
- WebSocket 消息、认证、配对和安全策略。
- 多客户端控制、断线恢复和调试事件缓存策略。
- Player 设备发现方式。
- VS Code、UPM Package、MCP 和 Protocol 的版本联动。
- 旧数据导入、迁移和兼容周期。
- 平台发布、安装、更新和企业内部插件分发方式。

上述内容应在对应开发阶段形成独立设计文档，并保持本文确定的数据所有权、组件边界和身份模型。
