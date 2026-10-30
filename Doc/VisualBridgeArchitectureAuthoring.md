# VisualBridge 架构：Authoring、编辑器与扩展机制

本文是 [VisualBridge 架构设计](VisualBridgeArchitecture.md) 的子文档，覆盖编辑器原语、VS Code 基础插件与 Extension System。

### 编辑器原语

当前基础插件提供有限但高复用的编辑器原语：

- 共享 Authoring UI：VS Code 主题 Token、Shell、Toolbar、Status、Split/Inspector 布局、属性密度、图标和反馈表面。
- Graph Canvas。
- 可折叠 Graph Inspector，以及节点内联字段编辑。
- 共享 Form Field Editor：数值、颜色、选择项、对象、集合和 JSON。
- Entity / Component Editor。
- Structured Config Editor。
- Table Editor。
- Reference Picker。
- 递归 Object 和 List Editor。
- Search、Command Palette 和 Problems。

Dictionary 专用编辑器、通用 Diff Preview 和 Runtime Trace Overlay 尚未实现；未来若需要，必须先明确可复用语义和真实用例，不能把普通 object/list 控件描述成已经具备这些能力。

业务 Document Type 应优先组合原语，而不是为每种配置重新实现完整 Webview。

共享视觉的实现包、依赖方向、主题运行时切换、高对比度和属性密度契约见 [`AuthoringEditorUi.md`](AuthoringEditorUi.md)。`Editors/Ui` 不拥有 Document、Operation 或 Host 消息；`Modules/Shared/Form` 在模块侧提供字段值语义（`Modules/Shared/Ui` 是 `Editors/Ui` 的副本）。领域编辑器不得各自复制 `body/button/input` 与 `.vb-field*` 基础样式。

## VS Code 基础插件

### 职责

基础插件负责：

- Authoring Project 发现和 ProjectContext 管理。
- Document Type 和 Extension Registry。
- Custom Text Editor 和通用 Webview 生命周期。
- 文档索引、引用索引和诊断。
- Edit Transaction 与 `WorkspaceEdit` 协调。
- Tree View、状态栏、命令和管理页面。

Unity 实例发现/连接和 Debug Adapter/DAP 属于后续 Unity/Debug 阶段，不是当前基础插件组成。

基础插件不包含项目业务节点、游戏配置语义和项目专用引用查询。

### 插件生命周期

- 基础插件是一个 N 合一 VS Code 扩展，当前内部功能模块包括 Document Browser、Graph、Entity、Table/Excel、Structured Config、Project Settings、Catalog Browser、Unsaved Documents、Editor Bridge Server、Runtime Bridge 客户端与 `visualbridge-runtime` 只读检查调试适配器；断点式 Debug 不实现。
- 插件实例按 VS Code Extension Host/窗口创建。
- 一个插件实例只有一个 Project Registry、Workspace Index、Reference Service 和 Provider Service。
- 一个窗口可以持有多个 ProjectContext；Unity 连接不设全局“当前实例”：Editor Bridge 按窗口发布发现记录并由 Unity 侧显式选择目标窗口，Runtime Bridge 实例由调用方显式指定 `instanceId`，写入受单控制者租约约束。
- 每个打开文档创建独立 EditorSession/WebviewPanel。
- 关闭 Webview 不终止其他文档或 Project 服务。
- 不使用全局 `currentProject`、`currentUnity` 或 `currentDocument`。

当前 VSIX 把 Core、宿主适配器与 Project 编辑器静态打包；领域编辑器以 Project 内的 `Modules/*.vbmodule.js` 交付，由宿主的 `ModuleLoader` 在装载时求值。激活时建立 Project Registry、Workspace Index、Reference/Provider Service 并注册命令、视图和 Custom Editor。打开具体文件时才建立该文件的 DocumentSession 并加载对应 Webview UI bundle。每个文件拥有独立会话、脏状态和 Undo/Redo；多个文件共享当前窗口的 Extension Host，不为每个文件启动一份扩展进程。

VS Code 扩展一旦在某个窗口内激活，通常持续到该窗口关闭或重新加载。关闭编辑器时释放该面板的会话、监听和 Webview 资源；Project Registry、Workspace Index 与共享服务继续随 ExtensionContext 存活，Table Document 按 VS Code Custom Document 生命周期释放。Project Provider 子进程按 Project/Host 生命周期管理，不由某类 Webview 的最后一个面板决定。当前没有编辑器 Worker 或运行时订阅。不同 VS Code 窗口拥有独立的 Extension Host、共享服务和文档会话。

### 原生 Explorer 与文件编辑器关联

