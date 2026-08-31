# Unity 接入前文档完整性矩阵

## 1. 用途

本矩阵是 VisualBridge Unity 接入前 Authoring 基线的最终审计入口。每一项已实现能力都必须同时具备可追踪设计、必要流程图、使用说明、机器契约和自动验证；空项意味着文档里程碑未完成。路线图和提交说明不能替代本矩阵引用的正式资料。

矩阵只覆盖由 `v0.1.0` 固化的本地 Authoring 基线。当前已实现的 Unity Structured Catalog Exporter、offline Compiler 与最小 Editor Bridge 由 [`UnityIntegrationArchitecture.md`](UnityIntegrationArchitecture.md) 和 [`UnityIntegrationRoadmap.md`](UnityIntegrationRoadmap.md) 独立审计；Runtime、Debug、DAP、Player、WebSocket、Project Discovery File 和独立产品 CLI 仍为未来工作，不以占位 Schema 伪装成已完成能力，其下一大阶段规划见 [`UnityDomainAndRuntimeRoadmap.md`](UnityDomainAndRuntimeRoadmap.md)。

## 2. 完整性矩阵

| 能力 | 正式设计 | 关键流程图 | 使用 / 接入手册 | Schema / Manifest | 自动验证 |
| --- | --- | --- | --- | --- | --- |
| 总体架构与模块边界 | [`VisualBridgeArchitecture.md`](VisualBridgeArchitecture.md) | 总体依赖、Project 路由、编辑事务 | [`GettingStarted.md`](GettingStarted.md)、[`IntegrationGuide.md`](IntegrationGuide.md) | [`Protocol/Schema`](../Protocol/Schema)、[`contract-manifest.json`](../Protocol/contract-manifest.json) | `npm run check:protocol`、`npm run check:docs` |
| Project 发现、Document Type 与任意扩展名 | [`VisualBridgeArchitecture.md`](VisualBridgeArchitecture.md)、[`ProjectCatalogManagement.md`](ProjectCatalogManagement.md) | Project 发现与文件路由 | [`GettingStarted.md`](GettingStarted.md)、[`AuthoringUserGuide.md`](AuthoringUserGuide.md) | [`visualbridge-project.schema.json`](../Protocol/Schema/visualbridge-project.schema.json) | Core Project tests、VS Code Host routing、sample validation |
| Graph V3 / Catalog V4 | [`GraphSemanticModel.md`](GraphSemanticModel.md)、[`VSCodeGraphEditor.md`](VSCodeGraphEditor.md) | UI→Operation→校验→保存 | [`AuthoringUserGuide.md`](AuthoringUserGuide.md) | Graph Document/Catalog Schema、authoring GraphOperation | Graph semantic/editor/Host tests |
| Entity / Component | [`EntityComponentModel.md`](EntityComponentModel.md) | Component 编辑事务 | [`AuthoringUserGuide.md`](AuthoringUserGuide.md) | Entity Document/Catalog Schema、EntityOperation | Entity semantic/editor/Host tests |
| Structured Config | [`StructuredConfigModel.md`](StructuredConfigModel.md) | 字段编辑事务 | [`AuthoringUserGuide.md`](AuthoringUserGuide.md) | Structured Document/Catalog Schema、StructuredOperation | Structured semantic/Host tests |
| CSV/XLSX Table | [`TableSemanticModel.md`](TableSemanticModel.md) | Table 编辑、CSV family / XLSX 保存与回滚 | [`AuthoringUserGuide.md`](AuthoringUserGuide.md) | Table Catalog Schema、TableOperation；物理载体由 codec 约束 | Table semantic、DOM virtualization、XLSX/CSV Host tests |
| 共享 Form Field | [`FormFieldEditor.md`](FormFieldEditor.md) | 递归字段与 List 提交流程 | [`AuthoringUserGuide.md`](AuthoringUserGuide.md) | 各 Catalog 的共享 Field 结构；`Core/Form` 为语义权威 | Entity/Graph/Structured/Table field tests、editor type checks |
| Catalog Registry 与来源状态 | [`ProjectCatalogManagement.md`](ProjectCatalogManagement.md) | Registry 构建、Hash / stale 判断 | [`AuthoringUserGuide.md`](AuthoringUserGuide.md)、[`IntegrationGuide.md`](IntegrationGuide.md) | 四类 Catalog + Catalog Source Schema | Registry、Project Settings、Catalog Browser Host tests |
| Document Browser | [`DocumentBrowser.md`](DocumentBrowser.md) | 索引→搜索/创建/校验/操作 | [`AuthoringUserGuide.md`](AuthoringUserGuide.md) | Project/Document Adapter contract | Core index、VS Code Host tests |
| Document Lifecycle | [`DocumentLifecycle.md`](DocumentLifecycle.md) | preview/apply、复制 remap、安全删除、事务状态 | [`AuthoringUserGuide.md`](AuthoringUserGuide.md)、[`IntegrationGuide.md`](IntegrationGuide.md) | Authoring/MCP lifecycle `$defs` | Core、MCP stdio、VS Code Host lifecycle tests |
| Reference 与精确跳转 | [`ReferenceSystem.md`](ReferenceSystem.md) | Picker→Provider→Resolve→reveal | [`AuthoringUserGuide.md`](AuthoringUserGuide.md) | Authoring Reference/Cursor `$defs` | Core Reference、Provider、MCP、Host reveal tests |
| 稳定 ID 重构 | [`ProjectRefactoring.md`](ProjectRefactoring.md) | preview→锁内重建→commit/conflict | [`AuthoringUserGuide.md`](AuthoringUserGuide.md)、[`IntegrationGuide.md`](IntegrationGuide.md) | Authoring/MCP refactor `$defs` | Core plan、MCP stdio、VS Code Host rollback/refresh tests |
| Project Transaction | [`ProjectTransaction.md`](ProjectTransaction.md) | 锁、发布、prepared/committed 恢复 | [`IntegrationGuide.md`](IntegrationGuide.md) | transaction manifest、Hash / error registry | Node Host transaction/fault-injection tests |
| Project Provider V2 | [`ProjectProvider.md`](ProjectProvider.md) | Trust/allowlist、JSON-RPC、分页、取消与隔离 | [`IntegrationGuide.md`](IntegrationGuide.md) | Project Provider Schema、Provider section in Project Schema | Core/Node Host/MCP/Trusted+Restricted Host tests |
| Project Settings / Catalog Browser | [`ProjectCatalogManagement.md`](ProjectCatalogManagement.md) | settings operation、Catalog source state | [`AuthoringUserGuide.md`](AuthoringUserGuide.md) | Project/Catalog Schemas、VS Code manifest | Project Settings/Catalog Browser Host tests |
| VS Code Host | [`VSCodeHost.md`](VSCodeHost.md) | 激活/路由、ready+epoch、Undo/Redo、Table save | [`GettingStarted.md`](GettingStarted.md)、[`AuthoringUserGuide.md`](AuthoringUserGuide.md) | Extension manifest commands/editors/views/jsonValidation | Unit、Trusted/Restricted Extension Host、packaged VSIX activation |
| MCP V2 | [`VisualBridgeMcp.md`](VisualBridgeMcp.md) | stdio、Adapter、baseHash / preview apply | [`IntegrationGuide.md`](IntegrationGuide.md) | MCP Tool Schema + live `tools/list` | [`stdio.test.mjs`](../Tools/VisualBridgeMcp/test/stdio.test.mjs) 真实 stdio suite、7 tool live contract check |
| 增量索引与大工程性能 | [`WorkspaceIndexPerformance.md`](WorkspaceIndexPerformance.md)、[`LargeProjectValidation.md`](LargeProjectValidation.md) | 增量失效、取消、虚拟化 | [`AuthoringUserGuide.md`](AuthoringUserGuide.md) | Cursor / dependency contracts | LargeCorpus、incremental Host、Table DOM tests |
| 发布、依赖与样例 | [`ReleaseQuality.md`](ReleaseQuality.md) | clean install、CI、VSIX activation | [`GettingStarted.md`](GettingStarted.md)、[样例说明](../Samples/PreUnityAuthoring/README.md) | package manifests、Schema index | dependency audit、sample、build/package/CLI、docs gate |

