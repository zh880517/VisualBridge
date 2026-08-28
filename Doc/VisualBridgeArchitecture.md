# VisualBridge 架构设计

## 文档定位

本文描述 VisualBridge，一个基于 VS Code 的游戏语义内容创作平台。平台用于承载游戏逻辑、游戏流程、结构化属性、数据引用和运行时调试等不依赖模型与实时渲染的编辑工作，并通过 Unity Bridge 与 Unity Editor 和 Player 协作。

本文是新工程的架构基线，主要确定：

- Authoring Project、Document、Extension 和 Runtime 的边界。
- VS Code 基础插件、项目扩展、Unity Bridge 和 MCP 的职责。
- 编辑数据、描述文件、生成数据和运行时数据的所有权。
- 本地与远程通信、实例发现和多客户端调试模型。
- 新平台仓库和游戏工程的建议目录结构。
- 分阶段开发路径。

本文不依赖任何现有工程，也不约束具体游戏项目。具体 JSON Schema、接口字段、UI 视觉、协议消息、构建脚本和发布流程在对应模块开始实施时单独设计。

## 产品定位

平台定位为“游戏语义内容创作工具”，不试图重新实现 Unity Editor。

适合迁移到 VisualBridge 的工作：

- 游戏逻辑图。
- 游戏流程、状态机和规则编排。
- 行为树、任务、对话和关卡流程。
- 属性配置和结构化数据。
- 表格型配置。
- 跨文档和游戏数据引用。
- 批量查找、校验、重构和格式迁移。
- 节点、状态和流程级调试。
- AI 读取、生成和修改游戏内容。

继续保留在 Unity 的工作：

- Scene 和 Prefab 空间编辑。
- 模型、材质、Shader、贴图和渲染预览。
- 强依赖 SceneView、Gizmo 和 GameObject 的编辑器。
- 动画、Timeline 和需要实时画面反馈的内容。
- Unity 原生资产导入与平台构建。

两侧通过 Catalog、稳定引用和调试协议协作，而不是互相加载对方的 UI 或内部对象。

## 设计目标

### 核心目标

- 用一个通用 VS Code 基础插件承载多种游戏语义文档。
- Authoring Project 能同时包含编辑文件、描述文件、项目扩展和工具入口。
- VisualBridge 原生文档采用适合 Git、代码评审和 AI 修改的文本格式；`.xlsx` 和 `.csv` 等 Table Document 载体通过 Codec 与 MCP 访问。
- C#、游戏配置或外部数据能够生成编辑器所需的 Catalog 和引用描述。
- 项目业务扩展不需要修改基础插件。
- VS Code 和 MCP 使用同一套核心编辑与校验能力。
- Unity Editor 和 Player 使用统一的上层调试协议。
- 多个 VS Code 窗口、AI Agent 和 Unity 实例能够明确路由和协调。
- 平台先通过少量垂直切片验证，再逐步扩展文档类型。

### 非目标

- 第一阶段不实现多人实时协同编辑。
- 第一阶段不支持 VS Code Web、Codespaces 和 Remote SSH。
- 第一阶段不提供任意业务代码的安全沙箱。
- 第一阶段不替代 Unity 的场景和资源编辑器。
- 第一阶段不建立中心化云服务。
- 本文不确定全部文档格式和兼容策略。

## 核心原则

### 源文件是唯一权威数据

Authoring 文档是游戏语义内容的源数据。Unity 导入资产、运行时数组、索引、缓存和调试状态都是派生数据。

```text
Authoring Source Documents
    -> 校验与编译
    -> Unity Editor 数据
    -> Runtime 数据
```

VS Code Webview 只是源文件的可视化视图，不能维护第二份权威文档状态。所有编辑最终通过 Document Operation 作用于当前 Document Type 声明的权威文件载体。

### 描述与实例分离

Catalog 和 Schema 描述“可以编辑什么”；Authoring Document 描述“项目实际创建了什么”。

```text
类型、节点、端口、属性、引用规则
    -> Catalog / Schema

节点实例、属性值、连接、流程
    -> Authoring Document
```

Catalog 可以由 Unity C#、外部配置或项目扩展生成。Document 不复制能够从 Catalog 推导的内容。

### 稳定身份与显示信息分离

Project、Document、Document Type、Element、Reference、Runtime Instance 和连接都使用稳定 ID。文件名、路径、显示名称和 C# 类型名允许变化，不能直接承担永久身份。

### 平台机制与业务语义分离

基础插件提供工程、文档、编辑、引用、诊断、通信和调试机制。技能、道具、战斗节点、任务规则等业务语义由 Catalog 和项目扩展提供。

### 声明优先，代码扩展兜底

属性、类型、菜单、引用和常见校验优先通过 JSON 声明表达。只有动态查询、复杂校验和特殊 UI 才使用可执行扩展。

### AI 与人工使用同一核心

VS Code 和 MCP 都依赖 VisualBridgeCore，不分别实现文档解析、编辑事务和校验规则。

## 总体架构

