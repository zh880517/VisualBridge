# VisualBridge Unity Package

`com.kyle.visualbridge` 是 VisualBridge 的 Unity 集成包。它把 Unity 工程中的普通 C# 类型导出为 Structured / Entity / Graph Catalog，把 VS Code 编辑后的 Authoring 文档确定性编译回 Unity 派生产物（Structured / Entity / Table / Graph 四域），并提供两条连接 VS Code 的本机通道：Editor Bridge（open/reveal）与 Play 模式 Runtime Bridge（编译产物快照、产物变更事件、调试租约与 Source 映射、Graph 执行观察）。当前版本仍是离线、Editor-only 的运行切片：Runtime Bridge 由 Editor 侧的 Play 模式宿主拉起，包内不含独立 Player 构建的产物接线、不含远程/设备连接，也不提供断点式 Debug（VS Code 的 `visualbridge-runtime` 调试会话是只读检查适配器）。

- 版本：`0.1.0`（私有 `UNLICENSED`，不通过 Unity Asset Store 或任何公共源分发）
- Unity：`6000.3`（验证宿主固定为 `6000.3.10f1`）
- 依赖：`com.unity.nuget.newtonsoft-json` `3.2.2`

## 程序集边界

| 程序集 | 平台 | 职责 |
| --- | --- | --- |
| `VisualBridge.Runtime` | 全平台、noEngineReferences | 两类职责。Metadata 面（`Runtime/Metadata/`）：Structured 的 `VisualBridgeStructuredCatalog` / `VisualBridgeStructuredConfig` / `VisualBridgeField`，Entity 的 `VisualBridgeEntityCatalog` / `VisualBridgeEntityComponentGroup` / `VisualBridgeEntityType` / `VisualBridgeEntityComponent`，Graph 的 `VisualBridgeGraphCatalog` / `VisualBridgeGraphType` / `VisualBridgeNodeType` / `VisualBridgePort` / `VisualBridgeDynamicPortGroup` / `VisualBridgeGraphDataType` / `VisualBridgeGraphInitialNode` / `VisualBridgeGraphNodeConstraint` attribute，以及 `VisualBridgeEditorKind`、`VisualBridgePortDirection` / `VisualBridgePortKind` / `VisualBridgePortConnectionMode`、`VisualBridgeListPortMode`、`VisualBridgeGraphUsage` 枚举。Runtime Bridge 面（`Runtime/Bridge/`）：`VisualBridgeRuntimeBridgeServer`（回环 NDJSON 服务端：token 握手、快照、单控制者租约、Source 映射、产物目录轮询推送）、`VisualBridgeRuntimeBridgeDiscovery`（发现记录枚举与心跳/pid 陈旧判定）、`VisualBridgeRuntimeBridgeValidator`（严格 wire 校验与消息模型）、`VisualBridgeRuntimeArtifactStore`（编译产物与 Source 映射加载）、`VisualBridgeGraphExecutionCapture`（游戏侧 Graph 执行采集门面）。不引用任何 Unity API（只预编译引用 `Newtonsoft.Json.dll`），可进 Player 构建；Player 侧的产物路径接线仍属后续工作（见「边界」）。 |
| `VisualBridge.Editor` | Editor only | Integration Profile 加载、Structured / Entity / Graph Catalog Exporter、Structured / Entity / Table / Graph Compiler 与各域 Validator、生成的 Schema 契约哈希注册表与消息模型（`Generated/VisualBridgeProtocolContracts.g.cs`）、Editor Bridge 客户端/服务/窗口、Runtime Bridge 的 Play 模式宿主与 E2E batch 入口，以及全部菜单。 |
| `VisualBridge.Editor.Tests` | Editor only | EditMode 测试（`Tests/Editor/`）：三域 Catalog Exporter、四域 Compiler、Editor Bridge 客户端/服务/发现、Runtime Bridge 服务端（握手、并发客户端、租约、产物加载、`artifactsChanged` 推送、发现陈旧判定）与 Graph 执行采集；两条 Bridge 各有与 AJV 生成器共享的 parity fixture（`Tests/Fixtures/`）。引用 `Newtonsoft.Json.dll`。 |

## 使用

### 1. 标注 C# 类型

```csharp
[assembly: VisualBridgeStructuredCatalog("sample.unity.gameplay", "Unity Gameplay Settings")]

[VisualBridgeStructuredConfig("sample.unity.gameplay", "sample.unity.game.settings", "Game Settings")]
public sealed class GameSettings
{
    [VisualBridgeField("maxPlayers", "Max Players", Order = 0,
        DefaultJson = "5", Editor = VisualBridgeEditorKind.Number, Integer = true, Min = 1, Max = 10)]
    public int MaxPlayers;
}
```

