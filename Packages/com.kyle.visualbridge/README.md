# VisualBridge Unity Package

`com.kyle.visualbridge` 是 VisualBridge 的 Unity 集成包。它把 Unity 工程中的普通 C# 类型导出为 Structured Catalog，把 VS Code 编辑后的 Authoring 文档确定性编译回 Unity 派生产物，并提供连接 VS Code 的最小 Editor Bridge。当前版本只覆盖 Structured、offline、Editor-only 切片；Runtime 行为、Debug 与 Player 不在包内。

- 版本：`0.1.0`（私有 `UNLICENSED`，不通过 Unity Asset Store 或任何公共源分发）
- Unity：`6000.3`（验证宿主固定为 `6000.3.10f1`）
- 依赖：`com.unity.nuget.newtonsoft-json` `3.2.2`

## 程序集边界

| 程序集 | 平台 | 职责 |
| --- | --- | --- |
| `VisualBridge.Runtime` | 全平台、noEngineReferences | 纯 metadata marker：`VisualBridgeField`、`VisualBridgeStructuredConfig`、`VisualBridgeStructuredCatalog` attribute 与 `VisualBridgeEditorKind` 枚举，无 Unity API、无行为，可进 Player 构建。 |
| `VisualBridge.Editor` | Editor only | Integration Profile 加载、Catalog Exporter、Structured Compiler、Editor Bridge 客户端与菜单。 |
| `VisualBridge.Editor.Tests` | Editor only | EditMode 测试（exporter/compiler/bridge 共 69 例），引用 `Newtonsoft.Json.dll`。 |

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

编译产物布局在 `Library/VisualBridge/Compiled` 下：`manifest.json`（Structured）/ `manifest.entity.json`（Entity）、`documents/<projectId>/<documentTypeId>/<documentId>.vbcompiled.json`、`mappings/<projectId>/<documentTypeId>/<documentId>.vbsource.json`。失败不会破坏上次有效产物。

### 4. Editor Bridge（open/reveal）

VS Code 侧安装 VisualBridge 扩展并打开关联工作区后，Bridge 服务器自动启动。Unity 侧使用 **Tools / VisualBridge / Editor Bridge / Open in VS Code…**：窗口列出匹配的 VS Code 实例，必须显式选择后 Connect，再发送 Open document / Reveal reference 请求。多个窗口匹配时报 `bridge.windowAmbiguous`，绝不静默挑选。协议为本机 NDJSON（token 认证、generation 代际），Unity 客户端 TCP 优先、命名管道回退；错误码全集共 9 个 `bridge.*`。

## 验证

EditMode 测试位于 `Tests/Editor/`，用 Unity Test Framework 的 EditMode 平台运行。完整验证命令（refresh、Catalog/Compile Generate 与 Check、EditMode、Bridge E2E）见[仓库 README](../../README.md)与[Unity 接入手册](../../Doc/UnityIntegrationManual.md)。

## 边界

- Authoring Document 是唯一权威；Catalog 与编译产物都是派生数据，可随时删除重建。
- Bridge 只发送 open/reveal 请求，不写 Authoring/Catalog、不触发 Export/Compile、不含 Runtime/Debug/Player 消息。
- Runtime 接入按 [`Doc/UnityDomainAndRuntimeRoadmap.md`](../../Doc/UnityDomainAndRuntimeRoadmap.md) 推进，尚未实现；Table 的 XLSX 载体编译同属后续范围。

架构与冻结决策见 [Unity Editor 接入架构](../../Doc/UnityIntegrationArchitecture.md)。
