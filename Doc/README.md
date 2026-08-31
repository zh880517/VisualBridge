# VisualBridge 文档目录

`Doc` 保存已经确定并落地的正式设计、用户手册、接入运维说明和发布契约。新使用者从 [根 README](../README.md) 与 [安装和快速开始](GettingStarted.md) 进入；路线图、提交说明和 `Doc/Temp` 临时记录不能替代正式资料。

## 安装、使用与接入

- [安装与快速开始](GettingStarted.md)：固定工具链、VSIX 构建、隔离安装验证、样例、Project 发现、激活和任意扩展名路由。
- [Authoring 使用手册](AuthoringUserGuide.md)：Graph、Entity、Structured、Table、Document Browser、Lifecycle、Reference/Refactor、Project Settings、Catalog Browser、冲突恢复和 Restricted Mode。
- [项目接入与运维手册](IntegrationGuide.md)：Catalog、Document Type、任意扩展名、Provider、MCP、锁与 Hash、日志、授权和故障恢复。
- [VS Code Extension README](../Tools/VSCodeExtension/README.md)：22 个生产 Command ID、4 个 Custom Editor viewType、2 个 View ID、安装和 Host 自动化。
- [Unity 接入手册](UnityIntegrationManual.md)：环境与兼容矩阵、Integration Profile 配置、Catalog Export、Structured Compile、日志、冲突恢复和 Editor Bridge 使用。
- [Unity Package README](../Packages/com.kyle.visualbridge/README.md)：`com.kyle.visualbridge` 的程序集边界、metadata 标注、菜单/batch 入口和边界说明。
- [Pre-Unity Authoring Sample](../Samples/PreUnityAuthoring/README.md)：四类 Authoring 文档、四类 Catalog 和可选 Provider V2 的维护样例。

## 总体架构与共享平台

- [VisualBridge 架构设计](VisualBridgeArchitecture.md)：平台定位、模块边界、数据所有权、Authoring/Unity 分工和长期演进边界。
- [Unity Editor 接入架构](UnityIntegrationArchitecture.md)：已落地的 Structured offline Editor-only 切片、C# wire/data bags、UPM Package、固定 Profile、Catalog Export、派生编译、信任边界和后续最小 Editor Bridge。
- [VS Code Host](VSCodeHost.md)：激活、Project Registry、Custom Editor 路由、Webview epoch、保存/冲突、诊断和 Trust。
- [Form Field Editor](FormFieldEditor.md)：跨 Graph、Entity、Structured、Table 的共享字段语义、React 控件、Reference Bridge 和提交边界。
- [Project Settings 与 Catalog Browser](ProjectCatalogManagement.md)：Project File、文件归属、Project Operation、Catalog 来源 Hash/过期状态和只读 Browser。
- [Document Browser V1](DocumentBrowser.md)：统一语义树、搜索、创建、全量校验、物理来源、引用和错误入口。
- [Workspace Index 与大工程编辑性能](WorkspaceIndexPerformance.md)：不可变增量快照、刷新取消、Reference/Provider 缓存、稳定分页和 Table 虚拟化。

## 领域文档与编辑器

- [Graph Semantic Model](GraphSemanticModel.md)：Graph V3 的稳定身份、Graph Type、连接、typed subgraph、Catalog 和安全替换。
- [VS Code Graph Editor](VSCodeGraphEditor.md)：当前 Graph V3 Webview、画布交互、字段、Clipboard、Undo/Redo 和保存行为。
- [Entity / Component 编辑模型](EntityComponentModel.md)：Entity V1、Component、共享字段、项目自定义后缀和 VS Code/MCP 契约。
- [Structured Config V1](StructuredConfigModel.md)：Project 唯一类型绑定、共享字段、确定性 JSON 和 VS Code/MCP 原子编辑。
- [Table Semantic Model V1](TableSemanticModel.md)：Table Catalog、CSV/XLSX Codec、分表、去重、保存、回滚和表格能力限制。
- [ActionEditor FlowGraph 迁移设计](FlowGraphMigration.md)：旧节点声明到 Graph Catalog V4 的功能对照和未来 Unity 导出约束。

## Reference、Lifecycle 与事务

- [Reference System](ReferenceSystem.md)：四个内置 Reference Provider、自定义 Provider、选择/解析/诊断和精确跳转。
- [Project Refactoring](ProjectRefactoring.md)：稳定 Reference Value 重命名、影响预览、四领域适配和多文件事务。
- [Document Lifecycle](DocumentLifecycle.md)：Create/Copy/Move/Safe Delete 的 strict preview/apply、引用闭包和物理 mutation。
- [Project Transaction](ProjectTransaction.md)：Project 锁、SHA-256 前置条件、journal、阶段化提交、条件回滚和人工恢复。

## Provider、MCP 与协议

- [Project Provider V2](ProjectProvider.md)：stdio JSON-RPC、Reference/Validator、分页快照、Trust、MCP allowlist、进程生命周期和故障处理。
- [VisualBridge MCP Server V2](VisualBridgeMcp.md)：七个稳定工具、发现、查询、Operation、Lifecycle、Refactor、并发控制和原子写入。
- [VisualBridge 协议契约](ProtocolContracts.md)：15 份 Schema/manifest 单一事实源、TypeScript/C# 四个生成产物、版本、Hash、Cursor、状态、错误和生成一致性。

## 验证、发布与路线图

- [Release Quality](ReleaseQuality.md)：Node/npm/依赖锁定、Windows CI、真实 VSIX 激活、空缓存复现、私有分发边界和正式样例。
- [大工程确定性验证与性能报告](LargeProjectValidation.md)：确定性语料生成、correctness/benchmark profile 和报告解释。
- [Unity 接入前文档完整性矩阵](DocumentationCompleteness.md)：功能、设计、流程图、使用手册、Schema/Manifest 和自动验证的最终审计入口。
- [Unity 接入前开发任务清单](PreUnityDevelopmentRoadmap.md)：PU 任务状态、强制验证门槛和 Unity 正式接入条件。
- [Unity Editor 接入任务清单](UnityIntegrationRoadmap.md)：已完成的 C# contract generator、Package、Structured Export/Compile、最小 Editor Bridge 与发布门槛/文档/基线（VB-UI 系列全部关闭）。
- [Unity 领域扩展与 Runtime 接入任务清单](UnityDomainAndRuntimeRoadmap.md)：VB-UI 系列之后的下一大阶段规划——Entity/Table/Graph 离线编译、本机 Runtime 通道与调试链路、远程/设备连接的范围登记，全部任务 `pending`。

开发过程中的设计草稿、实施计划和任务文档统一放在 `Doc/Temp`。任务完成后必须删除对应临时文档；需要长期保留的结论应整理进上述正式文档。文档目录新增或删除文件时，根级文档门禁会要求本索引同步更新。
