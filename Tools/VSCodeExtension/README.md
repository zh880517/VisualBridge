# VisualBridge VS Code Extension

本包是 VisualBridge 的 VS Code Host Adapter。扩展只在本地工作区发现并验证 `VisualBridge.project.vbjson` 后建立 Project 功能；Graph、Entity、Structured 和 Table 的 Parser、Catalog、Operation、Validator、Reference 与 Serializer 来自共享 Core/Built-in 包，不在 Extension Host 中复制领域规则。

当前 VSIX 是私有 `UNLICENSED` 产物，不通过 Marketplace 分发。Unity Catalog Exporter、Importer、Compiler、Editor Bridge、Runtime 和 Debug 尚未实现。

## 安装与首次使用

完整流程见 [安装与快速开始](../../Doc/GettingStarted.md)。从仓库根目录构建并执行隔离包验证：

```powershell
nvm use 22.22.1
npm ci
npm run package:vscode
npm run test:vscode:cli
```

`test:vscode:cli` 使用临时 User Data 和 Extensions 目录，不修改用户现有 VS Code 配置。实际安装到当前配置可运行 **Extensions: Install from VSIX...**，或：

```powershell
code --install-extension .\Tools\VSCodeExtension\artifacts\visualbridge.vsix --force
```

安装后打开 [`Samples/PreUnityAuthoring`](../../Samples/PreUnityAuthoring/README.md)。`workspaceContains:**/VisualBridge.project.vbjson` 在工作区出现固定文件名时触发扩展激活；只有 Project File 严格解析和工作区校验成功后，才创建可用 ProjectContext 并在 **VisualBridge / Documents** 与 **VisualBridge / Catalogs** 中显示内容。

## Project 与文件路由

Project File 的 `documentTypes[].editor` 是可扩展的稳定 Adapter ID，Project Schema 与 Core 接受任意合法值。当前 VSIX 为 `graph`、`entity`、`structured` 和 `table` 注册领域 Adapter；匹配其他稳定 ID 的文本文件仍可进入通用只读 Document Shell，显示 Project、Document Type、Adapter ID、路径和当前源码，但没有领域编辑、Catalog 语义、语义索引、Reference 或 Lifecycle。MCP Project API 会把这类声明保留为 `adapterAvailable: false`，需要领域 Adapter 的 MCP 操作不可用。稳定 `id` 表示项目业务子类，`include` / `exclude` 拥有文件归属；扩展名不是类型判别器。

Manifest 的默认 `visualbridge.documentEditor` selector 包含 `.vbgraph`、`.vbentity` 和 `.vbconfig`，但这些只是静态便利入口，文件仍必须被 Project Registry 唯一匹配到一个声明的稳定 `editor` ID。项目自定义后缀使用 **VisualBridge: Open Document**、Documents 视图或工作区级 `workbench.editorAssociations`；已注册 ID 进入对应领域编辑器，未注册 ID 进入通用只读 Shell。`.csv`、`.xlsx` 等通用格式不会通过用户级关联被 VisualBridge 全局强制接管；Table 使用可选的通配 Custom Editor，并在打开后验证 Project 归属。

## 公开生产 Command ID

下表与 `package.json` 的 `contributes.commands` 一一对应。`visualbridge.test.*` 只在非 Production Extension Host 注册，不属于 manifest 或公开用户接口。