```text
┌──────────────────────── Authoring Project ────────────────────────┐
│                                                                  │
│  Source Documents       Catalog / Schema       Project Extension │
│  ├─ Logic Graph         ├─ Types               ├─ Manifest        │
│  ├─ Game Flow           ├─ Nodes               ├─ TS Provider     │
│  ├─ Properties          ├─ References          └─ Optional UI     │
│  └─ Tables              └─ Connection Rules                        │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
             ↑                     ↑                     ↑
             └─────────────────────┼─────────────────────┘
                                   │
                         VisualBridgeCore / Service
                                   │
                         ┌─────────┴─────────┐
                         │                   │
                  VS Code Extension       MCP Server
                  人工可视化编辑           AI 交互
                         │                   │
                         └─────────┬─────────┘
                                   │
                              Unity Bridge
                                   │
                     Unity Editor / Runtime Player
```

## Authoring Project

### 工程概念

Authoring Project 是平台自己的工程边界，与 Unity Project 和 VS Code Workspace 是不同概念：

- 一个 Unity Project 通常对应一个 Authoring Project。
- 一个 VS Code 窗口可以加载多个 Authoring Project。
- 一个 Authoring Project 可以声明多个文档根目录和 Profile。
- Authoring Project 的可编辑根目录是 Unity 工程根目录的直接子目录，与 `Assets` 平级。
- 可编辑根目录的文件夹名由具体游戏工程自定义，不作为平台识别工程的依据。

可编辑根目录由固定的 `VisualBridge.project.vbjson` 标识。该文件使用 VisualBridge 专属文件名和 `.vbjson` 后缀，内容为 JSON。VS Code 插件只有在工作区中发现并成功解析该文件后，才启用 VisualBridge 工程功能。

### 游戏工程建议结构

```text
GameProject/
├─ Assets/
├─ <EditableRoot>/
│  ├─ VisualBridge.project.vbjson
│  ├─ .visualbridge/
│  │  ├─ generated/
│  │  │  ├─ types.catalog.json
│  │  │  ├─ assets.catalog.json
│  │  │  ├─ nodes.catalog.json
│  │  │  └─ references.catalog.json
│  │  └─ cache/
│  ├─ Logic/
│  ├─ Flow/
│  ├─ Config/
│  ├─ Tables/
│  ├─ Dialogue/
│  ├─ Extensions/
│  │  ├─ GameData/
│  │  └─ ProjectRules/
│  └─ Tools/
│     └─ VisualBridgeMcp/
├─ Packages/
└─ Library/
   └─ VisualBridge/
      └─ Discovery/
```

目录职责：

- `<EditableRoot>`：与 `Assets` 平级的 VisualBridge 可编辑根目录，文件夹名由游戏工程自定义。
- `VisualBridge.project.vbjson`：工程边界与插件启用标识，同时声明版本、文档根目录、各 Document Type 使用的 Catalog 列表和扩展。
- `.visualbridge/generated`：由 Unity 或其他生成器输出并可供离线工具使用的描述数据。
- `.visualbridge/cache`：本地索引和临时数据，不进入 Git。
- `Logic`、`Flow`、`Config`、`Tables` 和 `Dialogue`：真正需要编辑、评审和提交的游戏内容；目录名和启用范围可由 Project File 声明。
- `Extensions`：项目业务扩展的 Manifest、源码和必要 UI 产物。
- `Tools`：项目内 MCP 和开发辅助入口。
- `Library/VisualBridge`：Unity 实例发现和运行中临时状态，不进入 Git。

### VisualBridge Project File 职责

VisualBridge Project File 概念上声明：

- ProjectId 和工程格式版本。
- 文档根目录和包含/排除规则。
- 启用的 Document Type。
- Catalog 和 Schema 位置。
- 项目扩展 Manifest。
- Unity Profile 和生成范围。
- 工具与协议版本要求。

VisualBridge Project File 不保存编辑器窗口状态、连接端口、当前调试会话和其他临时信息。

首个落地版本包含 `formatVersion`、`projectId`、`documentRoots` 和 `documentTypes`。每个 Document Type 至少声明稳定 `id`、编辑器模块 `editor`、包含规则 `include`，并可声明排除规则 `exclude` 和工程相对 `catalogs` 数组。路径和 Glob 统一使用 `/` 分隔，所有文档根目录和 Catalog 必须位于 Project File 所在目录内。

### 工程发现和索引

插件首先在当前 VS Code Workspace 中发现 VisualBridge Project File。只有发现并成功解析该文件的工程才创建 ProjectContext。打开 Authoring 文件时，再从当前文件目录向上寻找最近的 VisualBridge Project File，以确定文件归属。

```text
发现 VisualBridge Project File
  -> 校验 JSON 和工程边界
  -> 创建 ProjectContext
  -> 打开文档并确定所属 ProjectContext
  -> 加载 Document Type、Catalog 和扩展
  -> 建立文档概要索引
  -> 完整加载当前文档
  -> 监听文件变化
```

首次建立工程索引时只读取文档概要。当前打开、被引用或参与校验的文档再完整解析。后续使用文件监听增量更新，不在每次打开文档时全量重扫。

## Document System

### Document Type

平台以 Document Type 作为核心扩展点。每种文档类型概念上提供：

```text
DocumentType
├─ TypeId 与文件匹配规则
├─ Schema 与版本
├─ Parser / Serializer
├─ Editor 类型
├─ Edit Operations
├─ Validators
├─ Reference Rules
├─ Compiler / Exporter
└─ Debug Mapping
```

平台初期重点支持：

- Graph Document：逻辑图、状态机、游戏流程。
- Structured Document：属性、对象和集合配置。
- Table Document：表格型配置。

对话、任务、行为树和时间轴等文档在核心稳定后增加。

### Graph Document V3 与 Graph Catalog V4

