# VisualBridge 架构设计

> 本页是架构文档的索引与总览。完整内容按主题拆分到三份子文档；原有章节标题与锚点保留在文末「原章节锚点索引」，旧链接继续可解析。

VisualBridge 是一个基于 VS Code 的游戏语义内容创作平台，用于承载游戏逻辑、游戏流程、结构化属性、数据引用和运行时调试等不依赖模型与实时渲染的编辑工作，并通过 Unity Bridge 与 Unity Editor 和 Player 协作。

架构基线坚持以下边界：

- 源文件是唯一权威数据；Unity 导入、运行时数组、索引、缓存和调试状态都是派生数据。
- Catalog/Schema 描述能力，Authoring Document 保存项目实际创建的实例。
- 稳定 ID 承载身份，路径、文件名、显示名称和 C# 类型名不承担永久身份。
- VS Code、MCP 与 Unity 侧消费同一套冻结 Schema、稳定 ID 与事务语义。
- 平台机制与业务语义分离；声明式扩展优先，可执行扩展受 Trust 与 allowlist 约束。

## 子文档

- [核心领域模型与事务](VisualBridgeArchitectureCore.md)：产品定位、核心原则、总体架构、Authoring Project、Document System、Catalog 与 Reference System。
- [Authoring、编辑器与扩展机制](VisualBridgeArchitectureAuthoring.md)：编辑器原语、VS Code 基础插件、Extension System 与安全边界。
- [宿主集成与边界决策](VisualBridgeArchitectureIntegration.md)：Unity 集成与 Bridge 边界、AI/MCP、平台仓库结构、开发方案、关键风险与已确定决策。

## 原章节锚点索引

以下标题保留原有 GitHub 锚点，并指向迁移后的完整内容。

### [文档定位](VisualBridgeArchitectureCore.md#文档定位)

### [产品定位](VisualBridgeArchitectureCore.md#产品定位)

### [设计目标](VisualBridgeArchitectureCore.md#设计目标)

#### [核心目标](VisualBridgeArchitectureCore.md#核心目标)

#### [非目标](VisualBridgeArchitectureCore.md#非目标)

### [核心原则](VisualBridgeArchitectureCore.md#核心原则)

#### [源文件是唯一权威数据](VisualBridgeArchitectureCore.md#源文件是唯一权威数据)

#### [描述与实例分离](VisualBridgeArchitectureCore.md#描述与实例分离)

#### [稳定身份与显示信息分离](VisualBridgeArchitectureCore.md#稳定身份与显示信息分离)

#### [平台机制与业务语义分离](VisualBridgeArchitectureCore.md#平台机制与业务语义分离)

#### [声明优先，代码扩展兜底](VisualBridgeArchitectureCore.md#声明优先代码扩展兜底)

#### [AI 与人工使用同一核心](VisualBridgeArchitectureCore.md#ai-与人工使用同一核心)

### [总体架构](VisualBridgeArchitectureCore.md#总体架构)

### [Authoring Project](VisualBridgeArchitectureCore.md#authoring-project)

#### [工程概念](VisualBridgeArchitectureCore.md#工程概念)

#### [当前可运行工程结构](VisualBridgeArchitectureCore.md#当前可运行工程结构)

#### [VisualBridge Project File 职责](VisualBridgeArchitectureCore.md#visualbridge-project-file-职责)

#### [工程发现和索引](VisualBridgeArchitectureCore.md#工程发现和索引)

### [Document System](VisualBridgeArchitectureCore.md#document-system)

#### [Document Type](VisualBridgeArchitectureCore.md#document-type)

#### [Graph Document V3 与 Graph Catalog V4](VisualBridgeArchitectureCore.md#graph-document-v3-与-graph-catalog-v4)

#### [Entity Document V1 与共享字段模型](VisualBridgeArchitectureCore.md#entity-document-v1-与共享字段模型)

#### [Structured Config V1](VisualBridgeArchitectureCore.md#structured-config-v1)

#### [Table 与 Excel](VisualBridgeArchitectureCore.md#table-与-excel)

#### [编辑器原语](VisualBridgeArchitectureAuthoring.md#编辑器原语)

#### [编辑事务](VisualBridgeArchitectureCore.md#编辑事务)

#### [Document Lifecycle V1](VisualBridgeArchitectureCore.md#document-lifecycle-v1)

#### [数据所有权](VisualBridgeArchitectureCore.md#数据所有权)

### [Catalog 与 Reference System](VisualBridgeArchitectureCore.md#catalog-与-reference-system)

#### [Catalog](VisualBridgeArchitectureCore.md#catalog)