用户继续使用 VS Code 原生 Explorer 处理普通文件，不要求先执行“启动插件”命令。基础插件同时提供补充性的 Document Browser，以 Project / Document Type 语义组织 Authoring Document；文件行携带 Problems/References 计数，当前文件的中文诊断和双向引用显示在同容器内独立可折叠的详情 View，它们都不是第二份文件所有权或权威状态。VS Code 工作区中只有发现并成功解析 VisualBridge Project File 后，才启用这些功能。插件启用后，用户在 Explorer、Document Browser、Quick Open、搜索结果或引用跳转中打开该工程声明的指定类型文件时，才创建对应的编辑窗口：

```text
VS Code 原生 Explorer
  -> Workspace 中发现 VisualBridge Project File
  -> 启用 Extension Shell 并创建 ProjectContext
  -> 打开工程声明的指定类型文件
  -> Custom Editor 匹配并校验文件归属
  -> 已注册 Adapter 创建领域 DocumentSession 并加载 Webview bundle
  -> 未注册稳定 ID 创建只读 Document Shell

VisualBridge Document Browser
  -> 共享索引按 Project / Document Type 聚合
  -> 搜索、创建、校验、引用与错误入口
  -> 打开时仍交回同一 Project Registry 路由
```

插件工程功能的启用条件是“当前 Workspace 中存在有效的 VisualBridge Project File”；具体编辑窗口的创建条件是“有效 ProjectContext 内的指定类型文件被打开”。打开入口不依赖 Explorer；Document Browser、Quick Open、搜索结果、引用跳转和命令打开应获得相同行为。

文件关联遵循以下规则：

- 平台专属格式可以将对应 Custom Editor 声明为默认编辑器。
- `.xlsx`、`.json` 等通用格式不得通过用户级全局关联强制接管。
- Authoring Project 需要默认接管通用格式时，应通过 `.code-workspace` 或工作区级 `workbench.editorAssociations` 只影响当前工程窗口。
- VisualBridge Project File 负责声明该工程启用的 Document Type、文件匹配规则和功能模块；Custom Editor 打开后仍需验证文件属于有效 ProjectContext。
- 插件不得用扩展名直接推断 `graph`、`entity` 等编辑器大类；必须由 Project Registry 先解析匹配的 Document Type，再读取其 `editor` 和稳定 `id`。
- VS Code 扩展清单中的 Custom Editor selector 是静态的。`.vbgraph`、`.vbentity` 等只提供默认便利关联；Project 自定义扩展名通过 Document Browser、可选的通配 Custom Editor、`VisualBridge: Open Document` 或工程级 `workbench.editorAssociations` 进入相同路由。
- Project Registry 匹配到未注册稳定 `editor` ID 时，文本 Custom Editor 显示通用只读 Shell 的 Project、Document Type、Adapter ID、路径和当前源码；它不创建领域 DocumentSession，也不参加语义索引、Reference、Lifecycle 或领域诊断。
- 未发现有效 VisualBridge Project File 时不启用工程功能；不属于有效 ProjectContext 的通用文件不创建业务 DocumentSession，并使用默认编辑器打开。
- Custom Editor 的静态声明只表示编辑器可用；没有打开对应文件时不创建该文件的会话或 Webview，不能据此推断内部 TypeScript 模块采用动态 import。

对于 `.xlsx` 等二进制文件使用 Custom Editor Provider 和 Workbook Codec；对于平台文本格式可以使用 Custom Text Editor Provider。两者最终都进入统一的 Document Operation、校验、引用和保存流程。

### Webview 边界

Webview 使用 HTML、CSS 和 JavaScript/React 实现复杂编辑器。Webview 只负责视图与交互，不直接访问文件系统、Node.js、Unity 或调试连接。

内置 Webview 的 `--vb-*` 语义 Token 始终映射当前 `--vscode-*`，不缓存主题 ID。亮色、暗色和高对比度在页面存活期间由 CSS 级联更新；主题变化不得重载页面或改变 Document/Operation 状态。

```text
Webview
  -> 用户意图
Extension Host
  -> VisualBridgeCore
  -> Host Persistence / Provider
```

Custom Editor resolver 只负责建立 DocumentSession、设置 HTML 与注册消息监听，然后必须返回给 VS Code；不得在 resolver 返回前等待发送初始状态。Webview 脚本加载后发送 `ready`，Extension Host 再解析当前权威 Document、Catalog、Reference 与诊断并发送首个状态。此握手避免 resolver 与尚未完成加载的 Webview 相互等待，之后的每次消息仍携带文档版本或 revision 以拒绝陈旧编辑。

当 `retainContextWhenHidden` 为 `false` 时，面板隐藏会使当前 Webview 生命周期失效，但 VS Code 不保证页面立即销毁。Host 必须递增该面板的生命周期 epoch、清除 ready 状态并保留尚未确认的定位请求；旧 epoch 中已经排队的 `ready`、Operation 或 ACK 不得修改新生命周期。面板首次挂载只发送无 token 的 ready proposal；Host 随后发送带新生命周期 token 的 `requestReady` challenge，Webview 回显 token，并把它附加到该生命周期的每一条上行消息。面板重新显示时 Host 重新生成 token：仍存活的页面主动回应，已重建的页面则先重新发送 proposal。Host 只接受当前可见生命周期的 token，且只有回显后的首个权威状态发送成功才能标记就绪并投递定位请求。

