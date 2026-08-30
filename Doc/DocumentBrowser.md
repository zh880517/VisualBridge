# VisualBridge Document Browser V1

## 1. 定位

Document Browser 是 VS Code 基础插件中的语义工程导航入口。它不替代 VS Code Explorer，也不建立第二套文件所有权；Explorer 继续负责普通文件浏览，Document Browser 只展示已经由 `VisualBridge.project.vbjson` 解析为唯一 Document Type 的 Authoring Document。

V1 统一覆盖 Graph、Entity、Structured 和 Table，提供：

- 按 Project 与 Project Document Type 浏览；
- 跨标题、稳定 ID、类型、路径、诊断和引用搜索；
- 从同一入口创建四类文档；
- 全工程语义校验与 Problems 发布；
- 文档出站引用、反向被引用关系和引用目标跳转；
- CSV 分表的逻辑文档与物理源文件展开。

Document Browser 不实现 Unity Catalog Exporter、Importer、Runtime 或 Debug。

Browser V1 已提供浏览、搜索、创建、校验、引用、稳定 ID 重构、复制、路径移动和安全删除。Lifecycle 操作通过单一 Document Lifecycle Service 的严格 preview/apply 流程执行，Tree Item 不直接操作文件系统。完整契约见 [`DocumentLifecycle.md`](DocumentLifecycle.md)。

## 2. 共享文档索引

`Core/Document/documentIndex.ts` 定义宿主无关的 `IndexedDocument`、`IndexedDocumentReference`、稳定排序、搜索和汇总规则。索引项包含 Project ID、Document Type ID、编辑器大类、逻辑主路径、全部物理源路径、标题、可选 Document ID、语义诊断和引用解析结果。

VS Code 的 `WorkspaceDocumentIndex` 负责宿主适配：

1. 从 `ProjectRegistry` 取得有效 Project 和 Document Type；
2. 使用 Document Type 的 `include` / `exclude` 发现任意项目自定义后缀；
3. 每种类型只调用其既有 Catalog Registry、Parser、Validator 和 Reference Collector；
4. 使用共享 `WorkspaceReferenceService` 校验并解析引用；
5. 对结果执行 Core 的确定性排序和搜索。

索引不复制 Graph、Entity、Structured 或 Table 规则。Catalog 不可用、源文件解析失败和引用缺失都会保留为结构化诊断，原始文件不被修改。

当前实现建立按 Project、Document Type、Catalog 依赖和逻辑物理来源键控的不可变语义快照。插件激活时完整建立基线；Project、Catalog 或匹配文件保存、创建和删除后重新发现来源，但只对依赖键变化的逻辑文档运行正式 Parser/Validator，其他单元直接复用。CSV 分表按完整物理文件族作为一个逻辑单元。Reference Service 直接消费同一 Project Snapshot，单遍生成引用诊断和解析结果，不再为索引刷新重复扫描 Project。文本 Custom Editor 的已保存版本进入索引；Table Custom Editor 的未保存语义作为 Reference Picker 临时覆盖层，不改写已提交索引。取消、事件合并、进度和陈旧 generation 丢弃的完整契约见 [`WorkspaceIndexPerformance.md`](WorkspaceIndexPerformance.md)。

## 3. 浏览树

Activity Bar 的 VisualBridge 容器提供 `Documents` 视图：

```text
Project
├─ Problems
│  └─ Document
│     └─ Diagnostics
├─ Graph Document Type
│  └─ Graph Document
├─ Entity Document Type
│  └─ Entity Document
├─ Structured Document Type
│  └─ Structured Document
└─ Table Document Type
   └─ Logical Table
      ├─ Problems
      ├─ References
      ├─ Referenced By
      └─ Sources
```

所有功能按钮使用 VS Code Codicon / `ThemeIcon`。错误、警告、文档大类、引用和物理源分别使用通用功能图标，不为同一动作引入另一套图标。Document Item 的标题是语义显示名，路径只作为右侧说明和 Tooltip，不在标题中重复堆叠。

Table 分表在树中只显示一个逻辑文档。展开 `Sources` 可以看到同目录、同扩展名并匹配同一分表命名规则的物理文件；打开任一源仍进入相同 Table Editor 语义载体。

## 4. 搜索与打开

`Search Documents` 使用一个原生 Quick Pick 搜索全部索引字段。多个空格分隔的查询词采用 AND 语义；结果按 Project ID、Document Type ID 和主路径稳定排序。

搜索内容包括：

- 文档标题和稳定 Document ID；
- Project ID、Document Type ID、编辑器大类；
- 主路径和全部物理源路径；
- 诊断 code、path 和 message；
- 引用 kind、字段路径、稳定值、候选标题和目标路径。

打开操作仍调用 `VisualBridge: Open Document`，由 Project Registry 再次确认唯一 Document Type，并按 `editor` 路由到 Graph、Entity、Structured 或 Table Custom Editor。Document Browser 不通过扩展名猜测编辑器。

## 5. 统一创建

`VisualBridge: Create Document` 与视图标题的新增按钮列出所有支持的 Project Document Type。Document Type 节点旁的新增按钮直接锁定当前 Project 和类型。创建流程继续调用各领域既有创建逻辑和 Catalog Registry：

- Graph：选择允许作为根图的 Graph Type 并创建默认节点；
- Entity：选择 Entity Type 并物化全部根字段默认值；
- Structured：以 Project Document Type ID 绑定 Config Type 并物化全部字段默认值；
- Table：以 Table Type 和 Project `tableLayout` 创建空表头。

