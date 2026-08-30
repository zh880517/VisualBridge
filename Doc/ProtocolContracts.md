# VisualBridge 协议契约

## 1. 定位与范围

本文冻结公开 Authoring 协议以及首个 Unity Structured offline slice 使用的 Integration Profile 契约。`Protocol/Schema` 中的 14 份 JSON Schema 是跨进程、跨语言传输结构的单一事实来源；`Protocol/contract-manifest.json` 是版本、C# 生成闭包、Hash 域、游标上限、状态和错误码的机器可检查登记表。

当前冻结范围包括：通用 primitive、Project/Catalog/Document、Graph/Entity/Structured/Table Operation、Reference、Reference Refactor、Document Lifecycle、Project Transaction 的公开输入/结果、Project Provider V2、七个 MCP Tool 的输入/输出，以及 Unity Integration Profile V1。Unity Compiler 派生产物和 mapping/manifest 当前是 Editor 内部格式，不是公开跨语言 Schema；Discovery、Editor Bridge transport、WebSocket、Runtime 和 Debug 也不在本协议中。

Project Transaction 的 journal 与 lock 文件是 Node Host 私有的持久恢复格式，不是公开跨语言消息。它们仍登记版本并接受实现一致性检查，恢复语义见 [ProjectTransaction.md](ProjectTransaction.md)。当前 C# contract 与 TypeScript contract 由同一 Schema/manifest 确定性生成；Unity 的 Profile、Project、Catalog 和 Document 消费者先读取 `JObject` 并执行严格语义 validator，不能把生成 DTO 当成 validator。

## 2. 契约源与生成物

```text
Protocol/Schema/*.schema.json
        │
        ├── AJV 2020-12 编译与正反例
        ├── Protocol/Generated/schema-index.json
        ├── Protocol/Generated/contracts.d.ts
        ├── Protocol/Generated/contracts.g.cs
        ├── Packages/com.kyl.visualbridge/Editor/Generated/
        │   └── VisualBridgeProtocolContracts.g.cs
        └── MCP tools/list 递归一致性检查

Protocol/contract-manifest.json
        ├── 版本、C# Schema closure 与输出路径
        ├── Hash 域
        ├── 状态、冲突和错误码
        └── Core / Node Host / MCP 实现常量对照
```

四个正式生成产物是 `schema-index.json`、`contracts.d.ts`、`contracts.g.cs` 和 Package 内的 `VisualBridgeProtocolContracts.g.cs`。`schema-index.json` 记录每个 Schema 的 `$id`、原始 bytes SHA-256 和定义名；`contracts.d.ts` 是只读传输声明，并由 TypeScript 编译器再次检查。每个正式 Schema 都生成一个由文件名稳定派生的 TypeScript namespace：`Root` 表示 Schema 根契约，后续声明与该 Schema 的全部 `$defs` 一一对应；注释保留源文件与 `$id`。跨 Schema 的同名定义由 namespace 隔离，namespace 或单个 Schema 内规范化后的 TypeScript 名称冲突、无法解析的 `$ref` 都会使生成失败。

两份 C# 文件 bytes 相同，分别供 Protocol 独立编译检查和 Unity Package Editor assembly 消费。其生成类型是 wire/data bags：记录 DataContract/DataMember、nullable/collection/opaque JSON 载体、Schema Hash 与登记信息，但不承诺由 C# 类型系统完整表达 JSON Schema 的 `oneOf`、条件约束或递归语义。Profile loader、Authoring Project parser、Structured Catalog validator 和 Compiler 必须先在严格 `JObject` 层拒绝 unknown property/version、非法 union/value shape、ID/path/hash、alias 与 Registry 冲突，再把已验证数据映射到业务对象；直接反序列化生成 DTO 不是合法的严格验证路径。

生成物不得手改，`generate --check` 会拒绝缺失或漂移。Schema 新增会同时改变 namespace 集合和 index，任何 Schema bytes 变化都会改变 index 中的 SHA-256；因此即使纯 annotation 变化不影响 TypeScript 类型，也不能绕过 drift gate。

所有公开 object 默认采用 `additionalProperties: false`。只有以下边界允许领域拥有的 JSON 键：Catalog/Document selector、Reference target、Graph/Entity/Structured/Table 的 JSON value/property，以及成功 Tool 输出的领域 data。错误 details 也是有意 opaque 的 JSON value。opaque 不代表任意 JavaScript 值；它仍只能是 JSON null、boolean、有限 number、string、array 或 object。