当前落地的 Graph Document 使用 `.vbgraph` JSON 文本格式，并通过 Graph Catalog 提供语义规则：

- 顶层包含 `formatVersion`、`documentId`、`rootGraphId` 和平铺的 `graphs` 集合。
- 每个 Graph 自身包含稳定 ID、显示名称、JSON 属性和公开接口；右侧 Graph Inspector 只编辑当前 Graph，并可折叠到画布侧边。
- 一个文件拥有根图及其内嵌子图；子图节点以稳定 `subgraphId` 独占另一个 Graph，包含关系不得递归成环。
- Node、Node Type、Port、Property、Graph 和 Graph Interface 均使用独立于显示名称与实现类名的稳定 ID。
- Edge 显式区分 `flow` 与 `data`。流程边决定执行顺序并允许环路；数据边只传值，不决定执行顺序。
- Graph Document Type 可以加载多个 Graph Catalog。Registry 记录每个节点类型的所属 Catalog，并统一解析 Graph Type、节点类型、跨 Catalog Data Type 和旧类型 alias。
- Graph Catalog V4 定义节点类型、端口方向、连接种类、数据类型及其可选显示颜色、连接数量、属性、默认值和旧类型别名。未配置颜色时编辑器按 Data Type ID 从内置色板稳定取色；颜色只影响字段、数据端口与数据连线的呈现。Graph Type 以 `supportedCatalogIds` 粗筛节点 Catalog，再以可选 `allowedNodeSelectors` 精筛节点。
- C# 数值语义在 Data Type ID 中保持为独立的 `int` 与 `float`，不得合并成 `number`。属性的 `valueType: "number"` 仅描述 JSON 数值形态和编辑控件；Unity Catalog Exporter 将 `System.Int32`/`System.Single` 分别映射到 `int`/`float`。
- `List<T>` 字段由带稳定元素 ID 的数据动态组承载，并以 `listPortMode` 在“整个 List 一个输入端口”和“每个元素一个输入端口”之间二选一。元素顺序变化不改变连线身份；整个 List 连接时覆盖完整字面列表，元素连接时只覆盖对应元素。
- `portConnectionRules` 定义 Graph Type 输入/输出端口的 `single` 或 `multiple` 规则；端口 `maxConnections` 只能进一步收紧。跨 Catalog 数据连接继续遵守同一套全局 Data Type 兼容规则。
- 编辑器向有效但已占用的单连接端口创建新连线时，在同一批 Operation 中先删除旧连线再添加新连线；多连接端口达到上限后仍拒绝连接，不自动猜测应替换哪一条。
- 子图通过稳定公开接口与父图连接；跨图连接不能绕过接口直接指向内部节点。子图输入/输出接口节点可创建稳定 ID 的动态数据参数；其类型由子图内部或父图外部首次具体连接锁定，只要任一侧仍有连接就保持，全部断开后恢复 `any`。动态参数在子图接口节点和父图调用节点中始终显示，未锁定的 `any` 状态使用浅灰色。
- Graph Webview 使用 React 与 React Flow 的受控模式实现画布交互；React Flow 状态仅作为视图状态，不作为文档格式或权威数据源。
- Parser 拒绝未知结构，Serializer 对 Graph、节点、连线和属性键进行确定性排序；接口数组保留用户拖动后的声明顺序。找不到 Catalog 节点类型时仍保留全部原始节点数据。
- Core Operation 覆盖 Graph、节点、内嵌子图、公开接口、连线和安全节点类型替换。

节点标题与 Catalog 字段直接在画布节点上编辑，节点类型只展示不可直接改写。用户通过节点右键菜单请求替换，Core 仅接受不会丢失属性或连线的候选，并以一个 Operation 完成替换。完整落地契约见 `GraphSemanticModel.md`。当前实现范围仍只包含离线编辑，不连接 Unity。

### Table 与 Excel

Table Document 是平台的通用表格语义模型。Excel 是它支持的一种文件载体和交换格式，不单独形成一套与 Document System 平行的编辑体系。

```text
Table Document
├─ Semantic Table Model
├─ Schema / Column Rules
├─ Table Operations
├─ Validation / Reference
├─ Table Editor Webview
└─ Codec
   ├─ Authoring Text Codec
   └─ Excel Workbook Codec
```

工程必须明确每类表格的数据所有权：

- Authoring Text 为权威数据，Excel 只用于导入和导出；这是面向 Git、AI 和多人协作的默认建议。
- `.xlsx` 为权威数据，由 Excel Workbook Codec 统一解析和写回；适用于必须延续现有 Excel 工作流的工程。

无论采用哪种所有权，UI、MCP 和 Unity Compiler 都面向 Semantic Table Model 与 Table Operations，不直接操作工作簿内部二进制结构。工程描述文件和 Provider 可以扩展列类型、枚举、数据引用、Unity 资产引用、校验、预览和跳转能力。

AI 不直接读取或改写 `.xlsx` 和 `.csv` 载体。即使 `.csv` 在物理上是文本，对 AI 也视为 Table Document 载体；AI 必须通过 MCP 提供的表格查询、搜索和修改能力访问 Semantic Table Model。MCP 内部统一使用 Table Codec 和 Table Operations，避免 AI 绕过 Schema、引用和校验规则。

第一阶段只承诺受约束的游戏数据工作簿。宏、图表、透视表、外部链接、复杂公式和完整样式往返保真是否支持，由具体 Excel Codec 的能力范围决定，不作为通用 Table Editor 的默认承诺。