| Command ID | Manifest 标题 | 入口与用途 |
| --- | --- | --- |
| `visualbridge.refreshProjects` | VisualBridge: Refresh Projects | 重新发现并验证工作区 Project。 |
| `visualbridge.openDocument` | VisualBridge: Open Document | 按 Project Registry 打开 Explorer/URI 指向的语义文档。 |
| `visualbridge.openProjectSettings` | VisualBridge: Open Project Settings | 打开有效 Project File 的结构化 Settings Editor。 |
| `visualbridge.createGraphDocument` | VisualBridge: Create Graph Document | 创建 Graph 文档。 |
| `visualbridge.createEntityDocument` | VisualBridge: Create Entity Document | 创建 Entity 文档。 |
| `visualbridge.createStructuredDocument` | VisualBridge: Create Structured Config | 创建 Structured Config。 |
| `visualbridge.createTableDocument` | VisualBridge: Create Table Document | 创建 CSV-compatible 或 XLSX Table。 |
| `visualbridge.createDocument` | VisualBridge: Create Document | 从 Project Document Type 统一选择并创建。 |
| `visualbridge.safeDeleteElement` | VisualBridge: Safe Delete Element | 由领域编辑器携带结构化目标发起元素 Safe Delete；不接受无目标的手工删除。 |
| `visualbridge.documentBrowser.refresh` | Refresh Documents | 刷新 Documents 语义索引。 |
| `visualbridge.documentBrowser.search` | Search Documents | 搜索标题、ID、路径、诊断和引用。 |
| `visualbridge.documentBrowser.validateAll` | Validate All Documents | 完整校验并发布 Problems。 |
| `visualbridge.documentBrowser.open` | Open Document | 打开 Document Browser 当前节点。 |
| `visualbridge.documentBrowser.create` | Create Document | 在当前 Document Type 下创建。 |
| `visualbridge.documentBrowser.copy` | Copy Document (Remap Stable IDs) | 预览并复制完整 Document，同时 remap 稳定身份。 |
| `visualbridge.documentBrowser.renamePath` | Rename Path (Keep Stable IDs) | 只改变物理路径，保留稳定身份与引用值。 |
| `visualbridge.documentBrowser.move` | Move Document (Keep Stable IDs) | 移动完整物理 source manifest。 |
| `visualbridge.documentBrowser.safeDelete` | Safe Delete Document | 拒绝存在闭包外入站引用的文档删除。 |
| `visualbridge.documentBrowser.revealReference` | Reveal Reference | 跳转唯一解析的 Reference 目标。 |
| `visualbridge.documentBrowser.renameReferenceTarget` | Rename Reference Target | 预览并原子重命名目标稳定值及全部入站引用。 |
| `visualbridge.catalogBrowser.refresh` | Refresh Catalogs | 重新加载 Catalog Registry 与来源状态。 |
| `visualbridge.catalogBrowser.open` | Open Catalog | 以只读检查用途打开物理 Catalog 文本。 |

## View ID 与 Custom Editor viewType

### Activity Bar View

| View ID | 显示名 | 作用 |
| --- | --- | --- |
| `visualbridge.documents` | Documents | 文档、物理来源、诊断、Outgoing/Incoming Reference 和 Lifecycle 入口。 |
| `visualbridge.catalogs` | Catalogs | 只读 Registry、类型、alias、Hash、stale 状态和诊断。 |

两个 View 都位于 `visualbridge` Activity Bar container。

### Custom Editor

| viewType | Manifest priority | selector / 用途 |
| --- | --- | --- |
| `visualbridge.projectSettingsEditor` | `default` | `VisualBridge.project.vbjson` 的 Project Settings。 |
| `visualbridge.documentEditor` | `default` | `.vbgraph`、`.vbentity`、`.vbconfig` 的便利入口；已注册文本 Adapter 进入领域会话，未注册稳定 ID 进入通用只读 Shell。 |
| `visualbridge.documentEditor.option` | `option` | 任意扩展名的可选文本 Document 入口，沿用同一 Adapter/Shell 路由。 |
| `visualbridge.tableEditor` | `option` | 任意扩展名的可选 Table Custom Editor，实际要求 Project Registry 匹配 `editor: "table"`。 |

## 当前编辑能力