### Schema 与功能归属

| Schema | 对外契约与权威实现 |
| --- | --- |
| `visualbridge-primitives` | Stable ID、路径、Hash、JSON value 等跨域 primitive。 |
| `visualbridge-project` | Project V1、Document Type 与任意后缀路由；语义权威在 Core Project Registry。 |
| `visualbridge-project-provider` | 受信 Project Provider V2 JSON-RPC 请求、响应与分页。 |
| `visualbridge-catalog-source` | Catalog Source、source hash 和来源清单。 |
| `visualbridge-graph-catalog` / `visualbridge-graph` | Graph Catalog V4、Graph Document V3 与 GraphOperation。 |
| `visualbridge-entity-catalog` / `visualbridge-entity` | Entity Catalog/Document V1 与 EntityOperation。 |
| `visualbridge-structured-catalog` / `visualbridge-structured` | Structured Catalog/Document V1 与 `structured.setField`。 |
| `visualbridge-table-catalog` | Table Catalog V1、列编码和分表策略；CSV/XLSX 物理字节由 Table Codec 负责，不伪装成 JSON Document Schema。 |
| `visualbridge-authoring-contracts` | Reference、Refactor、Lifecycle、Transaction 与统一 Document transport。 |
| `visualbridge-unity-integration-profile` | Unity Project 内固定 Profile V1；显式关联一个 Authoring Project、Structured Catalog export units 与 `Library/VisualBridge/Compiled` 派生输出根。语义权威在 Unity Profile loader。 |
| `visualbridge-mcp-tools` | 七个 stdio MCP Tool 的严格输入/输出信封。 |

Graph、Entity、Structured、Table Catalog 中重复出现的 Field/value-shape 序列化定义是冻结后的公共 wire shape；编辑器语义只有一份，权威实现位于 Core Form model 和 `Editors/Form`。Schema parity 不是四个文件的文本或 bytes 相等检查：生成器会把四个 Catalog 的 10 个共享 `$defs` 解析后做结构 `deepEqual`，还会以同一组正反例行为矩阵分别执行四个 validator。最小 scalar、递归 object/array、结构化 select 和 number Reference 等正例必须全部接受；空白标题、重复 alias、错误递归 shape、缺失 select option 等反例必须全部拒绝。结构不同或任一 validator 的接受/拒绝结果不同都构成 drift。Host 或 Unity 不得据此复制另一套字段编辑规则。Table 的语义传输仍是 JSON 值，但 CSV family 与 XLSX 是 Host Codec 边界，其物理格式不由 JSON Schema 描述。

## 3. 通用 primitive

| Primitive | 冻结规则 |
| --- | --- |
| Stable ID / alias | `A-Z a-z 0-9 . _ -`，首字符必须为字母或数字，最长 128。 |
| normalized path | Project 相对路径，使用 `/`，禁止绝对路径、盘符、反斜杠、空段、`.`、`..` 和 `:`，最长 1024。 |
| SHA-256 | 64 个小写十六进制字符。 |
| JSON value | `null`、boolean、有限 number、string、array 或 object；递归层级中的非有限数值同样非法。 |
| reference value | 只允许 string 或 number；重构前后必须保持相同 JSON primitive 类型。 |
| format version | 正整数；具体文档、消息和私有恢复格式在 manifest 分别登记。 |
| lock owner | 私有 V1：UUID token、正整数 PID、UTC ISO date-time `startedAt`，拒绝未知字段。 |

严格类型是协议的一部分。整数位置、limit、generation 和版本不能用数字字符串替代；Reference value 的 `1` 与 `"1"` 是不同身份。Schema 校验对未知字段、enum/const、默认值、长度、数组上限、正则、UUID 和 date-time 都实际生效。

## 4. 规范顺序与 Hash

所有需要稳定顺序的键、路径、候选和 target manifest 使用 UTF-16 code-unit ordinal 比较，不使用当前区域设置。Canonical JSON 递归按该顺序排列 object key；array 顺序保持其领域含义。协议 Hash 统一使用 SHA-256、64 个小写十六进制字符，但每个 Hash 的输入域不同，不能互换：

TypeScript 实现只以 Core `Ordering/ordinal.ts` 导出的 `compareUtf16CodeUnits` 为权威；Core、Built-in、Node Host、MCP 和 VS Code Host 不得各自复制 comparator，也不得以 `localeCompare`、ICU 或无 comparator 的 `sort()` 生成协议结果。Webview 可以按本地化标题排列临时菜单或 Picker，但该展示顺序不得进入 Operation、序列化、Hash、cursor、plan 或 source manifest。