### 编辑器原语

基础插件提供有限但高复用的编辑器原语：

- Graph Canvas。
- 可折叠 Graph Inspector，以及节点内联字段编辑。
- Table Editor。
- Reference Picker。
- Object、Collection 和 Dictionary Editor。
- Search、Command Palette 和 Problems。
- Diff Preview 和 Runtime Trace Overlay。

业务 Document Type 应优先组合原语，而不是为每种配置重新实现完整 Webview。

### 编辑事务

所有编辑通过领域操作完成：

```text
用户或 AI 意图
  -> Document Operation
  -> Edit Transaction
  -> 完整校验
  -> 确定性序列化
  -> 宿主持久化适配写入
```

编辑事务至少具备：

- `baseHash` 或等价版本前置条件。
- 批量操作和全部成功/全部失败语义。
- 稳定 ID 生成。
- 完整文档校验。
- 确定性格式化。
- 结构化诊断和变更摘要。

DocumentSession 保存当前编辑基线的 Hash。VS Code 在实际写入前再次检查目标文件；如果目标文件自基线建立后已被其他窗口、AI、MCP 或外部程序修改，不自动合并或静默覆盖，而是向用户提供：

- 覆盖：使用当前 DocumentSession 内容覆盖磁盘上的外部变更。
- 放弃并刷新：放弃当前未写入变更，重新读取目标文件并刷新编辑窗口。

用户未做出选择时不执行写入。MCP 遇到同类 `baseHash` 冲突时返回结构化冲突结果，不自动覆盖。

VS Code 的文本 Document 通过 `WorkspaceEdit` 保留 Undo/Redo。`.xlsx` 等二进制 Document 通过 Custom Document 的编辑事件、保存和备份机制与 VS Code 协作。MCP 采用原子文件写入。两者使用同一 Operation 模型，但按文件载体使用不同的宿主持久化适配。

### 数据所有权

源文件只保存领域必要信息，不保存能够推导的运行时数据，例如：

- Unity Object 本地引用。
- 运行时数组索引。
- 临时连接状态。
- 调试断点和当前执行位置。
- UI 组件内部序列化状态。
- Provider 缓存。

编辑布局是否属于源文件由 Document Type 决定；如果布局影响协作和可读性，则作为明确的 Editor Metadata 保存。

## Catalog 与 Reference System

### Catalog

Catalog 是外部工具理解游戏类型的统一入口，可能包含：

- 数据类型和属性。
- 节点类型、端口和连接规则。
- 默认值、范围、枚举和 UI Hint。
- Unity Asset 的稳定引用与显示信息。
- 游戏数据引用类型。
- 废弃、别名和最小迁移信息。

Catalog 默认是确定性生成的文本文件。是否提交 Git 由项目策略决定；如果希望 VS Code、AI 和 CI 在不启动 Unity 时工作，则应提交必要 Catalog。

同一 Document Type 声明的多个 Catalog 会构成一个 Registry。Catalog ID 和 Data Type ID 全局唯一；Node Type 与 Graph Type 的规范 ID 和 alias 在各自命名空间内全局无歧义。节点归属声明它的 Catalog，Catalog `title` 是该节点在创建列表中的根路径，节点 `menuPath` 在根路径后继续扩展。Registry 统一校验跨 Catalog 引用，不按文件加载顺序解决冲突。

### Reference Kind

统一引用系统以 Reference Kind 区分数据来源，例如：

```text
unity.asset
game.item
game.skill
game.level
authoring.document
authoring.element
```

Reference Provider 提供：

- 搜索候选项。
- 根据 ID 解析名称和摘要。
- 校验引用。
- 跳转定义和查找引用。
- 按需提供预览信息。

编辑器、MCP 和 AI 都使用相同 Reference Service，不直接理解各业务数据库。

## VS Code 基础插件

### 职责

基础插件负责：

- Authoring Project 发现和 ProjectContext 管理。
- Document Type 和 Extension Registry。
- Custom Text Editor 和通用 Webview 生命周期。
- 文档索引、引用索引和诊断。
- Edit Transaction 与 `WorkspaceEdit` 协调。
- Unity 实例发现、连接和重连。
- Tree View、状态栏、命令和管理页面。
- Debug Adapter 与 VS Code DAP 映射。

基础插件不包含项目业务节点、游戏配置语义和项目专用引用查询。

### 插件生命周期

- 基础插件是一个 N 合一 VS Code 扩展，Graph、Table/Excel、Structured Config、Debug 和 Unity Connection 是其内部功能模块。
- 插件实例按 VS Code Extension Host/窗口创建。
- 一个插件实例只有一个项目注册表和连接管理器。
- 一个窗口可以持有多个 ProjectContext 和多个 UnityConnection。
- 每个打开文档创建独立 EditorSession/WebviewPanel。
- 关闭 Webview 不终止其他文档和调试连接。
- 不使用全局 `currentProject`、`currentUnity` 或 `currentDocument`。

插件 Shell 保持轻量，只完成 Document Type 匹配和 Provider 注册。Graph、Excel 等重模块在对应文件第一次打开时延迟加载。每个文件拥有独立 DocumentSession、脏状态、Undo/Redo 和 Webview；多个文件共享当前窗口的 Extension Host，不为每个文件启动一份扩展进程。