Catalog 来源是显式 metadata 的普通 `class` / `struct`；C# 全名只作 `source` 追踪信息，稳定身份是 attribute 中的 `catalogId`/`id`。Exporter 不执行构造函数或任何业务初始化；`ScriptableObject` 不参与扫描。`VisualBridgeField` 支持 `Aliases`、`Description`、`Order`、`DataTypeId`、`DefaultJson`、`Editor`、`ReadOnly`、`Integer`、`Min`/`Max`/`Step`、`ReferenceKind`、`ReferenceTargetJson` 与 `AllowMissingReference`。

### 2. 配置 Integration Profile

`ProjectSettings/VisualBridgeIntegration.json` 声明唯一的 Authoring Project、Catalog export units 与编译输出根（V1 固定 `Library/VisualBridge/Compiled`）。字段与路径约束见[Unity 接入手册](../../Doc/UnityIntegrationManual.md)。

### 3. 导出与编译

菜单：

- **Tools / VisualBridge / Generate Structured Catalogs**
- **Tools / VisualBridge / Generate Entity Catalogs**
- **Tools / VisualBridge / Generate Graph Catalogs**
- **Tools / VisualBridge / Generate Structured Compiled Data**
- **Tools / VisualBridge / Check Structured Compiled Data**
- **Tools / VisualBridge / Generate Entity Compiled Data**
- **Tools / VisualBridge / Check Entity Compiled Data**
- **Tools / VisualBridge / Generate Table Compiled Data**
- **Tools / VisualBridge / Check Table Compiled Data**
- **Tools / VisualBridge / Generate Graph Compiled Data**
- **Tools / VisualBridge / Check Graph Compiled Data**

batchmode 入口（退出码统一 `0` 成功、`1` 失败、`2` Check 发现 drift）：

- `VisualBridge.Editor.VisualBridgeStructuredCatalogBatch.Generate` / `.Check`
- `VisualBridge.Editor.VisualBridgeEntityCatalogBatch.Generate` / `.Check`
- `VisualBridge.Editor.VisualBridgeGraphCatalogBatch.Generate` / `.Check`
- `VisualBridge.Editor.VisualBridgeStructuredCompilerBatch.Generate` / `.Check`
- `VisualBridge.Editor.VisualBridgeEntityCompilerBatch.Generate` / `.Check`
- `VisualBridge.Editor.VisualBridgeTableCompilerBatch.Generate` / `.Check`
- `VisualBridge.Editor.VisualBridgeGraphCompilerBatch.Generate` / `.Check`

Profile 的 `catalogExports[].output` 扩展名决定路由：`.vbstructuredcatalog` 走 Structured Exporter，`.vbentitycatalog` 走 Entity Exporter，`.vbgraphcatalog` 走 Graph Exporter（Graph Catalog V4：Graph/Node Type、端口、连接规则、typed subgraph 与实例约束由 `VisualBridgeGraphType`/`NodeType`/`Port`/`DynamicPortGroup` 等 attribute 声明）。Entity 侧 metadata 为 assembly 级 `VisualBridgeEntityCatalog` / `VisualBridgeEntityComponentGroup` 与类型级 `VisualBridgeEntityType` / `VisualBridgeEntityComponent`（字段沿用 `VisualBridgeField`），导出 Component Group、Entity Type 与 Component Type；`.vbentity` 文档由 Entity Compiler 编译为同布局产物（独立 `manifest.entity.json`），文档校验为纯 JSON 级对照 Catalog 定义并物化默认值。Table 为纯消费方：`.vbtablecatalog` 由 VS Code 侧创作提交，CSV family 文档由 Table Compiler 按权威语义（nameKey 映射、cell encoding、分区有效行）编译（独立 `manifest.table.json`；XLSX 不在 V1 支持范围）。Graph 实例文档由 Graph Compiler 编译（fail-closed 复刻全部 error 级文档校验、别名 canonical 化、默认值物化；独立 `manifest.graph.json`）。

编译产物布局在 `Library/VisualBridge/Compiled` 下：四域 manifest（`manifest.json` Structured / `manifest.entity.json` Entity / `manifest.table.json` Table / `manifest.graph.json` Graph）、`documents/<projectId>/<documentTypeId>/<documentId>.vbcompiled.json`、`mappings/<projectId>/<documentTypeId>/<documentId>.vbsource.json`（Table 域以 `tableTypeId` 充当文档身份）。失败不会破坏上次有效产物。

### 4. Editor Bridge（open/reveal）

VS Code 侧安装 VisualBridge 扩展并打开关联工作区后，Bridge 服务器自动启动。Unity 侧使用 **Tools / VisualBridge / Editor Bridge / Open in VS Code…**：窗口列出匹配的 VS Code 实例，必须显式选择后 Connect，再发送 Open document / Reveal reference 请求。多个窗口匹配时报 `bridge.windowAmbiguous`，绝不静默挑选。**Tools / VisualBridge / Editor Bridge / Open Sample Document in VS Code** 是手工自检入口，对开发宿主样例的固定路径 `Config/Game.gamesettings` 发一次 open 请求并把结果写进 Console；自动化 E2E 走 `npm run test:bridge-e2e`（内部调用 `VisualBridge.Editor.VisualBridgeBridgeBatch.RunE2E`，由环境变量配置目标文档与结果文件）。协议为本机 NDJSON（token 认证、generation 代际），Unity 客户端 TCP 优先、命名管道回退；wire 错误码共 9 个 `bridge.*`（`Protocol/Schema/visualbridge-editor-bridge.schema.json` 的 `errorCode` 枚举，由 Unity 侧 Validator 镜像校验），`bridge.windowAmbiguous` 这类 Unity 本地抛出码不在该枚举内。

