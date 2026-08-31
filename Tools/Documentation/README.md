# 文档门禁

`npm run check:docs` 在不打开 VS Code 或 Unity 的前提下校验受维护的 Markdown、VS Code 扩展面、MCP 注册表与可执行示例。它随后复用 Protocol Contract 工作区真实的 stdio `check:mcp`，因此 MCP 构建产物必须已存在；CI 在 `npm run build` 之后运行本门禁。

## JSON 围栏元数据

新增或修改业务 JSON 围栏时必须标注可执行契约。下面的示例本身就会被校验：

```json visualbridge-schema=visualbridge-primitives.schema.json#/$defs/lockOwner
{
  "version": 1,
  "token": "1b3121ab-2646-4e0f-a789-e970d4fbca8f",
  "pid": 42,
  "startedAt": "2026-08-30T12:34:56.000Z"
}
```

完整的 Authoring 文档使用 `visualbridge-parser=project`、`catalog-source`、`graph-document`、`graph-catalog`、`entity-document`、`entity-catalog`、`structured-document`、`structured-catalog` 或 `table-catalog`。完整的根 Schema 示例必须同时声明其 Schema 与生产 Parser。只声明 Schema 的围栏仅允许指向正式的 JSON Pointer 片段（如 `#/$defs/...`），且该片段不存在独立的产品 Parser。带 Parser 的围栏要求对应的工作区构建产物已存在。

不存在遗留豁免：受维护文档中的每个 `json` 或 `jsonc` 围栏，无论新旧，都必须带可执行元数据，否则门禁失败。

受维护的 `Samples/PreUnityAuthoring` 文件由 `npm run test:samples` 单独校验：每个 JSON Project、Catalog 与 Document 源文件都通过其正式 JSON Schema 与生产 Parser；CSV 额外通过生产 Table Parser。

## 固定的 Parser 依赖

以下版本与许可证在引入前均已对照 npm registry 核实：

| 包 | 版本 | 许可证 | 用途 |
| --- | --- | --- | --- |
| `unified` | `11.0.5` | MIT | Markdown 处理管线 |
| `remark-parse` | `11.0.0` | MIT | CommonMark Markdown AST |
| `remark-gfm` | `4.0.1` | MIT | GitHub 风格 Markdown 扩展 |
| `github-slugger` | `2.0.0` | ISC | GitHub 兼容的标题锚点 |
| `jsdom` | `29.1.1` | MIT | Node 下 Mermaid 解析所需的确定性 DOM |
| `mermaid` | `11.17.2` | MIT | 真实 Mermaid 语法解析 |
| `ajv` | `8.20.0` | MIT | JSON Schema 2020-12 校验 |

仓库依赖策略要求这些直接依赖版本、工作区许可证元数据与 lockfile importer 保持精确一致。
