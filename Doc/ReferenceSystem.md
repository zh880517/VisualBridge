# VisualBridge Reference System

## 1. 范围

Reference System 为 Graph、Entity、Structured 和 Table Document 提供同一套跨文档引用契约。字段所属模块只声明“引用什么”，不直接扫描文件、解析业务表或实现选择器。Core 负责稳定契约、Provider 注册、搜索、解析和诊断；VS Code 与 MCP 只负责宿主交互和持久化边界。

当前内置 `document`、`graph.element` 和 `table.row` 三类 Provider。它们分别引用 Project Document Type 下的稳定 Document ID、Graph 文档内部的稳定元素 ID，以及 Table Type/Sheet 下的有效记录。Unity Asset、运行时实例和项目自定义 Provider 仍是后续能力；当前不增加 Unity Exporter、Importer、Runtime 或 Debug 代码。

## 2. 字段契约

Reference 是共享 Field Definition 的可选语义，不是独立 JSON 对象包装。文档中继续只保存 C# 字段对应的字符串或数值稳定键：

```json
{
  "id": "primarySkillId",
  "title": "Primary Skill",
  "valueType": "number",
  "dataTypeId": "int",
  "defaultValue": 101,
  "editor": {
    "kind": "reference",
    "readOnly": false,
    "integer": true
  },
  "reference": {
    "kind": "table.row",
    "target": {
      "tableTypeId": "sample.table.skills",
      "sheetId": "skills"
    },
    "allowMissing": false
  }
}
```

- `kind` 选择一个稳定的 Reference Provider。
- `target` 是 Provider 解释的结构化选择器，只允许 JSON 值，不保存显示名称或物理文件名。
- `allowMissing` 明确缺失目标是否允许；省略时为 `false`。
- 引用字段的 `valueType` 只能是 `string` 或 `number`，解析使用严格类型相等；数值 `101` 不等于字符串 `"101"`。
- `editor.kind` 只决定使用通用引用控件，字段值的 JSON 形态和运行时 `dataTypeId` 仍由 Field Definition 决定。

Graph 属性、Graph 动态端口值、Entity 根字段、Component 字段、Structured 字段和 Table 单元格均递归收集 Reference Occurrence。对象、List 和 Catalog 默认值沿用同一遍历规则，不为每种 Document 重复实现引用解析。

## 3. 内置 Provider

### `document`

`document` 的 `target` 只包含必填的 `documentTypeId`。Provider 按 Project File 的 `include` / `exclude` 和 Document Type 大类加载 Graph、Entity 或 Structured 文档，候选值为文件内容中的 `documentId`；文件扩展名和路径不承担身份。相同 Document ID 出现在不同 Document Type 中不冲突，同一 Document Type 内重复则解析为 `ambiguous`。

### `graph.element`

`graph.element` 的 `target` 只包含 `documentTypeId` 和 `elementKind`，其中 `elementKind` 为 `graph`、`node`、`interfacePort` 或 `dynamicPort`。候选值始终是对应元素的稳定 ID。可重命名的 `documentId`、`graphId` 和 `nodeId` 不允许进入 target，否则重命名父级会让 Catalog 选择器自身悬空；同一 Document Type 与 Element Kind 下重复的值明确解析为 `ambiguous`。

Graph 元素 Location 显式保存 `elementKind`、`elementId`、`graphId`、`nodeId` 和 `portId`。端口 ID 允许只在其 Graph 或 Node 作用域内唯一，因此不能退化为只有 `elementId` 的定位。

### `table.row`

`table.row` 的 `target` 为：

```json
{
  "tableTypeId": "sample.table.skills",
  "sheetId": "skills",
  "documentTypeId": "sample.table.skills"
}
```

`tableTypeId` 和 `sheetId` 必填，接受 Catalog 规范 ID 或 alias；`documentTypeId` 可选，用于同一 Table Type 被多个项目子类使用时进一步限定范围。目标不得包含未声明键。被引用 Sheet 必须声明 `keyColumnId`，候选值来自该稳定列。

Provider 通过 Project Registry 发现所有 `editor: "table"` 的 Document Type，并遵守项目自定义的 `include`、`exclude`、任意文件扩展名、CSV 分表规则和 XLSX Worksheet 规则。候选来自 `resolveEffectiveTableRows`，因此跨分表重复项采用 Catalog 的 `error`、`keepFirst` 或 `keepLast` 策略。显示名称使用 `rowDisplayNamePattern`，持久值仍是 key 列的严格类型值。

候选定位保存 Project ID、Document Type ID、项目相对路径、物理 Sheet ID 和 Row ID。路径只用于导航，不参与引用身份。

## 4. 搜索、解析与诊断

Reference Service 注册少量按 `kind` 唯一的 Provider：