- Graph V3 / Graph Catalog V4：React Flow 受控画布、Graph Type、数量与连接限制、typed subgraph、动态端口、公开接口、节点安全替换、内联字段、多选、Copy/Paste/Duplicate、MiniMap、Reference 定位与外部修改冲突提示。
- Entity V1 / Entity Catalog V1：根字段、有序 Component 卡片、搜索添加、启用、拖动、复制、Safe Delete、共享递归 Form/Reference 和外部修改冲突提示。
- Structured Config V1：Project 唯一类型绑定、完整递归字段、Reference、确定性 JSON、Undo/Redo 和外部修改冲突提示。
- Table V1 / Table Catalog V1：CSV family、XLSX、稳定记录列表虚拟化、搜索、共享 Form、行操作、Reference、完整 physical manifest Hash 和阶段化保存。
- 未注册稳定 Adapter ID：通用只读 Document Shell，只显示匹配元数据与当前源码，不建立领域会话、语义索引或 Lifecycle 能力。
- Project Settings：Document Root/Type、glob、Catalog、Table Layout、Provider 的结构化 Operation 与 WorkspaceEdit。
- Document Browser / Catalog Browser：统一索引、Problems、Reference、Refactor、Lifecycle 和 Catalog 来源状态。

实际操作步骤、Table 限制和冲突恢复见 [Authoring 使用手册](../../Doc/AuthoringUserGuide.md)。领域和宿主正式设计从 [文档目录](../../Doc/README.md) 进入。

## Trust、诊断与日志

扩展声明 `untrustedWorkspaces.supported=true` 和 `virtualWorkspaces.supported=false`。Restricted Mode 可以加载源文档、Catalog 和声明式内置能力，但绝不启动 Project Provider。Provider 是当前用户权限下的受信任 `.mjs` 工程代码，只在 Workspace Trust 允许时以独立子进程运行；它只能通过 V2 协议增加 Reference/Validator，不能增加写 Operation。

- Project、Catalog、Document、Reference 和 Provider 诊断发布到 VS Code **Problems**。
- Project/Index 刷新、Provider stderr/结构化生命周期、Lifecycle、Refactor 和事务摘要写入 **Output / VisualBridge**。
- Provider 声明、Trust、日志和故障处理见 [Project Provider V2](../../Doc/ProjectProvider.md)。

## Development

使用仓库固定的 Node.js `22.22.1` 和 npm `10.9.4`。从根目录执行：

```powershell
nvm use 22.22.1
npm ci
npm run check
npm run build
```

构建后在 VS Code 打开仓库根目录并按 `F5` 启动 Extension Development Host。修改 Project File 后可运行 **VisualBridge: Refresh Projects**。

## Automated host and package tests

真实 Extension Host 套件：

```powershell
npm run test:vscode:host
```

Runner 使用官方 `@vscode/test-electron` 和固定 VS Code `1.105.1`，把 `TestData` 复制到唯一临时工作区，并隔离 User Data/Extensions。它验证自动激活、Project 发现、22 个 manifest 命令、默认 Graph 和项目自定义 Entity/Structured/Table 路由、Project Settings、Catalog/Document Browser、Trusted/Restricted Provider、隐藏 Webview 重新握手、定位请求、Lifecycle、Refactor 和 Table 多 panel，不修改跟踪样例或用户 VS Code 配置。失败默认保留临时目录并输出路径；`VISUALBRIDGE_CLEAN_FAILED_TEST=1` 可要求失败后清理。

打包后的 VSIX 单独验证：

```powershell
npm run test:vscode:cli
```

该命令检查精确 `kyl.visualbridge` 身份/版本、Extension entry、全部 manifest JSON Schema、icon、五个 UI JS/CSS bundle（四类文档编辑器与 Project Settings），拒绝测试文件、打包脚本和 source map 泄漏，然后通过固定 VS Code runtime 证明安装包能够从 `workspaceContains` 激活、调用注册命令并打开 Graph Custom Editor。CLI 安装成功不等同于所有交互通过；领域 Operation 和页面行为仍由 Core/Editor/Host 自动化分别验证。
