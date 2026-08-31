# VisualBridge Unity 接入手册

## 1. 文档定位

本手册面向在 Unity 工程中使用 VisualBridge 的开发者，覆盖环境要求、Integration Profile 配置、Structured Catalog Export、Structured Compile、日志、冲突恢复与 Editor Bridge 使用。设计与冻结决策以 [Unity Editor 接入架构](UnityIntegrationArchitecture.md)为准；任务顺序与验证门槛见 [Unity Editor 接入任务清单](UnityIntegrationRoadmap.md)。当前已落地范围为 Structured、offline、Editor-only 切片与最小 Editor Bridge。

## 2. 系统要求与兼容矩阵

| 组件 | 固定版本 | 说明 |
| --- | --- | --- |
| Node.js | `22.22.1` | 由 `.nvmrc`、`engines.node` 与 `packageManager` 声明；`.npmrc` 开启 `engine-strict`。 |
| npm | `10.9.4` | 与 Node 版本一起锁定。 |
| VS Code | `1.105.1` | 扩展 `engines.vscode` 与测试宿主 `@vscode/test-electron` 固定。 |
| VisualBridge VSIX | `0.1.0` | 身份 `kyl.visualbridge`，私有 `UNLICENSED`，不经 Marketplace 分发。 |
| Unity Editor | `6000.3.10f1` | 由 `UnityProject/ProjectSettings/ProjectVersion.txt` 固定；Package 声明 `unity: 6000.3`。 |
| `com.kyle.visualbridge` | `0.1.0` | Unity 集成包；依赖 `com.unity.nuget.newtonsoft-json` `3.2.2`。 |
| Protocol 契约 | `manifestVersion 1` | `protocolContracts 1`、`graphDocument 3`、`graphCatalog 4`、`entityDocument/Catalog 1`、`structuredDocument/Catalog 1`、`tableCatalog 1`、`unityIntegrationProfile 1`、`editorBridge 1`、`documentLifecyclePlan 1`。 |
| Editor Bridge 协议 | `protocolVersion 1` | 能力集固定 `open` / `reveal`；Schema 为 `visualbridge-editor-bridge.schema.json`。 |
| Structured Compiler | V1 | 输出根固定 `Library/VisualBridge/Compiled`，内部 Editor 格式。 |

