# VisualBridge 文档目录

`Doc` 用于保存已经确定并落地的项目说明、正式架构设计和其他需要长期维护的文档。

- `VisualBridgeArchitecture.md`：平台总体架构与长期设计边界。
- `GraphSemanticModel.md`：Graph V3 的稳定身份、Graph Type、连接、类型化子图、Catalog 与安全替换契约。
- `VSCodeGraphEditor.md`：当前已落地的 Graph V3 格式和 VS Code 编辑能力。
- `VisualBridgeMcp.md`：项目级 stdio MCP 的工具边界、查询契约、`baseHash` 并发控制和原子写入语义。
- `FlowGraphMigration.md`：ActionEditor FlowGraph 节点声明、功能对照和 Unity Catalog 导出迁移路线。

开发过程中的设计草稿、实施计划和任务文档统一放在 `Doc/Temp`。任务完成后必须删除对应的临时文档；需要长期保留的结论应整理到 `Doc` 下的正式文档中。