## 3. 文档自动门槛

`npm run check:docs` 负责把矩阵的可机械验证部分变成发布门槛：

- 检查根 README、扩展 README、样例 README 与全部正式文档的相对链接和 GitHub 风格锚点；
- 确保 [`Doc/README.md`](README.md) 索引全部 `Doc/*.md`，`Doc/Temp` 只保留 `.gitkeep`；
- 实际解析所有 Mermaid fenced block；
- 校验机器标记的 JSON 示例以及固定样例的 JSON Schema 与正式产品 Parser；
- 将文档中的 npm 命令与实际 package scripts 对照；
- 将 VS Code 生产 Command ID、Custom Editor、View、activation 和 JSON validation 与 extension manifest / runtime 对照；
- 将七个 MCP Tool 与正式 Schema、contract manifest 和 live `tools/list` 对照。

完整发布还必须执行 `npm run check`、`npm test`、`npm run build`、`npm run package:vscode`、打包 VSIX 的真实 CLI 激活、依赖审计和 `git diff --check`。文档检查不能替代产品测试，产品测试也不能替代文档检查。

## 4. 维护规则

新增或修改 Authoring 能力时，应在同一提交中更新对应矩阵行、正式设计、流程图、使用说明、Schema / manifest 和自动验证。开发期可以移除不合理协议而不保留兼容层，但完成后不能留下未来式描述或已删除 Command ID。

临时设计与计划只能进入 `Doc/Temp`，任务完成后必须删除。新增正式文档必须加入 [`Doc/README.md`](README.md)，否则 `check:docs` 失败。
