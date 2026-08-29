# VisualBridge Reference System V1

## 1. 范围

Reference System 为 Graph、Entity、Structured 和 Table Document 提供同一套跨文档引用契约。字段所属模块只声明“引用什么”，不直接扫描文件、解析业务表或实现选择器。Core 负责稳定契约、Provider 注册、搜索、解析和诊断；VS Code 与 MCP 只负责宿主交互和持久化边界。

V1 已实现 `table.row`：任意共享字段可以按 Table Type、逻辑 Sheet 和可选 Document Type 引用一条有效表格记录。Unity Asset、运行时实例、反向查找和预览 Provider 仍是后续能力；当前不增加 Unity Exporter、Importer、Runtime 或 Debug 代码。

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

## 3. `table.row` Provider

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

V1 诊断代码为：

| Code | Severity | Meaning |
| --- | --- | --- |
| `reference.invalidTarget` | error | Provider 存在，但结构化 target 不符合该 kind 的契约。 |
| `reference.missingTarget` | error | `allowMissing: false` 且没有匹配目标。 |
| `reference.ambiguousTarget` | error | 同一个严格类型值解析到多个有效目标。 |
| `reference.providerUnavailable` | warning | 当前宿主没有注册该 kind；原始值必须保留。 |

Document Operation 仍先在副本上完整执行。宿主分别校验修改前后引用，只拒绝这次批次新引入的 reference error；既有坏引用会持续显示诊断，但不会阻止用户修复同一文档的其他问题。

## 5. VS Code 编辑闭环

共享 Form Editor 用只读稳定值加通用搜索、跳转图标呈现引用，不允许绕过 Provider 手输不受约束的值。Graph 自有属性布局复用同一 Webview Reference Bridge，Entity、Structured 和 Table 直接复用共享字段控件。

选择按钮向 Extension Host 发送结构化 definition 和当前值，由原生 Quick Pick 展示候选；Webview 只接收最终稳定值。跳转按钮先解析引用，歧义时要求选择具体目标，再由 Table Editor 打开对应载体并定位物理 Sheet/Row。

工作区索引以磁盘上的 Project Table 文档为基线，并用已打开 Table Custom Document 的当前语义快照覆盖同一逻辑表。未保存的新增、删除或改单元格会立即参与其他编辑器的搜索与校验；关闭文档后移除覆盖并回到磁盘基线。

Document Browser 使用同一 Reference Service 的解析候选展示每个文档的出站引用，并按候选 Location 的 Project、Document Type 与物理路径派生 `Referenced By` 关系。反向关系仅是工作区索引视图，不写回任何 Authoring Document；缺失或歧义引用继续使用本文件定义的诊断和解析状态。完整 Browser 契约见 `DocumentBrowser.md`。

Project Refactoring V1 使用解析候选的完整 Location，而不是仅按引用值，批量重命名一个 `table.row` 目标键及所有唯一解析到该物理行的入站 occurrence。Graph、Entity、Structured 和 Table 分别通过既有 Operation 与 Serializer 修改；CSV 分表和 XLSX 参与同一个带哈希检查与回滚的 Host 事务。缺失、歧义、同值不同目标和已存在的新键都拒绝自动修改。完整契约见 `ProjectRefactoring.md`。

## 6. MCP

`visualbridge_references` 提供两个动作：

- `search`：传入 `kind`、`target`、可选 `query`、`limit` 和 `allowMissing`，返回结构化候选及定位。
- `resolve`：传入相同 definition 与字符串或数值 `value`，返回解析状态和候选。

Graph/Structured/Table 的读取与校验结果会附加共享 Reference 诊断。GraphOperation/StructuredOperation/TableOperation 写入在原有 `baseHash`、锁和原子替换之外，还会拒绝本次批次新引入的 Reference error。MCP 不重新实现 Table Registry、分表去重、行显示名或字段递归规则。

## 7. 自动化基线

`npm test` 覆盖 Field Definition 解析、嵌套 occurrence、Provider 稳定排序、严格类型解析、缺失与歧义诊断、Table 有效行候选和定位。`TestData/EntitySemanticProject` 与 `TestData/StructuredSemanticProject` 都包含指向自定义扩展名分表的 `table.row` 引用；真实 stdio MCP 测试会搜索引用，并验证缺失目标不会被原子写入。测试不包含 Unity。