#### [Reference Kind](VisualBridgeArchitectureCore.md#reference-kind)

### [VS Code 基础插件](VisualBridgeArchitectureAuthoring.md#vs-code-基础插件)

#### [职责](VisualBridgeArchitectureAuthoring.md#职责)

#### [插件生命周期](VisualBridgeArchitectureAuthoring.md#插件生命周期)

#### [原生 Explorer 与文件编辑器关联](VisualBridgeArchitectureAuthoring.md#原生-explorer-与文件编辑器关联)

#### [Webview 边界](VisualBridgeArchitectureAuthoring.md#webview-边界)

### [Unity 集成与 Bridge 边界](VisualBridgeArchitectureIntegration.md#unity-集成与-bridge-边界)

#### [定位](VisualBridgeArchitectureIntegration.md#定位)

#### [编译边界](VisualBridgeArchitectureIntegration.md#编译边界)

### [Extension System](VisualBridgeArchitectureAuthoring.md#extension-system)

#### [当前扩展层级与未来候选](VisualBridgeArchitectureAuthoring.md#当前扩展层级与未来候选)

#### [声明式扩展](VisualBridgeArchitectureAuthoring.md#声明式扩展)

#### [项目 Provider](VisualBridgeArchitectureAuthoring.md#项目-provider)

#### [Project Provider 运行策略](VisualBridgeArchitectureAuthoring.md#project-provider-运行策略)

#### [自定义 UI](VisualBridgeArchitectureAuthoring.md#自定义-ui)

#### [VS Code 伴生扩展](VisualBridgeArchitectureAuthoring.md#vs-code-伴生扩展)

#### [安全边界](VisualBridgeArchitectureAuthoring.md#安全边界)

### [AI 与 MCP](VisualBridgeArchitectureIntegration.md#ai-与-mcp)

#### [职责选择](VisualBridgeArchitectureIntegration.md#职责选择)

#### [MCP Server 生命周期](VisualBridgeArchitectureIntegration.md#mcp-server-生命周期)

#### [MCP 能力边界](VisualBridgeArchitectureIntegration.md#mcp-能力边界)

### [Unity 连接与 Debug 边界](VisualBridgeArchitectureIntegration.md#unity-连接与-debug-边界)

#### [实例发现与通信：已冻结的答复](VisualBridgeArchitectureIntegration.md#实例发现与通信已冻结的答复)

#### [仍待决项](VisualBridgeArchitectureIntegration.md#仍待决项)

#### [Debug 边界：已冻结的答复](VisualBridgeArchitectureIntegration.md#debug-边界已冻结的答复)

### [平台仓库结构](VisualBridgeArchitectureIntegration.md#平台仓库结构)

### [开发方案](VisualBridgeArchitectureIntegration.md#开发方案)

#### [阶段一：Project 与 Document Core](VisualBridgeArchitectureIntegration.md#阶段一project-与-document-core)

#### [阶段二：VS Code 编辑闭环](VisualBridgeArchitectureIntegration.md#阶段二vs-code-编辑闭环)

#### [阶段三：Catalog、Reference 与项目扩展](VisualBridgeArchitectureIntegration.md#阶段三catalogreference-与项目扩展)

#### [阶段四：Unity Editor 连接](VisualBridgeArchitectureIntegration.md#阶段四unity-editor-连接)

#### [阶段五：Debug 与 MCP](VisualBridgeArchitectureIntegration.md#阶段五debug-与-mcp)

#### [阶段六：更多 Document Type](VisualBridgeArchitectureIntegration.md#阶段六更多-document-type)

#### [阶段七：Player 与生态](VisualBridgeArchitectureIntegration.md#阶段七player-与生态)

### [关键风险](VisualBridgeArchitectureIntegration.md#关键风险)

#### [过度通用化](VisualBridgeArchitectureIntegration.md#过度通用化)

#### [Catalog 漂移](VisualBridgeArchitectureIntegration.md#catalog-漂移)

#### [扩展代码安全](VisualBridgeArchitectureIntegration.md#扩展代码安全)

#### [多客户端并发](VisualBridgeArchitectureIntegration.md#多客户端并发)

#### [Node 版本一致性](VisualBridgeArchitectureIntegration.md#node-版本一致性)

#### [Unity Domain Reload](VisualBridgeArchitectureIntegration.md#unity-domain-reload)

#### [大型工程性能](VisualBridgeArchitectureIntegration.md#大型工程性能)

### [已确定的架构决策](VisualBridgeArchitectureIntegration.md#已确定的架构决策)

### [留待实施阶段确定](VisualBridgeArchitectureIntegration.md#留待实施阶段确定)