VS Code 扩展一旦在某个窗口内激活，通常持续到该窗口关闭或重新加载。关闭某类文件的最后一个编辑会话时，插件应主动释放该模块的 Workbook、索引、文件监听、Worker、子进程和运行时订阅；Extension Shell 可以继续驻留。不同 VS Code 窗口拥有独立的 Extension Host、模块状态和文档会话。

### 原生 Explorer 与文件编辑器关联

用户直接使用 VS Code 原生 Explorer，不要求使用平台自定义文件树，也不要求先执行“启动插件”命令。VS Code 工作区中只有发现并成功解析 VisualBridge Project File 后，才启用 VisualBridge 工程功能。插件启用后，用户在 Explorer、Quick Open、搜索结果或引用跳转中打开该工程声明的指定类型文件时，才创建对应的编辑窗口：

```text
VS Code 原生 Explorer
  -> Workspace 中发现 VisualBridge Project File
  -> 启用 Extension Shell 并创建 ProjectContext
  -> 打开工程声明的指定类型文件
  -> Custom Editor 匹配并校验文件归属
  -> 按需加载 Document Type 模块
  -> 创建 DocumentSession 和 Webview
```

插件工程功能的启用条件是“当前 Workspace 中存在有效的 VisualBridge Project File”；具体编辑窗口的创建条件是“有效 ProjectContext 内的指定类型文件被打开”。打开入口不依赖 Explorer；Quick Open、搜索结果、引用跳转和命令打开应获得相同行为。

文件关联遵循以下规则：

- 平台专属格式可以将对应 Custom Editor 声明为默认编辑器。
- `.xlsx`、`.json` 等通用格式不得通过用户级全局关联强制接管。
- Authoring Project 需要默认接管通用格式时，应通过 `.code-workspace` 或工作区级 `workbench.editorAssociations` 只影响当前工程窗口。
- VisualBridge Project File 负责声明该工程启用的 Document Type、文件匹配规则和功能模块；Custom Editor 打开后仍需验证文件属于有效 ProjectContext。
- 未发现有效 VisualBridge Project File 时不启用工程功能；不属于有效 ProjectContext 的通用文件不创建业务 DocumentSession，并使用默认编辑器打开。
- Custom Editor 的静态声明即使存在，也只表示编辑器可用；没有打开对应文件时不加载 Excel、Graph 等重模块。

对于 `.xlsx` 等二进制文件使用 Custom Editor Provider 和 Workbook Codec；对于平台文本格式可以使用 Custom Text Editor Provider。两者最终都进入统一的 Document Operation、校验、引用和保存流程。

### Webview 边界

Webview 使用 HTML、CSS 和 JavaScript/React 实现复杂编辑器。Webview 只负责视图与交互，不直接访问文件系统、Node.js、Unity 或调试连接。

```text
Webview
  -> 用户意图
Extension Host
  -> VisualBridgeCore
  -> Host Persistence / Provider / UnityConnection
```

## Unity Bridge

### 定位

Unity Bridge 是通用 Unity Package，负责 Unity 和 VisualBridge 之间的适配：

- 扫描 C# 类型和 Attribute。
- 生成类型、节点、资产和引用 Catalog。
- 导入和编译 Authoring Document。
- 保存稳定 DocumentId、ElementId 与运行时结构的映射。
- 启动 Editor 本地通信服务。
- 提供 Player 远程通信。
- 发送调试事件和运行时变量。
- 根据请求打开 VS Code 中的 Authoring Document。

Graph 完成前不实现上述 Unity 代码。后续 Catalog Exporter 必须输出 Graph Catalog V4，把稳定 `catalogId`/显示根 `title`、Graph/Node Type 的显式全局无歧义 ID、节点 Catalog 归属、Graph 用途、`supportedCatalogIds`、`portConnectionRules`、允许节点 selector、实例数量约束、初始节点以及 typed subgraph 目标类型写入确定性 Catalog；C# 全名只作为 `source` 追踪信息，不能充当持久身份。Exporter 不执行业务 `OnCreate()` 获取默认值，也不得用旧格式覆盖更高版本 Catalog。当前 Unity Package 尚未实现这些功能。

不同业务模块通过 Unity Adapter 注册具体 Catalog Generator、Importer、Compiler 和 Debug Mapping。

### 编译边界

VisualBridge 不直接加载 Unity 程序集，Unity 也不加载 VS Code 插件代码。两边只通过文本契约和通信协议协作。

```text
Authoring Extension
  -> 运行于 Node/VS Code/MCP

Unity Adapter
  -> 运行于 Unity C# 环境

共享
  -> Catalog、Schema、ID 和 Protocol
```

## Extension System

### 扩展层级

平台支持四类扩展：

| 类型 | 运行代码 | 主要用途 |
| --- | --- | --- |
| 声明式扩展 | 否 | Schema、类型、属性、节点、菜单、连接规则 |
| 项目 Provider | 是 | 引用查询、复杂校验、领域操作、数据转换 |
| 项目 Webview Module | 是 | 无法用通用控件表达的自定义 UI |
| VS Code 伴生扩展 | 是 | 深度 VS Code API、跨项目通用能力 |

### 声明式扩展

声明式扩展应覆盖大部分项目需求，可在不执行工程代码的情况下加载。常见属性编辑使用内置 Form、Reference Picker 和 Collection Editor。

### 项目 Provider

项目 Provider 作为独立进程运行，通过 stdio JSON-RPC 或后续确定的等价协议与基础插件通信。Provider 可以提供：

