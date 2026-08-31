# VisualBridge Protocol Contract 工具

`Protocol/Schema` 是公开传输契约的唯一输入。在本包内运行 `npm run generate` 编译全部 JSON Schema，并重新生成 `Protocol/Generated/contracts.d.ts`、`Protocol/Generated/contracts.g.cs`、`Packages/com.kyle.visualbridge/Editor/Generated/VisualBridgeProtocolContracts.g.cs` 与确定性的 schema index。每个正式 Schema 生成一个按文件名派生的 TypeScript 命名空间，包含作为 `Root` 的根契约与每个 `$defs` 条目的声明。源文件与 `$id` 注释保证声明可追溯；命名空间隔离跨 Schema 的同名类型（如 `Identifier`），规范化后的命名冲突与未解析的 `$ref` 会使生成失败。

两份 C# 产物必须字节一致；任一生成产物发生漂移时 `npm run check` 失败。`schema-index.json` 对每个 Schema 逐字节哈希，即使注解改动不改变 TypeScript 类型也会被检出；新增 Schema 必须伴随新的命名空间与 index 条目。`npm run check:mcp` 启动构建好的 MCP stdio 服务器，获取其真实的 `tools/list` Schema，并将七个公开工具面与 `visualbridge-mcp-tools.schema.json` 比对。

C# 生成同样只消费 JSON Schema 与 manifest，不得从 TypeScript 源码或 Unity 程序集反推契约，也不得手写第二份 DTO。