| Hash | 输入域与用途 |
| --- | --- |
| `baseHash` | 写入前权威物理源的完整原始 bytes；用于拒绝覆盖外部修改。 |
| `sourceHash` | Catalog Provider 的准确输入 bytes。 |
| `catalogHash` | 已解析 Catalog 内容及完整 source manifest 的 canonical 表示。 |
| `previewHash` | 带版本的完整 preview plan canonical payload。 |
| `dependencyHash` | 完整、排序的 Project/Catalog/DocumentSet/ReferenceIndex 依赖 manifest。 |
| `snapshotHash` | Provider 或分页查询的完整候选快照。 |

Apply 必须提交完整 physical target/base manifest 和 dependency manifest。缺少一个目标或依赖不是“较弱校验”，而是无效请求。Host 在取得 Project lock 后重新读取权威源、重建计划并再次比较全部 Hash；不匹配时拒绝写入。

## 5. 游标与分页

游标是 opaque token，调用方不得解析或改写。它必须绑定规范化 query、目标域及快照：

- 普通 MCP Project/Catalog/Document 游标最长 256 字符。
- MCP Reference 外层游标最长 262,144 字符，用于安全封装 Provider continuation。
- Project Provider V2 continuation 最长 16,384 字符。
- Reference Search 每页最多 200；Document 搜索每页最多 1,000。

`cursor.invalid` 表示 token 结构或 continuation 非法；`cursor.queryMismatch` 表示 query/kind/target 与签发时不同；`cursor.snapshotChanged` 表示 Project、Catalog、Provider entry、Provider instance/process generation 或 Provider `snapshotHash` 改变；`cursor.outOfRange` 只属于普通 offset 型 MCP 分页，不是 Provider Reference Search 状态。

Provider V2 的 `reference/search` 后续页必须同时携带 `cursor` 与上一页 `snapshotHash`。每个成功页都返回稳定 `snapshotHash`，即使没有 `nextCursor` 也必须合法并与前页一致。候选按统一稳定 comparator 严格递增；下一页的每个候选都必须大于上一页边界。Provider 进程重启、entry bytes 改变、候选快照改变或旧 cursor 重放均返回 `cursor.snapshotChanged`，不能从新快照继续旧分页。

## 6. Operation 与 Document transport

四个领域 Operation 只描述语义修改，不包含主机写文件步骤：

- Graph：节点、子图、动态端口、接口端口、连接、类型分配、安全节点替换和排序。
- Entity：标题、属性、组件的增删改名、启用、复制和排序。
- Structured：按稳定字段 ID 更新 JSON value。
- Table：按 sheet/row/column 稳定身份更新单元格，以及行的增删、复制和排序。

Document transport 固定 Project/Document Type/editor/path、当前 `baseHash`、可选 `catalogHash`、JSON document 和 diagnostics。领域 Adapter 必须依次 parse、应用有序 Operation、校验并确定性序列化。Host 只能提交全部 Operation 成功后的结果；任何中间失败都不得产生部分写入。

MCP `visualbridge_apply_operations` 采用两层边界：`tools/list` 只公开稳定且可扩展的 `{ type: StableId, ...domainFields }` adapter envelope；进入服务后必须通过 `documentOperation` 的严格 Graph/Entity/Structured/Table union。协议工具不会声称宽松 envelope 本身就是完整领域校验。

## 7. Reference、Refactor 与 Lifecycle

Reference 定义由 kind、JSON object target 和 allowMissing 组成。候选固定 string/number value、标题、可选描述和结构化 location。Search、Resolve、Validate Target 的状态集合分别在 manifest 登记；Provider failure 是显式业务状态，不伪装为空结果。

Reference Refactor 是严格 preview/apply 两阶段协议：

- preview 不能携带 `previewHash` 或 `baseHashes`；
- apply 必须携带完整 `previewHash` 和每个物理源的 `baseHashes`；
- `oldValue` 与 `newValue` 必须同为 string 或同为 number；
- apply 在锁内重新解析目标、occurrence、Catalog 和所有源，任何变化都返回登记的冲突 reason。