- Reference Provider。
- 自定义 Validator。
- Document Operation。
- 数据查询和预览。
- 项目级导入、转换和辅助命令。

Provider 不直接访问 VS Code API，不直接修改文档文件。修改请求返回领域 Operation，由基础插件或 VisualBridgeCore 执行。

### TypeScript Provider 运行策略

项目 Provider 和 MCP Server 可以采用源码运行模式：

```text
node <provider.ts>
node <mcp-main.ts>
```

项目统一规定最低 Node.js 版本，并只使用 Node 原生可擦除的 TypeScript 语法。此模式不要求普通使用者执行 npm 安装或生成 `dist`。

限制：

- Node 运行时不做类型检查。
- 不依赖需要转译的 TypeScript 语法。
- 不使用 `tsconfig paths` 作为运行时路径机制。
- 零第三方运行依赖，或由平台统一提供依赖分发。
- 修改后通过重启 Provider 生效。

基础插件不能把项目 `.ts` 直接导入 Extension Host。它只在工作区受信任后启动独立 Node 进程，避免项目异常或依赖污染基础插件。

### 自定义 UI

浏览器/Webview 不能直接运行 TypeScript/TSX。自定义 React 属性编辑器需要构建为 JavaScript/CSS。为了降低构建需求，项目应优先使用：

```text
声明式 UI
  -> 内置 UI + TS Provider
  -> 最后才使用自定义 Webview Module
```

### VS Code 伴生扩展

需要 VS Code 原生 API、跨项目复用或独立发布的功能做成正式伴生扩展，通过基础插件导出的版本化 API 注册能力。项目目录中的代码不能自动成为 VS Code Extension。

### 安全边界

- 未信任工程只加载源文档、Catalog 和声明式扩展。
- Provider、MCP 和项目 Webview 代码必须在工程受信任后运行。
- VisualBridge Project File 显式声明扩展，不自动扫描并执行全部脚本。
- Provider 使用可验证的可执行入口和参数，不拼接 Shell 命令。
- 扩展能力以 ProjectContext 为作用域，项目关闭时全部释放。
- 项目扩展不能替换核心文件解析、稳定 ID 和通信安全策略。

## AI 与 MCP

### 职责选择

在本平台中：

- MCP 是 AI 的交互 API。
- AI 可以直接读取普通文本源文件、Catalog 和 Schema，但 `.xlsx` 和 `.csv` 类 Table Document 必须通过 MCP 访问。
- VS Code 是人工可视化入口。

```text
VisualBridgeCore
├─ VS Code Adapter
└─ MCP Adapter
```

MCP 不自行重复实现文档规则，所有解析、Operation、校验和引用能力统一来自 VisualBridgeCore。

### MCP Server 生命周期

第一阶段使用项目级 stdio MCP Server，由当前 AI Host 启动：

```text
AI Host
  -> 启动 Node MCP Server 子进程
  -> 通过 stdin/stdout 调用
  -> AI 会话结束后关闭子进程
```

MCP Server 独立加载 Authoring Project，并按需连接 Unity，不要求 VS Code 正在运行。多个 AI Agent 启动各自的 MCP Server，通过 `baseHash`、原子文件写入和调试 Lease 协调。

### MCP 能力边界

MCP 提供少量稳定的项目级能力：

- 查询工程、Document Type、Catalog 和扩展能力。
- 列出、检查、校验和格式化文档。
- 批量执行 Document Operations。
- 通过 Semantic Table Model 搜索、查询和修改 `.xlsx` 与 `.csv` Table Document。
- 搜索和解析数据引用。
- 发现并 Attach Unity Runtime。
- 设置断点、控制执行、读取调用栈和变量。

不为每个节点或属性操作创建大量顶层 Tool。领域差异通过 Document Operation Schema 表达。

## 实例发现与通信

### Editor 发现

Unity Editor 在 Authoring Project 的临时目录登记实例：

```text
Library/VisualBridge/Discovery/<UnitySessionId>.json
```

注册信息概念上包含：

- 协议版本。
- ProjectId、ProfileId 和 UnitySessionId。
- 进程、Unity 版本和启动时间。
- 本机通信端点。
- 临时认证信息。
- 心跳时间。

发现和通信分离：注册文件只提供候选实例，最终身份通过连接握手验证。

### 通信方式

Unity Editor 与同机工具使用 Loopback WebSocket。Player 使用网络 WebSocket。两者复用上层消息协议：

```text
Unity Editor
  -> Project Discovery File
  -> ws://127.0.0.1:<dynamic-port>

Runtime Player
  -> 设备发现或手动地址
  -> ws://<device-address>:<port>
```

Editor 只绑定 Loopback 地址并使用动态端口。Player 的设备发现、配对和安全策略独立设计。

### 多客户端

客户端身份按 VS Code Extension Host 或 AI MCP Session 创建，不使用 VS Code 操作系统进程 PID。

- 一个 VS Code 窗口可以连接多个 UnitySession。
- 一个 Authoring Document 同时选择一个活动 Runtime。
- 一个 Runtime 可以连接多个 VS Code 和 AI Client。
- 命令路由从 Document/DebugSession 映射到 UnitySession，不能依赖全局当前 Unity。

## Debug System

### 通用调试身份

调试协议使用：

- ProjectId。
- DocumentId。
- ElementId。
- RuntimeInstanceId。
- UnitySessionId。
- SourceHash 和 CatalogHash。