### 5. Runtime Bridge（Play 模式）

Runtime Bridge 服务器由 `VisualBridge.Editor` 的 Play 模式宿主在进入 Play 时自动拉起（`instanceId` 为 `editor-<pid>`、`kind` 为 `editor-play`）；退出 Play 时回收线程并删除发现记录，mid-play domain reload 后由 `[InitializeOnLoad]` 兜底重拉（generation 递增，尽量重绑旧端口）。前置条件：

- Unity Editor 处于 Play 模式；编译产物只决定快照内容、不决定能否启动：`Library/VisualBridge/Compiled` 目录或某个 manifest 缺失时服务器照常启动，`getSnapshot` 返回空列表；
- 只监听本机回环 `127.0.0.1`，NDJSON 行分帧、token 走首条消息握手；发现记录写在 `<系统临时目录>/visualbridge-runtime/<instanceId>.json`，心跳每秒 touch 文件 mtime；
- VS Code 侧由扩展的 `RuntimeBridgeService` 枚举发现记录，连接目标由调用方显式指定 `instanceId`（无「全局当前实例」、不弹实例选择 UI；Graph 执行调试页在需要时自动连接首个非陈旧实例）；陈旧记录（心跳超过 5 秒或发布进程已死）绝不连接。

菜单：**Tools / VisualBridge / Runtime Bridge / Start in Play Mode**（不在 Play 模式时只弹提示，要求改点 Play 按钮）与 **Tools / VisualBridge / Runtime Bridge / Status**（打印 instanceId、kind、port、generation、记录路径与产物根）。**Tools / VisualBridge / Runtime Bridge / Run Play Mode E2E (batch)** 是 batchmode `-executeMethod` 入口，在编辑器里手工点击只输出一条告警。

服务端通告能力 `snapshot`、`events`、`lease`、`sources`，请求动作为 `getSnapshot`、`acquireLease`、`releaseLease`、`getDocumentSources`。`getSnapshot` 是观察者语义、不占租约；`getDocumentSources` 需持有单控制者调试租约（租约绑定连接、连接断开自动释放、他人持有时返回 `runtime.leaseDenied`）。游戏侧 Graph 执行引擎经 `VisualBridgeGraphExecutionCapture` 门面上报执行实例起止与节点/边事件；采集门面只把它们回调给注入的观察者（调试发射端），Graph 执行调试不再走 Runtime Bridge 的订阅通道。

端到端验证：`npm run test:runtime-e2e`（batchmode Play 模式 + 隔离 VS Code Extension Host，覆盖发现/快照/事件全链路）。

## 验证

EditMode 测试位于 `Tests/Editor/`，用 Unity Test Framework 的 EditMode 平台运行。完整验证命令（refresh、三域 Catalog 与四域 Compile 的 Generate/Check、EditMode、Editor Bridge 与 Runtime Bridge E2E）见[仓库 README](../../README.md)与[Unity 接入手册](../../Doc/UnityIntegrationManual.md)。

## 边界

- Authoring Document 是唯一权威；Catalog 与编译产物都是派生数据，可随时删除重建。
- Editor Bridge 只发送 open/reveal 请求，不写 Authoring/Catalog、不触发 Export/Compile、不含 Runtime/Debug/Player 消息；Runtime 快照、调试租约、Source 映射与 Graph 执行观察走包内另一条独立通道（Runtime Bridge，`runtime.*` 错误码、独立版本化）。
- 仍未完成的工作：独立 Player 构建的产物接线（`StreamingAssets/VisualBridge/Compiled` 路径解析，见 [`Doc/Backlog.md`](../../Doc/Backlog.md)）、阶段 C 远程与设备连接（项目方 2026-08-31 决策推迟）、WebSocket 传输、独立产品 CLI、Table 的 XLSX 载体编译，以及断点/调用栈式 Debug（协议里没有以占位 Schema 伪装的断点消息）。逐项状态、范围边界与验收标准见 [`Doc/Backlog.md`](../../Doc/Backlog.md)；历史进度与冻结决策见[已归档的 Unity 领域与 Runtime 任务清单](../../Doc/Archive/UnityDomainAndRuntimeRoadmap.md)。

架构与冻结决策见 [Unity Editor 接入架构（索引）](../../Doc/UnityIntegrationArchitecture.md) 及其 [C# 契约](../../Doc/UnityIntegrationArchitectureContracts.md)、[Editor Bridge](../../Doc/UnityIntegrationArchitectureEditorBridge.md)、[Runtime Bridge](../../Doc/UnityIntegrationArchitectureRuntime.md) 子文档。