升级约束：改变 Node、VS Code、Unity Editor 或 Newtonsoft 版本，或声明更低最低版本前，必须重新执行[完整验证门槛](#10-验证门槛命令)；Protocol 版本变更属于公开契约变更，须先更新 Schema/manifest 并重新生成 TypeScript/C# 契约。C# 契约只从 Schema 生成，Unity 侧消费生成产物，不引用 TypeScript Core。

## 3. 安装

1. 构建并安装 VSIX（隔离验证后安装到当前配置）：

```powershell
nvm use 22.22.1
npm ci
npm run package:vscode
npm run test:vscode:cli
code --install-extension .\Tools\VSCodeExtension\artifacts\visualbridge.vsix --force
```

2. Unity 侧：本仓库开发宿主即 `UnityProject/`，Package Manager 直接解析本地 `Packages/com.kyle.visualbridge`。第三方工程以嵌入方式安装（复制整个 `Packages/com.kyle.visualbridge` 目录），并按第 4 节配置 Profile。
3. 打开 VS Code 时使用包含 Authoring Project（`VisualBridge.project.vbjson`）的工作区；样例见 [Pre-Unity Authoring 样例](../Samples/PreUnityAuthoring/README.md)。

## 4. Integration Profile 配置

Profile 固定为 `ProjectSettings/VisualBridgeIntegration.json`，V1 结构如下（示例为开发宿主实际配置）：

```text
{
  "formatVersion": 1,
  "authoringProject": "VisualBridgeAuthoring/VisualBridge.project.vbjson",
  "catalogExports": [
    {
      "catalogId": "sample.unity.gameplay",
      "title": "Unity Gameplay Settings",
      "output": "VisualBridgeAuthoring/Catalog/Gameplay.vbstructuredcatalog",
      "types": ["VisualBridge.Sample.GameSettings, Assembly-CSharp"]
    }
  ],
  "compileOutputRoot": "Library/VisualBridge/Compiled"
}
```

约束与对应错误码：

- `formatVersion` 必须为 `1`（`profile.unsupportedVersion`）。
- V1 只关联一个 Unity Project 内的 Authoring Project；路径从 Unity Project root 解析，拒绝绝对路径、冒号、反斜杠、空/`.`/`..` segment 与盘符别名（`profile.invalidPath`），解析后离开 project root 报 `profile.pathOutsideProject`，祖先段 symlink/reparse-point 报 `profile.symlinkForbidden`。
- `catalogExports[].output` 必须以 `.vbstructuredcatalog` 或 `.vbentitycatalog` 结尾，扩展名决定导出路由（Structured / Entity Exporter）；catalogId、输出路径与物理同一文件均不得重复（`profile.duplicateCatalogId` / `profile.duplicateOutput` / `profile.duplicatePhysicalOutput`）。
- `compileOutputRoot` 在 Compiler V1 必须恰为 `Library/VisualBridge/Compiled`（`compile.outputRootMismatch`）。
- JSON 必须严格 UTF-8，不允许注释、尾随内容或重复键（`profile.invalidJson`）。

修改 Profile 后无需额外注册：Export/Compile 每次从 Profile 显式解析，不使用进程级缓存或全局状态。

## 5. Structured Catalog Export

C# 类型通过 `VisualBridge.Runtime` 的 attribute 显式标注（`VisualBridgeStructuredCatalog`、`VisualBridgeStructuredConfig`、`VisualBridgeField`，完整字段见 [Package README](../Packages/com.kyle.visualbridge/README.md)）。导出入口：

- 菜单：**Tools / VisualBridge / Generate Structured Catalogs**
- batchmode：`VisualBridge.Editor.VisualBridgeStructuredCatalogBatch.Generate` / `.Check`

语义：

- **Generate** 从当前程序集快照确定性重写 Catalog 文件（`.vbstructuredcatalog`），并提交 `sourceHash`；不执行配置类型构造函数。
- **Check** 只读对比，内容漂移时退出码 `2`；执行失败 `1`；一致 `0`。菜单与 batch 复用同一 Exporter 服务。
- 常见错误：`catalog.typeNotFound`（Profile 引用的类型不存在）、`catalog.identityConflict`（稳定 ID 冲突）、`catalog.invalidDefault` / `catalog.invalidReference`（metadata 声明不一致）、`catalog.staticFieldUnsupported`、`catalog.polymorphismUnsupported`。

Catalog 提交进版本库后由 VS Code 侧作为来源消费；Exporter 是 Catalog 的唯一生成方，禁止手工编辑。

## 5.1 Entity Catalog Export

Entity 领域的 Catalog 导出与 Structured 共用 Profile 与验证门槛，按输出扩展名路由到 `VisualBridgeEntityCatalogExporter`：

- metadata：assembly 级 `VisualBridgeEntityCatalog(catalogId, title)` 与 `VisualBridgeEntityComponentGroup(catalogId, id, title)`；类型级 `VisualBridgeEntityType(catalogId, id, title, AllowedComponentGroupIds)` 与 `VisualBridgeEntityComponent(catalogId, id, title, groupId, MenuPath)`；字段沿用共享的 `VisualBridgeField`。
- 入口：菜单 **Tools / VisualBridge / Generate Entity Catalogs**；batchmode `VisualBridge.Editor.VisualBridgeEntityCatalogBatch.Generate` / `.Check`（退出码 `0`/`1`/`2` 同 Structured）。
- 语义：Generate 确定性输出 `{componentGroups, entityTypes, componentTypes}` 的 Entity Catalog V1（`.vbentitycatalog`）；三类身份（id+aliases）单 catalog 内唯一、跨 catalog 全局唯一；`groupId` 与 `allowedComponentGroupIds` 必须引用同 catalog 声明的组；entity catalog 输出必须被 Authoring Project 中 `editor == "entity"` 的 DocumentType 声明（`profile.catalogNotDeclared`）。

## 5.2 Entity Compile

`.vbentity` 文档由 `VisualBridgeEntityCompiler` 编译到同一输出根：

- 入口：菜单 **Tools / VisualBridge / Generate Entity Compiled Data**、**Check Entity Compiled Data**；batchmode `VisualBridge.Editor.VisualBridgeEntityCompilerBatch.Generate` / `.Check`（退出码 `0`/`1`/`2`）。
- 前置：Entity Catalog Check 必须无 drift（`compile.catalogDrift`），否则先重跑 Catalog Generate 并提交。
- 语义：文档按 entity DocumentType 唯一路由；`entityTypeId`/`componentTypeId` 必须在声明的 Catalog 中唯一解析，组件组必须在 entityType 的 `allowedComponentGroupIds` 白名单内（空白名单即全不允许）；缺失字段以 Catalog 默认值物化进产物；产物布局与 Structured 相同（`documents/`、`mappings/`），但使用独立的 `manifest.entity.json`，两套编译互不接管对方托管集。失败不破坏上次有效产物；stale 产物在 Generate 时清理、Check 时计为 drift。

## 5.2 Graph Catalog Export

Graph 领域的 Catalog 导出按 `.vbgraphcatalog` 扩展名路由到 `VisualBridgeGraphCatalogExporter`，输出 Graph Catalog V4（不接受旧版本）：

- metadata：assembly 级 `VisualBridgeGraphCatalog(catalogId, title)` 与 `VisualBridgeGraphDataType(id, title)`（可选 Color/Accepts）；类型级 `VisualBridgeGraphType`（Usage/SupportedCatalogIds/PortConnectionInput/Output/AllowedNodeTypeIds/Tags/Traits/AllowSubgraphs/AllowedSubgraphTypeIds）、`VisualBridgeNodeType`（category/MenuPath/Tags/Traits/SubgraphGraphTypeIds）与 graphType 类上的 `VisualBridgeGraphNodeConstraint`/`VisualBridgeGraphInitialNode`；字段级 `VisualBridgePort`（flow/data 端口，data 端口 DataTypeId 由 CLR 类型推导）与 `VisualBridgeDynamicPortGroup`（List<T> 动态端口组，list/element 模式）。
- 入口：菜单 **Tools / VisualBridge / Generate Graph Catalogs**；batchmode `VisualBridge.Editor.VisualBridgeGraphCatalogBatch.Generate` / `.Check`。
- 语义：graphType/nodeType/dataType 身份全局无歧义；C# 全名只进 `source.typeName`；typed subgraph 节点禁止 flow 端口；端口与字段分离（同字段双声明报错）；三方 parity fixture（AJV / Unity 校验器 / 扩展宿主）锁定契约。

## 5.3 Table Compile（CSV family）

Table 是纯消费方：Unity 侧没有 Table Exporter，catalog（`.vbtablecatalog`）由 VS Code 侧创作并提交；Unity 只编译 CSV family 文档（`.xlsx` 以 `table.xlsxUnsupported` 拒绝——OOXML 解析不在 V1 依赖边界内）：

- 入口：菜单 **Tools / VisualBridge / Generate Table Compiled Data**、**Check Table Compiled Data**；batchmode `VisualBridge.Editor.VisualBridgeTableCompilerBatch.Generate` / `.Check`（退出码 `0`/`1`/`2`）。
- 前置：Project File 需声明 `tableLayout {nameKeyRow, dataStartRow}`（缺失报 `compile.tableLayoutMissing`）；table documentType 的 id 必须在其声明 catalog 中唯一解析到 tableType。
- 语义：nameKey 列映射、cell encoding（scalar/json/delimited）、key column 与 rowId（`{sheetDefinitionId}:{物理名}:key-{值}`）、跨分区有效行去重（error/keepFirst/keepLast）全部复刻 VS Code 权威语义；产物按 documentType 聚合为 `documents/{projectId}/{documentTypeId}/{tableTypeId}.vbcompiled.json` + mapping + `manifest.table.json`。
- 注意：Project File 任何变更都会改变 `projectSha256`，三个编译器（Structured/Entity/Table）都会按输入 Hash 报 drift，需统一重新 Generate。

## 5.4 Graph Compile

`.vbflow` 等 graph 文档由 `VisualBridgeGraphCompiler` 编译：

- 入口：菜单 **Tools / VisualBridge / Generate Graph Compiled Data**、**Check Graph Compiled Data**；batchmode `VisualBridge.Editor.VisualBridgeGraphCompilerBatch.Generate` / `.Check`（退出码 `0`/`1`/`2`）。
- 前置：Graph Catalog Check 无 drift（`compile.catalogDrift`）。
- 语义：文档按 graph DocumentType 唯一路由（不要求 documentType.id 对应 graphType——root 图的 `graphTypeId` 自行解析校验）；VS Code 侧的全部 error 级文档校验在编译器为 fail-closed（身份唯一、边方向/kind/dataType/连接上限、节点允许性、subgraph 白名单与调用类型匹配、实例约束、动态端口、接口端口），warning 级类型别名静默 canonical 化进产物；缺失节点/图属性物化 Catalog 默认值（mapping 记 `origin: metadataDefault`）。
- 产物：`documents/{projectId}/{documentTypeId}/{documentId}.vbcompiled.json`（保留节点 position 与 subgraphId，节点/边按 id 排序）+ mapping + `manifest.graph.json`，与其他三域 manifest 共存。

## 5.5 Runtime Bridge（Play 模式状态/事件）

进入 Play 模式后，`VisualBridge.Runtime` 的 Runtime Bridge 服务器自动启动（发现层遵循架构文档第 17 章）：

- 发现：`<临时目录>/visualbridge-runtime/<instanceId>.json`（instanceId 为 `editor-<pid>`，心跳每秒 touch mtime；陈旧判定 = 心跳 >5 秒或 pid 死）。VS Code 侧 `RuntimeBridgeService` 枚举并显式选择实例。
- 协议：NDJSON 行分帧、token 首条消息认证、`coreVersion 1` 共享核（与 Editor Bridge 同构但独立版本化）；消息集 hello/welcome/getSnapshot 响应/artifactsChanged 事件/连接级 error（`runtime.*`）。
- 能力：`snapshot`（读取 `Library/VisualBridge/Compiled` 编译产物，可按 documentTypeIds 过滤）、`events`（产物目录变化推送）、`lease`/`sources`（调试语义：单控制者租约 + 文档级 Source 映射，见下）。Player 构建回退 `StreamingAssets/VisualBridge/Compiled`（接线属后续任务）。
- 调试语义（VB-UX-10）：`acquireLease`/`releaseLease` 管理单控制者租约（绑定连接、断开自动释放、他人持有时 `runtime.leaseDenied`）；`getDocumentSources`（需持租约）返回每个运行中文档的 Authoring 源路径与 SHA-256（structured/entity/graph 取产物 `inputs.document`，table 取其 sourceMapping 的 `sources[]`）；VS Code 侧对照工作区当前文档字节检测漂移——漂移必须显式呈现，防止把新 Authoring 身份映射到旧 Runtime 数据。断点/调用栈消息按「不以占位 Schema 伪装成已完成能力」原则未进入协议，待真实执行运行时出现再冻结。
- 菜单：**Tools / VisualBridge/Runtime Bridge/Start in Play Mode**、**Status**。E2E：`npm run test:runtime-e2e`（batchmode Play + 隔离 Extension Host，覆盖发现/快照/事件全链路）。
- DAP 检查会话：VS Code 调试 UI 以 `visualbridge-runtime` 类型 attach 到 Runtime 实例（attach 时持调试租约），变量树展示运行时快照与 `__sourcePath`/`__sourceDrifted`；断点不受支持（只检查会话，见架构文档 §18.3/18.5）。
- MCP 检查工具：stdio MCP Server 暴露只读的 `visualbridge_runtime` 工具（`listInstances` / `getSnapshot` / `getDocumentSources`），漂移由 MCP 侧对照工作区 Authoring 字节计算；每次调用独立连接、断开即释放租约，与 DAP 检查会话并存（并发时后来者得到 `runtime.leaseDenied`）。

## 6. Structured Compile

输入是 Authoring Project（Project File + Structured 文档）+ 已提交 Catalog + Integration Profile。入口：

- 菜单：**Tools / VisualBridge / Generate Structured Compiled Data**、**Check Structured Compiled Data**
- batchmode：`VisualBridge.Editor.VisualBridgeStructuredCompilerBatch.Generate` / `.Check`（退出码 `0`/`1`/`2` 同上，Check 把陈旧输出也计为 drift）

输出布局（`Library/VisualBridge/Compiled`，内部 Editor 格式、可随时删除重建）：

```text
manifest.json
documents/<projectId>/<documentTypeId>/<documentId>.vbcompiled.json
mappings/<projectId>/<documentTypeId>/<documentId>.vbsource.json
```

行为与恢复语义：

- 编译按 Document Type 唯一路由；产物、mapping 与 manifest 以原子方式提交，失败不破坏上次有效产物，残留备份保留在目标旁供人工恢复。
- `compile.catalogDrift` 表示 Catalog 与程序集快照不一致，先重跑 Catalog Generate；`compile.inputChanged` 表示编译期间输入变化，直接重跑即可；`compile.outputCollision` / `compile.documentOutsideRoot` 属于配置错误，检查 Profile 与 Project File。
- Compiler 不修改 Authoring Project/File/Document；所有写操作只发生在编译输出根内。

## 7. Editor Bridge 使用（open/reveal）

前置条件：VS Code 打开包含 Authoring Project 的工作区并安装 VSIX；扩展激活后 Bridge 服务器自动启动（本机双端点：命名管道 + 回环 TCP，每秒心跳写发现记录）。

Unity 侧操作：

1. 菜单 **Tools / VisualBridge / Editor Bridge / Open in VS Code…** 打开 Bridge 窗口。
2. **Refresh** 枚举发现记录：心跳超过 5 秒或进程已死的窗口被跳过并显示原因。
3. 在列表中**显式选择**一个窗口并 **Connect**（完成 token 握手与 generation 校验）。多个窗口匹配时报 `bridge.windowAmbiguous`，绝不按最近连接猜测。
4. 输入文档相对路径发送 **Open document**，或输入 Reference 值发送 **Reveal reference**；响应与日志显示在窗口内。

重试与错误：`OpenDocumentWithRetry` / `RevealReferenceWithRetry` 内置重新发现与重连退避（1 秒起、指数翻倍、上限 30 秒），适用于 VS Code 窗口仍在启动的场景。典型错误码：`bridge.invalidToken`（token 不符，重新发现）、`bridge.staleGeneration`（服务端重启过，重新 Connect）、`bridge.documentUnresolved` / `bridge.documentAmbiguous`（路径或引用无唯一解析）、`bridge.protocolVersionMismatch` / `bridge.capabilityMissing`（版本或能力不匹配，升级对端）。

边界：Bridge 只发送 open/reveal 请求；不写 Authoring/Catalog、不触发 Export/Compile，也不包含任何 Runtime、Debug 或 Player 消息。端到端验证命令为 `npm run test:bridge-e2e`（同时拉起真实 Unity Editor 与隔离 Extension Host）。

## 8. 日志与诊断

- Unity 菜单操作：输出进入 Editor.log（`%LOCALAPPDATA%\Unity\Editor\Editor.log`）；Bridge 窗口内另有独立日志面板。
- batchmode：必须显式 `-logFile`；退出码之外要检查日志中的编译/导入结果与未处理异常。
- EditMode 测试：`-testResults` 写出的 XML 需审计，不只看退出码。
- VS Code 侧：Project 刷新、事务与 Bridge 相关日志写入 **Output / VisualBridge**。

## 9. 冲突恢复

| 场景 | 现象 | 恢复 |
| --- | --- | --- |
| 编译失败 | 退出码 `1`，日志含 `compile.*` | 上次有效产物未被破坏；修复原因后重跑 Generate。 |
| Catalog drift | Catalog Check 退出码 `2` | C# metadata 已变更，重跑 Catalog Generate 并提交新 Catalog。 |
| Authoring 文档外部修改 | VS Code 编辑器提示外部修改冲突 | 按 [Authoring 使用手册](AuthoringUserGuide.md)的冲突恢复流程处理；Unity 侧下次编译自动读取新内容。 |
| Bridge 记录陈旧 | 窗口列表为空或报 stale | VS Code 窗口仍在则等待下一次心跳；已关闭则重新打开工作区。 |
| 编译产物损坏 | 任意 `compile.*` | 删除 `Library/VisualBridge/Compiled` 整目录后重跑 Generate（产物为纯派生数据）。 |

## 10. 验证门槛命令

```powershell
$unityEditor = 'C:\Program Files\Unity 6000.3.10f1\Editor\Unity.exe'
$unityProject = (Resolve-Path .\UnityProject).Path

& $unityEditor -batchmode -nographics -quit -projectPath $unityProject -logFile "$env:TEMP\visualbridge-refresh.log"
& $unityEditor -batchmode -nographics -quit -projectPath $unityProject -executeMethod VisualBridge.Editor.VisualBridgeStructuredCatalogBatch.Generate -logFile "$env:TEMP\visualbridge-catalog-generate.log"
& $unityEditor -batchmode -nographics -quit -projectPath $unityProject -executeMethod VisualBridge.Editor.VisualBridgeStructuredCatalogBatch.Check -logFile "$env:TEMP\visualbridge-catalog-check.log"
& $unityEditor -batchmode -nographics -quit -projectPath $unityProject -executeMethod VisualBridge.Editor.VisualBridgeStructuredCompilerBatch.Generate -logFile "$env:TEMP\visualbridge-compile-generate.log"
& $unityEditor -batchmode -nographics -quit -projectPath $unityProject -executeMethod VisualBridge.Editor.VisualBridgeStructuredCompilerBatch.Check -logFile "$env:TEMP\visualbridge-compile-check.log"
& $unityEditor -batchmode -nographics -runTests -testPlatform EditMode -projectPath $unityProject -testResults "$env:TEMP\visualbridge-editmode.xml" -logFile "$env:TEMP\visualbridge-editmode.log"
```

Node 侧配套门槛：`npm run check`、`npm test`、`npm run build`、`npm run package:vscode`、`npm run test:vscode:host`、`npm run test:vscode:cli`、`npm run check:docs`、`npm run test:bridge-e2e`，以及 `dotnet build .\UnityProject\Assembly-CSharp-Editor.csproj` 快速编译检查。完整矩阵与发布边界见 [Release Quality](ReleaseQuality.md)。

## 11. 已知限制

- Unity 侧仅 Structured 领域；Graph/Entity/Table 的 Export/Compile 与 Runtime/Debug/Player 接入按 [Unity 领域扩展与 Runtime 接入任务清单](UnityDomainAndRuntimeRoadmap.md)推进。
- Bridge 为 V1 最小范围（open/reveal），多窗口必须显式选择。
- `VisualBridge.Runtime` 只是 metadata marker，不提供运行时加载能力。
- 本仓库验证环境若使用非声明 Node 版本（如 25.x），`npm ci` 会因 `engine-strict` 失败；正式 CI 必须使用 22.22.1。