不使用文件名、Unity 数组索引或对象地址作为跨工具身份。

### 调试核心

```text
Unity Debug Protocol
        ↑
DebugSessionService
   ↑             ↑
DAP Adapter     MCP Debug Tools
VS Code         AI
```

VS Code 通过 DAP 获得断点、暂停、调用栈和变量 UI。AI 通过 MCP 获得结构化调试工具。两者共享调试语义，但不互相调用。

### Controller 与 Observer

一个 Unity Runtime 同时最多有一个 Controller，可以有多个 Observer：

- Controller 可以暂停、继续、单步和修改有效断点。
- Observer 可以读取状态、事件、调用栈和变量。
- AI 不自动抢占 VS Code 控制权。
- 控制权通过显式请求和 Lease 管理。
- Controller 失联后由超时策略回收。

### AI 调试

AI MCP Server 自己发现并连接 Unity，在 AI 会话期间保持 DebugSession。典型流程：

```text
发现 Runtime
  -> Attach Observer/Controller
  -> 检查 SourceHash
  -> 设置 Element 断点
  -> Continue / Step
  -> 等待 Stop Event
  -> 查询 Stack / Scope / Variables
  -> 修改 Authoring Document
  -> 校验并请求 Unity 重载
  -> 再次验证
```

异步调试事件通过带递增 Sequence 的等待/查询机制提供，避免 AI 高频轮询或遗漏事件。变量查询支持分页和路径过滤，避免一次返回大量运行时状态。

断点、调用栈、Controller、Trace 和当前执行位置属于会话状态，不写入 Authoring 源文件。

### 运行版本一致性

Unity 调试事件携带 SourceHash/CatalogHash。工具检测到磁盘文件与运行版本不一致时显示明确的 Outdated 状态，不把新文件 Element 强行映射到旧 Runtime。

## 新平台仓库结构

建议使用单仓库管理平台核心、VS Code、Unity Bridge 和协议：

