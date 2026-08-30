# VisualBridge 文档目录

`Doc` 用于保存已经确定并落地的项目说明、正式架构设计和其他需要长期维护的文档。

- `VisualBridgeArchitecture.md`：平台总体架构与长期设计边界。
- `GraphSemanticModel.md`：Graph V3 的稳定身份、Graph Type、连接、类型化子图、Catalog 与安全替换契约。
- `VSCodeGraphEditor.md`：当前已落地的 Graph V3 格式和 VS Code 编辑能力。
- `EntityComponentModel.md`：Entity / Component V1、共享字段模型、项目自定义后缀和 VS Code 编辑契约。
- `StructuredConfigModel.md`：Structured Config V1、Project 唯一类型绑定、共享字段、VS Code 与 MCP 原子编辑契约。
- `TableSemanticModel.md`：Table Catalog V1、项目级表头行、C# 导出字段/单元格编码、CSV/XLSX Codec、分表与去重策略及 VS Code 编辑契约。
- `ReferenceSystem.md`：跨 Graph、Entity、Structured、Table 的共享引用契约、`table.row` Provider、VS Code 选择/跳转和 MCP 查询校验语义。
- `ProjectProvider.md`：Project Provider V2 声明、stdio JSON-RPC、Reference/Validator、分页快照、Trust、MCP allowlist、进程生命周期和故障处理手册。
- `ProjectCatalogManagement.md`：Project Settings、文件归属校验、Project Operation、Catalog 来源 Hash/过期状态与只读 Catalog Browser。
- `DocumentBrowser.md`：统一 Document Browser、共享索引、搜索/创建/全量校验、引用关系与错误入口。
- `WorkspaceIndexPerformance.md`：不可变增量语义快照、刷新取消、Reference/Provider 依赖缓存、稳定分页、Table 虚拟化与大工程基准手册。
- `ProjectRefactoring.md`：项目级 Reference Value 重命名、影响预览、四类文档适配与多文件回滚事务。
- `ProjectTransaction.md`：VS Code 与 MCP 共用的 Project 锁、SHA-256 前置条件、四种物理 mutation、journal、回滚与人工恢复契约。
- `ProtocolContracts.md`：Authoring、Provider、Project Transaction 与 MCP 的版本、Hash、游标、状态、错误和生成一致性契约。
- `ReleaseQuality.md`：Node/npm/依赖锁定策略、Windows CI、真实 VSIX 激活、空缓存复现、正式样例和发布边界。
- `VisualBridgeMcp.md`：项目级 stdio MCP 的工具边界、查询契约、`baseHash` 并发控制和原子写入语义。
- `DocumentLifecycle.md`：Document Create/Copy/Move/Safe Delete 的 preview/apply、引用闭包和物理事务契约。
- `PreUnityDevelopmentRoadmap.md`：Unity 正式接入前的任务状态、强制验证门槛和最终文档验收标准。
- `FlowGraphMigration.md`：ActionEditor FlowGraph 节点声明、功能对照和 Unity Catalog 导出迁移路线。

开发过程中的设计草稿、实施计划和任务文档统一放在 `Doc/Temp`。任务完成后必须删除对应的临时文档；需要长期保留的结论应整理到 `Doc` 下的正式文档中。