Document Lifecycle 的 Core contract 允许领域 Adapter 拥有 create parameters；MCP 的当前四个内置 editor 则公开精确 create union，并严格冻结 Graph、Entity、Structured、CSV/XLSX 参数。preview 不接受 apply 字段；apply 必须提供 `previewHash`、原始 `planPayload`、完整 `baseHashes` 和 dependencies。Lifecycle blocker、Core plan conflict 与 MCP 最终 public conflict 是不同集合，分别登记，调用方不得只处理 Core 的五个 plan reason。

## 8. Transaction、锁与冲突

公开 transaction mutation 只有三种合法 Hash 状态：replace 同时有 `beforeHash`/`afterHash`，create 只有 `afterHash`，delete 只有 `beforeHash`。move 在 Host 内表现为一组完整 mutation/precondition，不存在缺少两侧 Hash 的“空 mutation”。

同一 Project 同时只允许一个 cooperating writer。live owner 绝不被抢占；stale owner 必须先完成安全恢复。`writeInProgress`、`baseHashMismatch`、`dependencyChanged`、`changedBeforeReplace` 都是可预期冲突，均不授权覆盖或就地重试。调用方必须重新读取、重新 preview。

`transaction.finalizationPending` 是已提交但清理待完成的 maintenance 状态，不能重复提交。`transaction.*Failed`、journal/path/recovery 错误的完整集合由 manifest 冻结并从 Node Host 实现提取核对。journal V2 和 lock owner V1 只用于 Node Host 本地恢复；当前及后续 C# generation closure 都不得据此生成公共 Unity API。

## 9. 错误与状态登记

`contract-manifest.json` 对以下集合进行分域登记并由生成检查器与实现常量或类型 union 对照：

- transaction conflict、failure 与 maintenance；
- Lifecycle blocker、plan conflict 和最终 MCP conflict；
- Refactor 最终 MCP conflict；
- Reference/Core/Provider business status；
- Provider JSON-RPC numeric error 与 Host structured error；
- 七个 MCP Tool 的 public Tool Error code 和 output status。

MCP public error code 是稳定机器键，message 面向人类且不作为分支依据。Document diagnostics 的 code 属于 editor/provider 诊断命名空间，故意不做穷举；它们不是 Tool transport failure。新增或删除公开 code/status 必须同步实现、manifest、Schema 和正反例，不能静默复用含义。

## 10. 七个 MCP Tool

公开工具名固定为：

1. `visualbridge_project`
2. `visualbridge_catalog`
3. `visualbridge_document`
4. `visualbridge_apply_operations`
5. `visualbridge_references`
6. `visualbridge_refactor_reference`
7. `visualbridge_document_lifecycle`

每个工具都有独立 input/output `$defs`。统一输出含 `contractVersion: 2`；成功结果使用登记的业务 status 和领域 data，失败使用 `status: "error"` 与结构化 error。Refactor 与 Document Lifecycle 的 preview/apply 输入是严格 action 联合：preview 不声明也不接受 apply-only 字段。`check:mcp` 启动真实 stdio Server、调用 `tools/list`，递归比较 type、properties、required、union、`allOf`、`if/then/else/not`、enum/const/default、数值和长度限制、pattern、array、propertyNames 与 unknown-field 规则，并执行无效 action 字段和路径反例。selector/target 只豁免领域内部键，仍强制 JSON object；Operation envelope 至少强制 Stable ID discriminator；只有 output data/error details 是有意 opaque。

## 11. 开发与发布流程

在 MCP 已构建后运行：

```powershell
npm run generate --workspace @visualbridge/protocol-contract
npm run check --workspace @visualbridge/protocol-contract
npm run check:mcp --workspace @visualbridge/protocol-contract
npm run test --workspace @visualbridge/protocol-contract
```

变更流程为：先修改 Schema/manifest，再重新生成四个产物；随后运行 drift check、TypeScript/C# 声明编译、AJV 正反例、Unity strict `JObject` validator parity 和真实 stdio MCP 一致性检查。CI 必须先构建 MCP，因为 live check 检查的是实际 `dist/server.js`。C# generator 只读取 manifest 登记的 Schema closure 与输出路径，并已加入相同 deterministic generation/drift gate；不得另建手写 Unity DTO 作为第二事实来源，也不得把 wire/data bags 的反序列化成功误报为语义校验成功。

完整的外部 Host/MCP 接入步骤见 [`IntegrationGuide.md`](IntegrationGuide.md)，最终文档与验证覆盖矩阵见 [`DocumentationCompleteness.md`](DocumentationCompleteness.md)。