Table 创建先显式选择 `csv` 或 `xlsx`，格式不从文件扩展名推断；Project 可以为任一格式声明自定义后缀。`csv` 使用显式 `physicalName`，`xlsx` 不接受该字段。描述行写入 Column 标题，配置的 `nameKeyRow` 写入 C# 导出的 `nameKey`，数据从 `dataStartRow` 开始。分表初始 `{part}` 使用 `Main`。创建后仍通过 Project Registry 验证目标路径，不允许绕过 `include` / `exclude`。

## 6. Lifecycle 操作

Document 与 Document Type 节点使用统一功能图标提供 Create、Copy、Rename/Move Path 和 Safe Delete。Stable ID Rename 仍显示为 Replace，并进入 Project Refactoring；它不是文件重命名。路径移动必须保持文件字节、Document ID、内部元素 ID 和 Reference value 不变。

所有 Lifecycle 操作先展示只读预览，再由用户明确提交。预览至少显示：

- 规范化后的源、目标和完整物理 source manifest；
- Copy 请求中完整显式的 `stableIdRemap`，以及 Create 请求中的 strict `parameters`；
- Delete closure、外部入站引用和 Reference coverage blocker；
- operation source 的完整 physical `plan.baseHashes`（Create 为 `{}`，Copy/Move/Delete 含全部来源）、Core 共享 builder 生成的四项 `plan.dependencies`，以及 `plan.mutations.targetMustBeAbsent` 表达的目标不存在性；
- 实际将执行的 `create`、`replace`、`delete` 或 `move` 物理 mutation。

Copy 的 `stableIdRemap` 和 Create 的新身份参数由调用方在 preview 请求中完整提供；preview 只校验并规范化，不自动生成 ID。Apply 必须原样提交同一 operation、`previewHash`、`planPayload`、`plan.baseHashes` 和完整 `plan.dependencies`；来源、目标不存在性、Catalog、Reference 候选或计划发生变化时返回 conflict，并要求重新预览。Safe Delete 不自动级联：删除闭包外只要有可能解析到目标的 occurrence 就阻止提交，`allowMissing: true` 也不构成删除授权。

Copy 创建 remap 后的新身份，不显示 `targetLocationChanged`；只有保持身份值不变的 Move 把 source/target `ReferenceLocation` 变化列为该 impact。Create preview 的 owned identity 保持领域 Adapter 原始声明，目标真正进入 Project index 前不伪造可导航 Location。

Create/Copy 预览通过四领域 Adapter 为整个 Project 建立 owned identity collision index；Graph Edge、Table dedup 等没有 Reference definition 的 identity 也按严格值类型、`kind` 和 `collisionScope` 检查。Contained Safe Delete 的 owned identity 列表只展示实际删除闭包。所有 canonical 列表采用 UTF-16 code-unit 全序，不受操作系统语言环境影响。

Table 在 Browser 中始终按逻辑 Document 操作。CSV family 的 Copy、Move 和 Delete 覆盖全部分表成员；XLSX 覆盖整个 Workbook，而不是当前 Worksheet。目标仍必须解析为同一 Project 和同一 Project Document Type。

Lifecycle preview/apply 要求 Project 中没有未保存的 VisualBridge 文本文档或 Table Custom Editor 状态；已经保存但仍打开的 Table Editor 不阻止执行。Explorer、Git 或外部脚本绕过 Lifecycle 的文件操作只能由文件监听与重新索引检测，不能被视为已经安全校验。各领域编辑器中的 Component、Graph Element 和 Table Row 删除按钮也必须进入同一 Lifecycle 流程。

## 7. 校验、引用与错误入口

Document Item 图标和 `Problems` 分组直接展示当前索引快照中的 error / warning。`Validate All Documents` 会刷新快照，并将每个逻辑文档的诊断发布到 `VisualBridge Workspace` Diagnostic Collection；检测到 error 时可以直接打开 VS Code Problems。

文档展开后：

- `References` 显示该文档收集到的出站 Reference Occurrence 和解析状态；
- 已解析目标使用共享 Reference Service 跳转；
- 缺失、歧义或 Provider 不可用分别使用错误或警告图标；
- `Referenced By` 根据已解析候选的 Project、Document Type 与物理路径反向聚合来源文档。

`References` 与 `Referenced By` 中唯一解析且可重构的 `document`、`entity.component`、`graph.element` 和 `table.row` 提供通用 Replace 图标。该入口调用 Project Refactoring：以解析后的完整目标位置建立影响计划，预览所有 occurrence 和物理载体，再原子修改目标稳定 ID 与入站引用。它不执行文本查找替换，也不会修改同值但指向另一目标的字段。完整事务契约见 `ProjectRefactoring.md`。

反向关系是索引派生数据，不写入 Authoring Document。当前四个内置 Provider 共用相同 Browser 结构；Graph Element 跳转会进入对应 Graph 并聚焦具体 Node 或 Port，Entity Component 跳转会展开并高亮对应 Component 卡片，而不是只打开文件。

## 8. 验证边界

Core 自动化测试固定验证索引排序、跨语义字段搜索和汇总计数。Table 自动化测试固定验证 CSV / XLSX 空载体创建后能够被同一 Codec 重新解析。完整仓库继续运行 `npm run check`、`npm test`、`npm run build`、VSIX 打包和 `git diff --check`；本功能不增加 Unity 测试或 Unity 实现。