- `search` 按结构化 `target` 和文本查询返回稳定排序的候选，数量限制在 1 到 200。
- `resolve` 按严格类型值返回 `resolved`、`missing`、`ambiguous` 或 `providerUnavailable`。
- `validate` 将文档内 occurrence 转换为统一 `DocumentDiagnostic`。

统一诊断代码为：

| Code | Severity | Meaning |
| --- | --- | --- |
| `reference.invalidTarget` | error | Provider 存在，但结构化 target 不符合该 kind 的契约。 |
| `reference.missingTarget` | error | `allowMissing: false` 且没有匹配目标。 |
| `reference.ambiguousTarget` | error | 同一个严格类型值解析到多个有效目标。 |
| `reference.providerUnavailable` | warning | 当前宿主没有注册该 kind；原始值必须保留。 |

Document Operation 仍先在副本上完整执行。宿主分别校验修改前后引用，只拒绝这次批次新引入的 reference error；既有坏引用会持续显示诊断，但不会阻止用户修复同一文档的其他问题。

## 5. VS Code 编辑闭环

共享 Form Editor 用只读稳定值加通用搜索、跳转图标呈现引用，不允许绕过 Provider 手输不受约束的值。Graph 自有属性布局复用同一 Webview Reference Bridge，Entity、Structured 和 Table 直接复用共享字段控件。

选择按钮向 Extension Host 发送结构化 definition 和当前值，由原生 Quick Pick 展示候选；Webview 只接收最终稳定值。跳转按钮先解析引用，歧义时要求选择具体目标。Table 目标由 Table Editor 定位物理 Sheet/Row；Document 目标打开其声明的 Authoring Document；Graph Element 目标还会切换到 Location 指定的 Graph，选择并居中 Node，或居中并临时高亮 Interface Port / Dynamic Port。Graph Webview 未就绪或隐藏重建时，Host 会保留带请求 ID 的定位请求，直到 Webview 返回处理结果；目标作用域已失效时明确失败，不按同名元素猜测。

工作区索引以磁盘上的 Project Table 文档为基线，并用已打开 Table Custom Document 的当前语义快照覆盖同一逻辑表。未保存的新增、删除或改单元格会立即参与其他编辑器的搜索与校验；关闭文档后移除覆盖并回到磁盘基线。

Document Browser 使用同一 Reference Service 的解析候选展示每个文档的出站引用，并按候选 Location 的 Project、Document Type 与物理路径派生 `Referenced By` 关系。反向关系仅是工作区索引视图，不写回任何 Authoring Document；缺失或歧义引用继续使用本文件定义的诊断和解析状态。完整 Browser 契约见 `DocumentBrowser.md`。

Project Refactoring 使用解析候选的完整 Location，而不是仅按引用值，批量重命名 `document`、`graph.element` 或 `table.row` 目标及所有唯一解析到该位置的入站 occurrence。Graph 元素重命名通过 `graph.renameElement` 原子更新结构身份、连线端点和子图调用映射；CSV 分表和 XLSX 与文本 Document 参与同一个带哈希检查与回滚的 Host 事务。完整契约见 `ProjectRefactoring.md`。

## 6. MCP

`visualbridge_references` 提供两个动作：

- `search`：传入 `kind`、`target`、可选 `query`、`limit` 和 `allowMissing`，返回结构化候选及定位。
- `resolve`：传入相同 definition 与字符串或数值 `value`，返回解析状态和候选。

Graph/Structured/Table 的读取与校验结果会附加共享 Reference 诊断。GraphOperation/StructuredOperation/TableOperation 写入在原有 `baseHash`、锁和原子替换之外，还会拒绝本次批次新引入的 Reference error。MCP 不重新实现 Table Registry、分表去重、行显示名或字段递归规则。

`visualbridge_refactor_reference` 提供 `preview` 和 `apply`。预览返回稳定 `previewHash`、完整影响列表、每个物理源的 `baseHash` 与预计结果哈希；提交必须原样提供 `previewHash` 和全部 `baseHashes`。服务端重新扫描 Project、重新解析同一目标并重建语义计划，任一来源、候选、Catalog 或分表成员变化都返回 `conflict`，不会自动套用旧计划。

## 7. 自动化基线

`npm test` 覆盖 Field Definition 解析、嵌套 occurrence、三个 Provider 的稳定排序与完整定位、严格类型解析、缺失与歧义诊断、Graph 元素身份传播、Graph Editor 定位计划、Table 有效行候选和定位。Graph 定位测试固定验证 Graph / Node / Interface Port / Dynamic Port 的画布目标以及陈旧完整作用域拒绝。真实 stdio MCP 测试会预览并提交 Graph Element、Document ID 和跨 Structured/Table 的 Row Key 重构，验证错误 `baseHash` 不会改写任何来源。测试不包含 Unity。
