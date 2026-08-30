# VisualBridge 文档目录

`Doc` 用于保存已经确定并落地的项目说明、正式架构设计和其他需要长期维护的文档。

- `VisualBridgeArchitecture.md`：平台总体架构与长期设计边界。
- `GraphSemanticModel.md`：Graph V3 的稳定身份、Graph Type、连接、类型化子图、Catalog 与安全替换契约。
- `VSCodeGraphEditor.md`：当前已落地的 Graph V3 格式和 VS Code 编辑能力。
- `EntityComponentModel.md`：Entity / Component V1、共享字段模型、项目自定义后缀和 VS Code 编辑契约。
- `StructuredConfigModel.md`：Structured Config V1、Project 唯一类型绑定、共享字段、VS Code 与 MCP 原子编辑契约。
- `TableSemanticModel.md`：Table Catalog V1、项目级表头行、C# 导出字段/单元格编码、CSV/XLSX Codec、分表与去重策略及 VS Code 编辑契约。
- `ReferenceSystem.md`：跨 Graph、Entity、Structured、Table 的共享引用契约、`table.row` Provider、VS Code 选择/跳转和 MCP 查询校验语义。
- `ProjectProvider.md`：Project Provider V1 声明、stdio JSON-RPC、Reference/Validator、Trust、MCP allowlist、进程生命周期和故障处理手册。
- `DocumentBrowser.md`：统一 Document Browser、共享索引、搜索/创建/全量校验、引用关系与错误入口。
- `ProjectRefactoring.md`：项目级 Reference Value 重命名、影响预览、四类文档适配与多文件回滚事务。
- `VisualBridgeMcp.md`：项目级 stdio MCP 的工具边界、查询契约、`baseHash` 并发控制和原子写入语义。
- `DocumentLifecycle.md`：Document Create/Copy/Move/Safe Delete 的 preview/apply、引用闭包和物理事务契约。
- `PreUnityDevelopmentRoadmap.md`：Unity 正式接入前的任务状态、强制验证门槛和最终文档验收标准。
- `FlowGraphMigration.md`：ActionEditor FlowGraph 节点声明、功能对照和 Unity Catalog 导出迁移路线。

开发过程中的设计草稿、实施计划和任务文档统一放在 `Doc/Temp`。任务完成后必须删除对应的临时文档；需要长期保留的结论应整理到 `Doc` 下的正式文档中。