多编辑器场景中的定位请求只归属一个面板，并以逻辑文档级 generation 保证“最新请求获胜”；新请求必须取消同一文档所有面板和文档队列中的旧请求。承载当前 generation 的面板在确认前关闭时，请求必须立即交给同一文档的其他已就绪面板，或回到文档级等待队列；任一面板 ACK 释放 mailbox 后还要重试等待中的接管。

## Extension System

### 当前扩展层级与未来候选

当前平台只支持声明式 Catalog/Project 配置和 Project Provider V2。项目 Webview Module 与 VS Code 伴生扩展 API 是未来候选，不是可用入口：

| 类型 | 运行代码 | 主要用途 |
| --- | --- | --- |
| 声明式扩展 | 否 | Schema、类型、属性、节点、菜单、连接规则 |
| 项目 Provider | 是 | V2 的引用查询与复杂校验；领域操作和数据转换属于后续候选能力 |
| 项目 Webview Module（未实现） | 是 | 未来无法用通用控件表达的自定义 UI 候选 |
| VS Code 伴生扩展 API（未实现） | 是 | 未来深度 VS Code API、跨项目通用能力候选 |

### 声明式扩展

声明式扩展应覆盖大部分项目需求，可在不执行工程代码的情况下加载。常见属性编辑使用内置 Form、Reference Picker 和 Object/List Editor。

### 项目 Provider

项目 Provider 作为独立进程运行，通过固定的 NDJSON JSON-RPC 2.0 V2 协议与基础插件通信。Provider V2 只提供：

- Reference Provider。
- 自定义 Validator。

Provider V2 不提供 Document Operation、导入、转换或辅助命令。只有出现第二个真实修改用例并证明可复用边界后，才设计返回既有领域 Operation 的后续能力。

Provider 不直接访问 VS Code API，V2 协议也不提供文件写入接口；但独立进程仍以当前用户权限运行，不是操作系统沙箱，因此它在技术上能够绕过协议直接访问文件。Provider 必须被视为受信任工程代码，宿主通过源文件 Hash、外部变更检测和写入冲突拒绝防止静默覆盖。

### Project Provider 运行策略

Project File 声明构建后的规范化 `.mjs` 入口和逐项字符串参数。共享 Node Host 固定以当前 Node 可执行文件、`shell: false` 和清理后的环境启动该入口，不直接运行 `.ts`，也不把工程代码导入 Extension Host。VS Code 只在 Workspace Trust 允许时启动；MCP 默认禁用，只有启动环境显式启用且入口真实路径位于绝对路径 allowlist 时启动。初始化、能力上限、超时/取消、崩溃退避、隔离、源文件 Hash 监测、结构化日志与故障处理见 [`ProjectProvider.md`](ProjectProvider.md)。

### 自定义 UI

当前 Host 不加载 Project 自定义 Webview Module；所有 Webview 都是随私有 VSIX 构建和审核的内置编辑器。未来若增加该能力，浏览器/Webview 仍不能直接运行 TypeScript/TSX，自定义 React 属性编辑器必须构建为 JavaScript/CSS，并遵守 Workspace Trust、CSP、依赖和版本边界。扩展优先级应保持：

```text
声明式 UI
  -> 内置 UI + 已构建 Project Provider
  -> 最后才使用自定义 Webview Module
```

### VS Code 伴生扩展

当前基础插件没有可供伴生扩展注册能力的公开版本化 API。未来若真实用例需要 VS Code 原生 API、跨项目复用或独立发布，应先设计该 API，再以正式独立扩展实现；项目目录中的代码不能自动成为 VS Code Extension。

### 安全边界

- 未信任工程只加载源文档、Catalog 和声明式扩展。
- VS Code 只在 Workspace Trust 允许时启动当前 Project Provider；未来若引入项目 Webview 代码，必须应用独立的 Trust、CSP 和依赖审查。
- 独立 MCP 没有 VS Code Workspace Trust，默认不执行 Project Provider；只有宿主显式授权、Project 声明且规范化入口位于允许列表时才启动，单次 Tool 请求不能提升权限。
- VisualBridge Project File 只显式声明当前 Provider，不自动扫描并执行其他脚本。
- Provider 使用可验证的可执行入口和参数，不拼接 Shell 命令。
- Provider 是当前用户权限下的受信任工程代码，独立进程只提供故障隔离而不构成 OS 沙箱。
- 扩展能力以 ProjectContext 为作用域，项目关闭时全部释放。
- 项目扩展不能替换核心文件解析、稳定 ID 和通信安全策略。