```text
VisualBridge/
├─ Doc/
│  ├─ README.md
│  ├─ VisualBridgeArchitecture.md
│  └─ Temp/
├─ Protocol/
│  ├─ Schema/
│  ├─ Messages/
│  └─ Generated/
├─ Core/
│  ├─ Project/
│  ├─ Document/
│  ├─ Edit/
│  ├─ Reference/
│  ├─ Diagnostics/
│  ├─ Extension/
│  └─ Debug/
├─ Editors/
│  ├─ Shared/
│  ├─ Graph/
│  ├─ Form/
│  └─ Table/
├─ BuiltInExtensions/
│  ├─ Graph/
│  └─ StructuredConfig/
├─ Tools/
│  ├─ VSCodeExtension/
│  └─ VisualBridgeMcp/
├─ Packages/
│  └─ com.kyl.visualbridge/
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

### 阶段二：VS Code 编辑闭环

- 注册 Custom Text Editor。
- 实现 Graph Canvas、节点内联字段和可折叠 Graph Inspector 的最小能力。
- 通过 `WorkspaceEdit` 完成文本 Document 的保存和 Undo/Redo，并实现外部变更检测、覆盖确认与放弃刷新。
- 建立 Project Tree、Problems 和状态栏。

阶段目标是人工与 AI 能编辑同一源文件，并得到一致结果。

### 阶段三：Catalog、Reference 与项目扩展

- Unity 生成基础类型、节点和资产 Catalog。
- 实现 Reference Service 和通用 Reference Picker。
- 实现声明式扩展和 TypeScript Provider。
- 实现 Provider 重启、诊断和 Workspace Trust 边界。

阶段目标是让项目业务能力在不修改基础插件的情况下接入。

### 阶段四：Unity Editor 连接

- 实现 Project Discovery File。
- 实现 Loopback WebSocket、握手、重连和多客户端。
- 实现 Unity 请求打开文档。
- 实现 Authoring 文档导入与最小运行时编译。

### 阶段五：Debug 与 MCP

- 实现通用 DebugSessionService 和运行时身份映射。
- 接入 VS Code DAP。
- 为已有项目级 stdio MCP Server 增加 Runtime Attach 和调试能力。
- 向 AI 提供引用和调试能力。
- 实现 Controller/Observer Lease 和 SourceHash 检查。

### 阶段六：第二种 Document Type

- 实现 Structured Config 或 Table Document。
- 验证 Form、Reference、Validation 和扩展机制是否真正通用。
- 根据两个垂直切片提炼共享 API，避免只为 Graph 过度抽象。

### 阶段七：Player 与生态

- 复用 WebSocket 协议连接 Player。
- 增加设备发现、配对和安全策略。
- 增加更多 Document Type、伴生扩展和语言服务。
- 完善版本迁移、CI、发布和项目模板。

## 关键风险

### 过度通用化

平台从第一天定义通用边界，但不预先实现所有编辑器。通过 Graph 和 Structured Config 两个垂直切片验证抽象。

### Catalog 漂移

生成过程必须确定，并提供 Hash 和过期诊断。工具可以使用已提交 Catalog，但必须知道它是否与当前 C# 或外部数据一致。

### 扩展代码安全

项目 Provider 和 Webview Module 都是工程代码。必须显式声明、受 Workspace Trust 控制，并隔离于基础 Extension Host。

### 多客户端并发

文档修改通过 `baseHash` 和原子事务协调；调试通过 Controller/Observer Lease 协调。第一阶段不提供实时协同编辑。

### Node 版本一致性

直接运行 TypeScript 依赖固定 Node 版本和语法子集。基础插件应检查版本，并将错误限制在对应项目扩展内。

### Unity Domain Reload

Domain Reload 会中断连接。Unity Bridge 重新登记实例，VS Code 和 MCP 使用退避策略重连并重新握手。

### 大型工程性能

工程索引只读取概要，文档按需完整解析。Provider 和 Webview 不因任意文件变化重建全部工程状态。

## 已确定的架构决策

- 平台定位为游戏语义内容创作工具，不替代 Unity 场景和渲染编辑。
- Authoring Project 是独立于 Unity Project 和 VS Code Workspace 的工程概念。
- Authoring Project 的可编辑根目录与 Unity `Assets` 平级，文件夹名可由游戏工程自定义。
- VisualBridge Project File 固定命名为 `VisualBridge.project.vbjson`，内容为 JSON；只有发现有效 Project File 才启用插件工程功能。
- 源文档是唯一权威数据，Unity 数据是导入或编译结果。
- Catalog/Schema 描述能力，Document 保存实例。
- Document Type 是核心扩展点。
- 基础插件提供 Graph、Form、Table、Reference 等通用原语。
- 基础插件采用 N 合一扩展形式，各 Document Type 模块按文件打开事件延迟加载。
- 用户使用 VS Code 原生 Explorer；插件工程功能启用后，打开有效 ProjectContext 声明的指定类型文件时进入对应 Custom Editor，不要求额外启动命令或自定义文件树。
- 插件实例按 VS Code 窗口隔离，每个文件创建独立 DocumentSession，多个文件共享当前窗口的 Extension Host。
- 平台专属格式可以默认关联自定义编辑器，`.xlsx` 等通用格式只通过 Authoring Project 的工作区级关联在当前工程窗口接管。
- Table Document 提供统一语义模型，Excel 是可选权威载体或导入导出 Codec；AI 不直接读写 `.xlsx` 和 `.csv`，必须通过 MCP 的搜索、查询和修改能力访问。
- VS Code 写入前检测目标文件是否已被外部修改；发生冲突时必须由用户选择覆盖，或放弃本地变更并重新读取刷新。
- VS Code 和 MCP 共享 VisualBridgeCore。
- MCP 是 AI 的唯一交互 API。
- stdio MCP Server 由 AI Host 按会话启动。
- 项目 Provider 和 MCP Server 可以要求固定 Node 版本并直接运行 TypeScript 源码。
- 项目 `.ts` 不直接加载到 VS Code Extension Host。
- 自定义 Webview TypeScript/TSX 仍需要构建为 JavaScript/CSS。
- 内置 Graph Canvas 使用 React 与 React Flow；React Flow 的节点和连线数据由 Graph Document 派生，用户交互必须转换为 Graph Operation 后才能写入源文档。
- Graph Catalog V4 支持多 Catalog Registry、节点 Catalog 归属、显示根名、Graph Type 支持 Catalog、允许节点精筛、输入/输出连接数量规则、直接节点数量约束和 typed subgraph 调用契约；节点的 `menuPath` 是相对所属 Catalog 显示根名的扩展路径。旧 Catalog V1-V3 可读取，缺省支持声明自身 Catalog 且输入/输出均为 `multiple`；序列化升级为 V4。Graph Document 继续保持 V3，并为根图和每个内嵌图保存独立 `graphTypeId`。
- Graph Type 一经设置暂不允许任意修改；节点和子图创建、删除及安全替换必须保持数量约束，子图调用节点的静态数据端口与子图公开接口共同形成父图端口契约。
- 声明式扩展优先，项目 Provider 处理复杂逻辑。
- Unity Editor 与本机工具使用 Project Discovery File 和 Loopback WebSocket。
- Player 使用网络 WebSocket并复用上层协议。
- 多调试客户端使用单 Controller、多 Observer 模型。
- 调试使用 ProjectId、DocumentId、ElementId、RuntimeInstanceId 和 SourceHash。
- VisualBridge 使用单仓库管理 Core、VS Code、MCP、Unity Package 和 Protocol，Unity Package 目录名为 `com.kyl.visualbridge`。
- 正式文档保存在 `Doc`；开发中的临时设计和任务文档保存在 `Doc/Temp`，完成后删除。

## 留待实施阶段确定

- Document、Catalog、Schema 和 Extension Manifest 的完整字段。
- 稳定 ID 的生成、别名和迁移规则。
- Graph、Structured Config 和 Table 的最终文本格式。
- Operation Schema、错误码和诊断位置格式。
- Provider JSON-RPC 消息和生命周期细节。
- MCP SDK 的依赖分发方式和具体 Tool/Resource Schema。
- Node 最低版本、类型检查和第三方依赖策略。
- Graph 之外的 Webview UI SDK、组件模型、隔离和热重载方式。
- Unity Catalog Generator、Importer 和 Compiler API。
- WebSocket 消息、认证、配对和安全策略。
- Controller Lease、断线恢复和调试事件缓存策略。
- Player 设备发现方式。
- VS Code、UPM Package、MCP 和 Protocol 的版本联动。
- 旧数据导入、迁移和兼容周期。
- 平台发布、安装、更新和企业内部插件分发方式。

上述内容应在对应开发阶段形成独立设计文档，并保持本文确定的数据所有权、组件边界和身份模型。
