# Unity Editor 接入架构：C# 契约与离线 Catalog/Compile

本文是 [VisualBridge Unity Editor 接入架构](UnityIntegrationArchitecture.md) 的子文档，覆盖首期范围、权威数据与冻结交接面、分层依赖、Unity Package 边界、C# contract generation、Integration Profile、C# 类型与共享 Field 映射、Catalog Export、离线 Import/Compile、信任边界，以及 Entity/Table/Graph 领域扩展的落地记录。

## 1. 文档定位

本文定义 VisualBridge 在 Unity 接入前 Authoring 基线之后的 Unity Editor 集成架构。首个垂直切片只证明普通 C# `class` / `struct`、冻结的 Structured Catalog V1、Structured Document V1 与 Unity Editor 派生数据之间的离线闭环；它不把 Unity Runtime、Debug、DAP 或 Player 包含进来。

本文在 [`VisualBridgeArchitecture.md`](VisualBridgeArchitecture.md)、[`ProtocolContracts.md`](ProtocolContracts.md)、[`StructuredConfigModel.md`](StructuredConfigModel.md) 和四个领域正式契约之上补充 Unity 侧职责。已有 Project、Catalog、Document、Field、稳定 ID、Hash 和诊断语义继续以 `Protocol/Schema`、`Protocol/contract-manifest.json`、现有 TypeScript Core 及领域正式文档为准。本文不能通过概念描述覆盖或放宽这些已冻结契约。

当前仓库已经完成 C# contract generator、有效 UPM Package、Integration Profile V1、Structured Catalog Exporter 与 offline Import/Compiler；固定 Unity 样例可在没有 VS Code/Bridge 的条件下执行 Generate/Check。UPM Package ID 固定为 `com.kyle.visualbridge`，C# namespace/assembly 使用 `VisualBridge.<Module>`；私有 VSIX 保持 `UNLICENSED` 并携带不授予公共使用权的 proprietary notice。最小 Editor Bridge V1 已实现并于 2026-08-31 完成：正式消息 Schema 进入 Protocol、Unity 侧客户端与 VS Code 扩展宿主服务器落地、全部自动化门槛通过、真实 Unity Editor 与隔离 VS Code Extension Host 完成 open/reveal E2E（见第 12 章）。Runtime 实例发现、Runtime Bridge 协议（含调试租约与源映射语义）、VS Code DAP 检查适配器与 MCP 运行时检查工具已于 2026-08-31 落地（见第 17、18 章）；Graph 执行过程可视化（游戏侧执行引擎的执行观察，不做断点）的设计与实施均已于同日关闭（见第 19 章；历史记录见 [`Archive/UnityDomainAndRuntimeRoadmap.md`](Archive/UnityDomainAndRuntimeRoadmap.md) 阶段 D）；断点/调用栈等执行级调试语义按 §18.3 范围裁定不进入协议，Unity Player 与远程/设备连接（阶段 C）明确推迟。UnityIntegrationRoadmap 已关闭并归档（[`Archive/UnityIntegrationRoadmap.md`](Archive/UnityIntegrationRoadmap.md)），无剩余门槛；当前未实现能力见 [`Backlog.md`](Backlog.md)。

## 2. 首期范围

首期包含：

- 从现有 JSON Schema 与 contract manifest 确定性生成 Unity 可消费的 C# contract。
- 建立 `Packages/com.kyle.visualbridge` 的 Editor-only UPM Package 基础。
- 使用固定的 Unity Integration Profile V1，把一个 Unity Project 关联到该 Unity Project 内的一个 Authoring Project。
- 从显式登记的普通 C# `class` / `struct` 和元数据生成 Structured Catalog V1。
- 在 Unity Editor 中读取 Project、Structured Catalog 和 Structured Document，生成确定性的 Editor 派生产物与映射清单。
- 离线垂直切片之后的下一阶段单独设计并实现最小 Editor Bridge，使 Unity Editor 可以请求 VS Code 打开或定位 Authoring Document；该阶段已实现并于 2026-08-31 完成（见第 12 章）。

首期明确不包含：

- Unity Player 程序集、设备发现、Player 配对或远程传输。
- Runtime loader、Runtime Instance ID、运行时执行或热更新。
- Debug Session、DAP、断点、调用栈、变量、Trace 或多客户端控制模型。
- Graph、Entity 或 Table 的 Unity Export/Import/Compile 实现。
- `ScriptableObject` Authoring 包装资产、子资源或 Unity Inspector 第二编辑源。
- 通过 Editor Bridge 触发 Authoring 写入、Catalog 导出或编译。
- 为上述延期能力预留未验证的消息、空程序集或半成品运行路径。

## 3. 权威数据与冻结交接面

Authoring 源文件继续是唯一权威数据。Catalog 描述可以创建和校验什么，Document 保存项目实际创建的实例；Unity 导入结果、编译结果、索引、缓存和映射都是可删除、可重建的派生数据。

```mermaid
flowchart LR
    CSharp["ordinary C# class / struct\nexplicit metadata"]
    Exporter["Structured Catalog Exporter"]
    Catalog["Structured Catalog V1\nderived description"]
    Project["VisualBridge Project File v2"]
    Document["Structured Document V1\nauthoritative source"]
    Compiler["Unity Editor Import / Compile"]
    Artifact["Editor derived artifact\nplus mapping manifest"]

    CSharp --> Exporter
    Exporter --> Catalog
    Project --> Compiler
    Catalog --> Compiler
    Document --> Compiler
    Compiler --> Artifact
```

当前跨语言交接面固定为：

- `Protocol/Schema` 和 `Protocol/contract-manifest.json`；
- VisualBridge Project、Catalog 和 Authoring Document；
- 稳定 ID、alias、规范路径、Hash、版本和结构化诊断；
- Catalog 顶层 `source` 状态以及类型级来源追踪。

以下内容不是现有 Authoring 契约的一部分：

- Unity 内部对象引用、Asset GUID、Local File ID、实例地址或数组索引；
- Unity Importer、Compiler 或 Bridge 的内部服务接口；
- Editor/Player discovery、transport、authentication 或 session message；
- Debug mapping 和 Runtime identity。

新增跨语言字段必须先进入正式 Schema/manifest、生成物和正反例，不允许在 C# 与 TypeScript 两侧分别手写同名 DTO。

## 4. 分层依赖

```mermaid
flowchart TB
    Schema["Protocol Schema + manifest"]
    Generator["deterministic C# contract generator"]
    Contracts["Unity Contracts layer\nengine-independent wire shapes"]
    Package["Unity Editor Package foundation"]
    Profile["Unity Integration Profile"]
    Mapper["C# type and shared Field mapper"]
    Exporter["Structured Catalog Exporter"]
    Compiler["Structured Import / Compile"]
    BridgeSchema["future Editor Bridge Schema"]
    Bridge["future minimal Editor Bridge"]
    VSCode["VS Code Extension Host"]

    Schema --> Generator
    Generator --> Contracts
    Contracts --> Package
    Package --> Profile
    Package --> Mapper
    Profile --> Exporter
    Mapper --> Exporter
    Profile --> Compiler
    Exporter --> Compiler
    BridgeSchema --> Generator
    Contracts --> Bridge
    Package --> Bridge
    VSCode --> Bridge
```

依赖规则：

- Catalog Exporter 依赖 C# contract、Unity Package、Integration Profile 和共享 Field mapper，不依赖 Editor Bridge。
- Structured Import/Compile 依赖 Project、Catalog、Document 以及可验证的物理来源，不以连接中的 VS Code 为前置条件。
- Editor Bridge 依赖独立冻结的 Bridge Schema、同一 C# generator、Unity Editor Package 和 VS Code Host；它不依赖 Compiler，也不是首个离线切片的完成条件。
- Runtime、Debug 和 Player 不能反向成为 Contracts、Exporter 或 Compiler 的依赖。
- 首期不建立公开 Unity Adapter Registry。只有第二个真实领域切片证明共同边界后，才决定是否抽取 Catalog Generator、Importer 或 Compiler 注册 API。

## 5. Unity Package 边界

Unity Package 源只有 `Packages/com.kyle.visualbridge/` 一份，`UnityProject/` 只作为开发宿主。当前 Package 分为：

UPM package ID 固定为 `com.kyle.visualbridge`。`kyle` 只属于 Package publisher 标识，不进入 C# namespace 或 assembly 名；C# surface 统一以 `VisualBridge` 为前缀并跟随模块名，例如 `VisualBridge.Runtime`、`VisualBridge.Editor` 和 `VisualBridge.Protocol.Generated`。

- **Runtime metadata marker**：`Runtime/Metadata/` 是 player-visible、`noEngineReferences: true` 的 Attribute/enum metadata surface，供游戏程序集声明 Catalog、Config 与 Field；它没有 Unity API，也不执行玩法初始化方法。
- **Runtime Bridge**：`Runtime/Bridge/` 承载本机回环的 Runtime Bridge 服务器、发现记录、严格校验器、编译产物只读存储与 Graph 执行采集门面（第 17、18、19 章）。它同样 `noEngineReferences: true`、`references: []`、全平台可见，只预编译引用 `Newtonsoft.Json.dll`；产物根路径由调用方解析（Editor Play 模式传 `Library/VisualBridge/Compiled`，Player 传 `<StreamingAssets>/VisualBridge/Compiled`），因此程序集本身不含 Unity API 也不含路径策略。
- **Generated contracts**：C# wire/data bags 位于 Editor assembly，只承载同源协议数据形状与 Schema hash，不引用 VS Code、Node 或 Webview，也不充当严格语义 validator。
- **Editor Integration**：Integration Profile、C# 元数据读取、Structured / Entity / Graph 三域 Catalog Export、Structured / Entity / Table / Graph 四域离线 Compile、诊断、最小 Editor Bridge 客户端与 Runtime Bridge 的 Play 模式宿主；只在 Unity Editor 中加载。
- **Editor Tests**：针对 contract、Profile、Exporter、Compiler、Editor Bridge 与 Runtime Bridge 状态机的 EditMode 验证。

`VisualBridge.Runtime` 已不只是 metadata marker：它按 §13.7 决策 B 升级为可进 Player 构建的运行时库，承担 Runtime Bridge 与编译产物只读加载。仍不提供的是 Unity Player 构建的产物接线（StreamingAssets 拷贝等，登记为遗留项）、远程/设备连接，以及断点式调试。

Package 不加载 VS Code 扩展源码或 TypeScript Core。Authoring Host 也不加载 Unity 程序集。两侧对同一输入得出一致结论，依靠冻结 Schema、生成 contract、共享固定样例和跨实现 parity 测试，而不是进程内共享实现。

## 6. C# contract generation

### 6.1 单一事实来源

C# generator 只读取现有 JSON Schema 与 contract manifest。当前四个生成产物 `Protocol/Generated/schema-index.json`、`contracts.d.ts`、`contracts.g.cs` 和 `Packages/com.kyle.visualbridge/Editor/Generated/VisualBridgeProtocolContracts.g.cs` 都来自同一输入；任何生成物都不得手改。两份 C# 输出 byte-identical。

当前 C# 输出范围由 manifest 的 `csharpGeneration.schemas` 与 `outputs` 机器登记，覆盖 Project、Catalog Source、Structured Catalog、Structured Document、Integration Profile、共享 Field/value shape 和其引用闭包；generator 源码不能临时挑选。加入 Editor Bridge 时再把正式 Bridge Schema 纳入相同登记。未进入 Unity 输出闭包的既有 MCP/Provider contract 仍继续参与全局 Schema drift gate。

### 6.2 确定性

生成器必须固定：

- UTF-8、LF、末尾换行和生成文件布局；
- namespace、类型、union branch 和成员的稳定命名；
- UTF-16 code-unit ordinal 顺序，不使用当前区域设置；
- 输入 Schema `$id`、原始 bytes Hash、manifest 版本和 generator 版本登记；
- clean checkout 中的 generate/check 行为。

连续两次生成必须产生完全相同的文件清单和 bytes。Schema、manifest 或生成物任一方发生漂移时，检查必须失败。

### 6.3 严格语义

生成 C# 类型不等于完成协议消费。生成类型是 wire/data bags；JSON Schema 的 `oneOf`、递归 Field、条件关系和 unknown-field 约束不会因为反序列化为 DTO 就自动成立。当前 Unity consumer 先读取 `JObject`，由 Profile loader、Authoring Project parser、Structured Catalog validator 和 Compiler 严格验证：

- `additionalProperties: false` 和 union/discriminator；
- Stable ID、normalized path、SHA-256、版本和长度上限；
- 只允许有限 number 的 JSON value；
- object、array、select、Reference 和共享 Field 递归约束；
- alias 冲突和 Catalog Registry 无歧义；
- unknown field、unknown version 和未解析 `$ref` 的拒绝行为。

序列化库必须通过固定 Unity 版本中的正反例验证后才能冻结。Unity `JsonUtility` 不能被默认当作可满足 Dictionary、union、opaque JSON 和严格 unknown-field 行为的实现。

## 7. Unity Integration Profile

### 7.1 所有权

现有 `VisualBridge.project.vbjson` 不包含 Unity Profile、生成范围或工具版本。当前不向 Project File v2 写入未登记键，而是在 Unity Project 固定位置 `ProjectSettings/VisualBridgeIntegration.json` 保存受版本控制、Schema 化的 Integration Profile V1。Profile 是声明式配置，不是 Authoring 文档，也不保存连接和会话状态。

Profile V1 只允许四个字段：

- `formatVersion: 1`；
- `authoringProject`：一个 Unity Project 相对的 `VisualBridge.project.vbjson` 路径；
- `catalogExports`：非空 export unit 列表，每项显式登记 `catalogId`、`title`、`.vbstructuredcatalog` 输出和非空、唯一的 assembly-qualified CLR type 名列表；
- `compileOutputRoot`：V1 Compiler 当前冻结为 `Library/VisualBridge/Compiled`。

Profile Schema 已进入 `visualbridge-unity-integration-profile.schema.json` 和 C# 生成闭包。V1 不支持 Unity Project 外部 Authoring root；所有路径都从 Unity Project root 解析，拒绝绝对路径、冒号、反斜杠、空 segment、`.`/`..`、root alias、symlink/reparse-point 与既有硬链接 alias，并在创建目录和原子替换前复核 canonical identity。未来外部 root 或多个 Authoring Project 必须升级正式 contract，不能通过环境变量或私有键绕过。

### 7.2 路由

Profile V1 的一个 Unity Project 只关联一个 Unity Project 内的 Authoring Project。Export/Compile 每次都从固定 Profile 显式解析该 Project File，不使用进程级 `currentProject`；多 Project 关联不属于 V1。

Structured Document 自身不保存 `configTypeId`。Unity Compiler 必须：

1. 从 Project File 建立 Project 边界；
2. 按 `documentRoots`、`include` 和 `exclude` 唯一解析 Document Type；
3. 确认 `editor: "structured"`；
4. 使用 Document Type 的稳定 `id` 在其 Catalog Registry 中解析规范 Config Type 或 alias；
5. 再校验并编译 Document。

文件后缀、C# 类型名或 Catalog 加载顺序都不能替代上述路由。

## 8. 普通 C# 类型与共享 Field 映射

首期 Exporter 只扫描项目显式登记的普通 C# `class` / `struct` 和显式元数据。类型不需要继承 VisualBridge 基类，也不允许通过 `ScriptableObject` 包装层才能导出。

稳定身份规则：

- Catalog ID、Config Type ID、Field ID 和 alias 必须由显式 metadata 提供；
- C# namespace、完整类型名、成员名和程序集名只用于来源追踪与诊断，不能自动承担持久身份；
- 类型或成员重命名时，只要显式 ID 不变，Authoring identity 就不变；
- alias 只能显式声明，不能由旧名称猜测生成。

默认值规则：

- 默认值来自确定性的声明式 metadata 或明确支持的常量；
- Exporter 不调用构造函数、业务初始化方法、Unity 生命周期方法或临时对象来获取默认值；
- 不可表示或不确定的默认值使当前类型导出失败，不能静默替换为语言默认值。

共享 Field mapper 首期覆盖已有 Structured V1 能力所需的 string、有限 number、boolean、颜色、select、Reference、递归普通 object 和 List。`System.Int32` 与 `System.Single` 必须分别保留为 `int` 与 `float` 语义，不能合并成 `number` Data Type。Dictionary、开放泛型、递归类型环、多态、delegate 和未登记 Unity Object 引用在没有正式映射前 fail closed。

共享 Field wire shape 继续由现有四类 Catalog Schema 和 Core Form model 定义。Unity 可以实现独立 C# mapper 和 validator，但不能创建一套 Unity 专属字段协议。

## 9. Structured Catalog Exporter

Exporter 输出当前冻结的 Structured Catalog V1，不输出未来版本或私有扩展字段。

一次 Export 分为：

1. 解析并校验 Integration Profile 与目标 Authoring Project；
2. 收集显式登记的 C# 类型和 metadata；
3. 构建与排序 canonical source snapshot；
4. 计算准确的 `sourceHash`；
5. 建立 Structured Catalog 候选；
6. 在内存中完成 Schema、共享 Field、默认值和 Registry 校验；
7. 生成确定性 UTF-8 JSON；
8. 写前复核目标 Hash，并通过同目录临时文件与原子替换提交。

`sourceHash` 必须基于实际影响 Catalog 的规范来源快照，且至少覆盖参与导出的类型、成员、显式 ID/alias、字段 shape、默认值和 exporter compatibility version。反射枚举顺序、文件时间、绝对机器路径和 Unity 当前 UI 状态不得进入 Hash。准确输入域和 canonical bytes 必须由固定测试锁定。

Generate 模式负责生成带 `source.status: "current"` 的 Catalog。Check 模式只比较来源快照、Catalog bytes 和登记版本，发现 drift 时失败而不覆盖文件。VS Code 与 MCP 继续只读取 Catalog 与来源状态，不扫描 C#。

## 10. Structured Import / Compile

### 10.1 离线服务

首个垂直切片是离线、Editor-only 服务。它必须在 VS Code 未运行、Editor Bridge 未连接时独立完成。菜单、batchmode 和后续其他宿主入口只能包装同一个 Compile Service，不能分别实现 Project 路由或字段转换。

Compile 输入包括：

- Integration Profile 与明确的 Authoring Project selector；
- Project File 和目标 Document Type；
- 目标 Structured Catalog Registry；
- Structured Document 原始 bytes；
- Package、contract、compiler compatibility version。

Compile 在产生输出前必须拒绝：

- Project/File 路由缺失或歧义；
- Catalog parse/Registry error 或明确 stale 状态；
- 未解析 Config Type、unknown version 或 unknown field；
- 共享 Field、范围、对象、List 或 Reference error；
- 输入在计划与提交之间发生变化；
- 输出路径越界或既有未知文件冲突。

### 10.2 派生产物

当前派生产物固定写入 `Library/VisualBridge/Compiled`，这是 Unity Project 内可删除的 Editor cache，不是 Authoring root 或手写 `Assets`。输出包括每个文档的确定性 compiled artifact、source mapping 和顶层 `manifest.json`；它们不是公开 Protocol Schema，也不承诺可由 Player 加载。若未来需要写入 `Assets`、参与 Build 或成为运行时二进制，必须另行设计 Runtime ownership、Asset import、版本与迁移。

每个派生产物带独立 mapping manifest，至少记录：

- Project ID、Document Type ID、Document ID 和规范 Config Type ID；
- Authoring source `baseHash`、Catalog Hash/`sourceHash`；
- contract、Package 和 compiler compatibility version；
- 派生产物路径与内容 Hash。

Mapping 不能写回 Authoring Document，也不能使用 Unity Object 地址或数组索引作为跨进程身份。它不是 Runtime Instance mapping。

Compiler 先在内存中构建完整 artifact plan 和 diagnostics，再写临时文件并原子替换。失败不改变上次有效输出。孤儿清理只允许根据同一 compiler 维护的 manifest 删除已知派生产物，不能扫描和删除未知文件。

### 10.3 确定性与并发

相同 Project、Catalog、Document 和 compatibility version 必须产生 byte-identical artifact 与 mapping。Compiler 读取 Authoring/Catalog bytes 时记录 Hash，并在提交前复核；外部修改返回冲突，不能自动覆盖或用旧计划重试。

首期 Unity Compiler 是只读 Authoring consumer。只有 Catalog Exporter 可以写 Profile 明确声明的 Catalog 目标；Compiler、Bridge、Editor tests 和 batchmode 验证都不得修改 Project File 或 Authoring Document。

**产物公开化决策（2026-08-31）**：离线编译产物保持内部格式（`formatVersion`/`kind`），不构成公开跨语言契约；外部消费若需稳定接口，升级为正式 Protocol Schema 并走生成/校验流程。VB-UX-09 已关闭，公开化未采用。

## 11. 信任与安全边界

```mermaid
flowchart LR
    Authoring["Authoring roots\ntrusted source bytes"]
    Profile["Unity Integration Profile\nsource-controlled declaration"]
    Unity["Unity Editor process\nproject code privileges"]
    Catalog["declared Catalog targets"]
    Derived["declared derived root"]
    FutureBridge["future local Editor Bridge\nseparate trust boundary"]
    VSCode["VS Code Extension Host"]

    Profile --> Unity
    Authoring --> Unity
    Unity --> Catalog
    Unity --> Derived
    Unity -. authenticated later .-> FutureBridge
    FutureBridge -. open or reveal only .-> VSCode
```

- Unity Editor 和项目程序集以当前用户权限运行，不是沙箱。显式 metadata、Profile 和目录 allowlist 只能限制 VisualBridge 的受支持行为，不能阻止恶意项目代码自行访问文件。
- 未信任的 Authoring bytes、Catalog 和 Profile 在反序列化后仍必须经过严格验证；C# 类型加载不能触发业务初始化方法。
- Exporter 只写声明的 Catalog 目标；Compiler 只写声明的派生根；Bridge 不写 Authoring 或 Catalog。
- 临时文件、日志、test results、discovery records 和 token 不得落入 Authoring 源或被当成可提交产品数据。
- 未知目标文件和未知外部 bytes 必须保留并报告，不得为“恢复一致性”而覆盖。

## 13. 领域扩展边界

Structured 是首个 Unity 切片，因为它能以最小范围验证 Project 类型绑定、共享 Field、稳定身份、Catalog Export 和派生编译。后续扩展必须继续遵守领域正式文档：

- Entity 只扫描普通运行时 `class` / `struct`，导出显式 Entity Type、Component Group、Component Type 和递归 Field ID；不恢复 `ScriptableObject` Authoring 包装层。
- Graph 必须输出 Graph Catalog V4，保留 `int`/`float`、Graph Type、typed subgraph、端口身份、连接规则、List port mode 和实例约束；不得输出旧 Catalog 版本。
- Table 必须消费 Catalog 定义的 Semantic Table、cell encoding、partition 和 effective row 语义；不得按 CSV 列位置或 XLSX 内部对象自行猜测业务结构。

第二个领域切片开始前应复核 Structured 服务边界。只有至少两个真实 Exporter/Compiler 使用相同生命周期、诊断和 artifact plan 后，才建立公开 Unity Adapter API。领域扩展与本机 Runtime 接入的历史执行顺序与 exit criteria 见 [`Archive/UnityDomainAndRuntimeRoadmap.md`](Archive/UnityDomainAndRuntimeRoadmap.md)；`ScriptableObject` Authoring 包装层确认为旧设计迁移残留，新体系不采用。

### 13.1 Entity Catalog Export 落地记录（VB-UX-01，2026-08-31）

Entity 是第二个 Unity 领域切片，只覆盖 Catalog Export；Entity 文档的 Unity 侧 Import/Compile 由 VB-UX-02 承接。设计要点：

- **metadata API**：`VisualBridge.Runtime` 新增四个 attribute——assembly 级 `VisualBridgeEntityCatalog(catalogId, title)`（每程序集一个 entity catalog）与 `VisualBridgeEntityComponentGroup(catalogId, id, title, Aliases)`（AllowMultiple）；类型级 `VisualBridgeEntityType(catalogId, id, title, Aliases, Description, AllowedComponentGroupIds)` 与 `VisualBridgeEntityComponent(catalogId, id, title, groupId, Aliases, Description, MenuPath)`。字段继续使用共享的 `VisualBridgeField`，因为 entity-catalog 与 structured-catalog 的 field/valueDefinition/editor $defs 完全同构。
- **路由**：Integration Profile 的 `catalogExports[].output` 扩展名决定 Exporter——`.vbstructuredcatalog` 走 Structured Exporter，`.vbentitycatalog` 走 `VisualBridgeEntityCatalogExporter`；Structured Compiler 同样按扩展名跳过非 Structured 导出单元。Schema pattern 与 C# loader 同步放开两种扩展名。
- **稳定身份**：entityType、componentType、componentGroup 三类身份（id + aliases）各自在单 catalog 内唯一，跨 catalog 全局唯一（`profile.catalogIdentityConflict`），与 VS Code Entity Registry 的全局命名空间语义一致；C# 全名只出现在 componentType 的 `source.typeName` 追踪信息中。`allowedComponentGroupIds` 与 `groupId` 必须引用同 catalog 内声明的组（`catalog.invalidReference`）；组收集采用两遍处理，类型注册顺序不影响结果。
- **产物结构**：输出即 `visualbridge-entity-catalog.schema.json` 的 Catalog V1——`{formatVersion, catalogId, title, source, componentGroups, entityTypes, componentTypes}`，其中 `source.sourceHash` 来自 canonical snapshot（含 componentGroups、按 id 排序的 entityType/componentType 及其 AQN）的 SHA-256；序列化、原子写、Generate/Check 与 changedBeforeReplace 语义复用 Structured Exporter 的共享实现（该实现以 internal 成员方式共享，是 VB-UX-03 Adapter API 复核的直接输入）。
- **绑定校验**：每个 entity catalog 输出必须被 Authoring Project 中 `editor == "entity"` 的 DocumentType 通过 `catalogs` 声明（`profile.catalogNotDeclared`）；不要求 per-type 覆盖，因为 entity 文档按 `entityTypeId` 引用 catalog 而非按类型路由文件。
- **验证基线**：严格 JObject 校验器 `VisualBridgeEntityCatalogValidator` 镜像 Schema（复用 Structured 校验器的字段校验共享实现）；EditMode 覆盖确定性、Check 不写盘、类型顺序无关、fail-closed 错误码、扩展名路由与绑定校验；开发宿主样例（Hero/Enemy 实体、Health/Movement 组件）经 batchmode Generate/Check 产出提交 Catalog `Gameplay.vbentitycatalog`，并通过 Node 生产 `parseEntityCatalog`/`parseEntityDocument`/`buildEntityCatalogRegistry` 校验。

### 13.2 Entity Import / Compile 落地记录（VB-UX-02，2026-08-31）

Entity 编译镜像 Structured Compiler 的生命周期与事务语义，由 `VisualBridgeEntityCompiler` 承载：

- **输入与前置**：Integration Profile（输出根冻结为 `Library/VisualBridge/Compiled`，reparse point 拒绝）→ Entity Catalog Check（drift 即 `compile.catalogDrift`）→ Authoring Project 严格解析 → Profile/Project/Catalog/文档全部纳入输入快照（SHA-256），提交前 `VerifyInputs` 拒绝 `compile.inputChanged`。
- **路由**：`.vbentity` 文档按 `editor == "entity"` 的 DocumentType include/exclude 唯一路由（`compile.ambiguousRoute`/`compile.documentOutsideRoot`）；DocumentType id 必须在其声明的 entity catalog 中按 id/alias 唯一解析到 entityType（`compile.entityTypeUnknown`/`compile.entityTypeAmbiguous`），文档的 `entityTypeId` 与之不符报 `compile.entityTypeMismatch`。文档校验为纯 JSON 级、对照 Catalog 字段定义执行——不实例化业务类型；未知字段 `compile.unknownField`、类型不符 `compile.typeMismatch`、别名 canonical 化、缺失字段以 Catalog `defaultValue` 物化（mapping 记 `origin: metadataDefault`）。组件校验含局部 id 唯一、`componentTypeId` 解析与组白名单（空白名单即全不允许，与 VS Code 侧 `isEntityComponentTypeAllowed` 语义一致，`compile.componentGroupNotAllowed`）。
- **产物结构**：`documents/{projectId}/{documentTypeId}/{documentId}.vbcompiled.json`（kind `visualbridge.entity.compiled`，`data` 含 `properties` 与按文档顺序的 `components[]`，字段按 canonical ID 排序）、`mappings/.../​*.vbsource.json`（kind `visualbridge.entity.sourceMapping`，逐字段 `{sourcePath, artifactPath, origin}`）、`manifest.entity.json`（kind `visualbridge.entity.compileManifest`，托管 outputs 清单）——与 Structured 产物共用 `documents/`、`mappings/` 子树但 manifest 分文件，互不接管对方托管集。
- **原子性与恢复**：复用 Structured Compiler 的事务实现（tmp → VerifyInputs → 基线复核 `compile.outputChangedBeforeReplace` → 备份 → Replace/Move → 失败逆序回滚，残留 bak 供人工恢复）；stale 输出按旧 manifest 托管集计算，Generate 删除、Check 报 drift；Check 模式不写盘。
- **验证基线**：EditMode 14 例覆盖确定性双跑、默认值物化与零业务构造、drift 不写盘、stale 删除/保留、全部 fail-closed 错误码、失败保留上次产物、别名 canonical 化、ambiguousRoute 与 Structured+Entity 共存；开发宿主样例 `Hero.vbentity` 经 batchmode Generate/Check 产出产物并通过二次运行字节一致校验。

> 13.3 的 Adapter API 复核决策记录已迁移至 [Editor Bridge 与冻结决策](UnityIntegrationArchitectureEditorBridge.md#133-unity-adapter-api-复核决策vb-ux-032026-08-31)。

### 13.4 Table Import / Compile 设计记录（VB-UX-04，2026-08-31）

Table 是第一个纯消费方切片：Unity 侧不建立 Table Exporter（权威数据在 VS Code 侧的 Table 文档与 Catalog），只实现编译。产物形态设计（任务前置结论）：

- **载体边界**：V1 只编译 CSV family。XLSX 是 OOXML zip+xml，Unity 侧无内置等价物且 Package 不引入第三方解压/解析依赖；遇到 `.xlsx` 路由到 table documentType 时以 `table.xlsxUnsupported` 明确拒绝。CSV 解析复刻 VS Code 侧 `csv-parse` 语义（UTF-8 严格、BOM 剥离、quote 转义、relax_column_count、空行保留）。
- **消费语义**：完整复刻权威链路——nameKeyRow/dataStartRow（来自 `visualbridge.table` 模块的 `options.tableLayout`，缺失报 `compile.tableLayoutMissing`、形状非法报 `compile.projectInvalidTableLayout`）、nameKey（含 aliases、trim 精确匹配）列映射、cell encoding（scalar/json/delimited 递归、空串→defaultValue）、key column 校验（空值 `table.emptyKey`、单 sheet 内重复 `table.duplicateKey`）、rowId 生成（有 key 时 `${definitionId}:${physicalName}:key-${stableValueKey}`）、跨分区去重（`error` 失败、keepFirst 跳过、keepLast 原位替换）。
- **编译单元与聚合**：Table 没有虚构的 Document ID；产物按 documentType 聚合。documentType.id 必须在其声明 catalog 中按 id/alias 唯一解析到 tableType（`compile.tableTypeUnknown`/`compile.tableTypeAmbiguous`，与 Entity 的 entityType 路由同构）。该 documentType 路由到的全部匹配文件（按路径 UTF-16 序排序）各自成为一个物理 sheet（`${definitionId}:${fileBaseName}`），按 sheet definition 拼接后做全局有效行去重。与 VS Code 侧"同目录 family"作用域的差异：编译器把整个 documentType 视为一个编译单元、去重跨全部文件——单 family 场景（样例与绝大多数用法）两者等价，多目录分布同一分区键时以声明 duplicatePolicy 全局裁决。
- **产物结构**：`documents/{projectId}/{documentTypeId}/{tableTypeId}.vbcompiled.json`（kind `visualbridge.table.compiled`，`data` 为 `{sheets:[{definitionId, rows:[{rowId, cells}]}]}`，行按有效顺序、cells 按 canonical 列 ID 排序、值为解码后 JSON 值）、`mappings/{projectId}/{documentTypeId}/{tableTypeId}.vbsource.json`（kind `visualbridge.table.sourceMapping`，逐 cell 记 `{sourcePath, artifactPath, origin}`——空/缺 cell 物化默认值记 `metadataDefault`）、`manifest.table.json`（kind `visualbridge.table.compileManifest`）。事务、输入快照、stale 清算复用共享实现。
- **Catalog 信任**：table catalog 不在 profile 导出闭包中（无 Exporter），以提交文件为准；`visualbridge-table-catalog.schema.json` 进入 Protocol C# 生成闭包，Unity 侧新增严格校验器 `VisualBridgeTableCatalogValidator` 镜像 Schema（含 cellEncoding oneOf、partition namePattern、rowDisplayNamePattern 占位符约束）。

落地与验证记录（同日）：`VisualBridgeTableCompiler`/`VisualBridgeTableCompilerBatch`（菜单 Generate/Check Table Compiled Data）按上述设计实现；`VisualBridgeAuthoringProject` 暴露 `Modules`，Table 行布局由 `VisualBridgeTableCompiler` 从 `visualbridge.table` 模块的 `options.tableLayout` 解析。EditMode 新增 14 例（确定性双跑、默认值物化与 mapping origin、drift 不写盘、stale 生命周期、keepFirst/keepLast、delimited 解码、tableTypeUnknown、missingColumn、duplicateKey、duplicatePartitionKey、xlsxUnsupported、tableLayoutMissing、invalidCell、失败保留产物）随全套 98/98 通过。开发宿主样例（`Gameplay.vbtablecatalog` + `Tables/Skills_Main.csv`）经 batchmode Generate/Check 产出 `sample.unity.skills` 产物（rowId `skills:Skills_Main:key-101` 与 VS Code 约定一致），table catalog 经 Node 生产 `parseTableCatalog`/`buildTableCatalogRegistry`/`matchTableSheetDefinitions` 校验。已知实现边界：keepLast 为原位替换（TS 侧为删除后 append，仅中间插入其他行时顺序不同）；rowDisplayNamePattern 仅校验占位符形状（不校验列引用，编译器不消费该 pattern）；解码后 cell 不执行 editor 数值约束（与权威 cellCodec 一致）。Project File 变更（如新增 table documentType）会改变 `projectSha256` 输入，全部编译器按输入 Hash 语义报 drift，需统一重新 Generate——这是设计内行为。

### 13.5 Graph Catalog V4 Export 设计记录（VB-UX-05，2026-08-31）

Graph 是契约面最大的领域切片，输出 Graph Catalog V4（`formatVersion 4`，不接受旧版本）。设计：

- **metadata API**（`VisualBridge.Runtime` 新增）：assembly 级 `VisualBridgeGraphCatalogAttribute(catalogId, title)`（每程序集一个 graph catalog）与 `VisualBridgeGraphDataTypeAttribute(id, title)`（AllowMultiple，可选 Color/AcceptsAnySource/Accepts——root `dataTypes` 需显式声明，因 title 必填无法自动推导）；类型级 `VisualBridgeGraphTypeAttribute(catalogId, id, title)`（命名参数 Aliases/Description/Usage(root|subgraph|any)/SupportedCatalogIds/PortConnectionInput/PortConnectionOutput/AllowedNodeTypeIds/AllowedNodeTags/AllowedNodeTraits/AllowSubgraphs/AllowedSubgraphTypeIds）；`VisualBridgeNodeTypeAttribute(catalogId, id, title, category)`（Aliases/Description/Icon/MenuPath/Tags/Traits）；graphType 类上的 AllowMultiple `VisualBridgeGraphNodeConstraintAttribute(id, nodeTypeId, MinInstances, MaxInstances)` 与 `VisualBridgeGraphInitialNodeAttribute(nodeTypeId, title)`；字段级 `VisualBridgePortAttribute(id, title, kind, direction)`（Aliases/Description/DataTypeId/MaxConnections——data 端口 DataTypeId 缺省时由 CLR 类型映射 int/float/string/bool 推导，flow 端口禁止）与 `VisualBridgeDynamicPortGroupAttribute(id, title, direction, listPortMode)`（MaxItems/DataTypeId——item 由 `List<T>` 元素类型经共享字段模型推导）。
- **selector 映射**：graphType 的 AllowedNodeTypeIds/AllowedNodeTags/AllowedNodeTraits 生成单个 nodeSelector（nodeTypeIds OR、tags OR、traits AND、三维 AND——与 VS Code `matchesNodeSelector` 语义一致）；nodeConstraint 的 selector V1 仅支持 nodeTypeId 形态。
- **typed subgraph**：nodeType 带 `SubgraphGraphTypeIds`（`VisualBridgeNodeTypeAttribute` 命名参数）时导出 `subgraph.graphTypeIds`；静态/动态 flow 端口禁止（Schema 约束，校验器执行）。
- **端口与字段分离**：`[VisualBridgePort]` 字段是端口声明，不进入 properties（与 Schema 的 ports/properties 分离一致）；同一字段同时声明 Port 与 Field 报 `catalog.duplicateMetadata`。
- **身份**：graphType/nodeType/dataType/port/dynamicPortGroup 的 id+aliases 各自全局无歧义；C# 全名只进 `source.typeName`。supportedCatalogIds 必须包含自身 catalog 且引用已声明 catalog（跨 catalog 引用由 VS Code Registry 校验，导出侧校验自引用与已知 catalog 集合）。
- **复用与校验**：Exporter 复用 Structured Exporter 的 internal 共享层（BuildFields/序列化/原子写/两遍处理）；严格校验器 `VisualBridgeGraphCatalogValidator` 镜像 Schema（复用共享字段校验）；三方 parity fixture（AJV / Unity validator / 扩展宿主）覆盖端口身份、连接规则、typed subgraph 与实例约束的正反例。
- **绑定校验**：graph catalog 输出（`.vbgraphcatalog` 扩展名路由）必须被 `editor == "graph"` 的 DocumentType 声明；Profile Schema pattern 放开三种 catalog 扩展名。

### 13.6 Graph Import / Compile 设计记录（VB-UX-06，2026-08-31）

Graph 编译镜像既有 Compiler 生命周期，由 `VisualBridgeGraphCompiler` 承载；产物形态设计（任务前置结论）：

- **路由**：`.vbflow` 等 graph 文档按 `editor == "graph"` 的 DocumentType include/exclude 唯一路由。**与 Entity/Table 不同，不要求 documentType.id 解析到 graphType**——VS Code 侧创建文档时 root graphType 由作者从 catalog 选择，documentType.id 仅作显示；编译器改为校验每个文档 root graph 的 `graphTypeId` 在声明 catalog 中解析为非 subgraph graphType（`compile.graphTypeUnknown`，usage 校验 `compile.invalidGraphTypeUsage`）。
- **fail-closed 边界**：VS Code 文档诊断中 warning 级的「未知类型」在编译器为错误（无法物化与校验）——`compile.nodeTypeUnknown`/`compile.graphTypeUnknown`；error 级语义全部复刻：身份唯一（graphId/nodeId/edgeId/interfacePortId/dynamicPortId 全文档唯一、duplicateSemanticConnection/Property）、边校验（方向、kind、dataType 可赋值性、有效连接上限=min(graphType 规则, 端口 maxConnections)）、节点允许性（selector 匹配、subgraph 白名单与调用类型匹配、接口端口冲突）、实例约束、动态端口（组解析、上限、身份冲突）、接口端口（data/flow 规则、根图禁 dynamic）、属性值校验。
- **canonical 化与默认值**：nodeType/graphType/port 引用经别名解析为 canonical id 进产物；节点与图的缺失属性以 Catalog defaultValue 物化（mapping 记 `origin: metadataDefault`），未知属性报 `compile.unknownField`（对齐 Entity）。
- **产物结构**：`documents/{projectId}/{documentTypeId}/{documentId}.vbcompiled.json`（kind `visualbridge.graph.compiled`；`data` 为 `{graphs:[{id, graphTypeId, title, properties, interfacePorts, nodes, edges}]}`——保留 position（文档 required 字段、无权威分类将其排除在业务数据外）、节点/边按 id 排序、properties 键按 canonical ID 排序）；`mappings/.../{documentId}.vbsource.json`（逐属性 `{sourcePath, artifactPath, origin}`）；`manifest.graph.json`（kind `visualbridge.graph.compileManifest`）。Catalog drift 检查走 `VisualBridgeGraphCatalogExporter` Check（graph catalog 由 Unity 导出，对齐 Entity Compiler）。
- **Registry**：复用 `VisualBridgeGraphCatalogValidator` 校验单 catalog，另做跨 catalog 的 nodeType/graphType/dataType 身份合并与冲突检测（对应 VS Code `buildGraphCatalogRegistry` 语义）。

落地与验证记录（同日）：`VisualBridgeGraphCompiler`/`VisualBridgeGraphCompilerBatch`（菜单 Generate/Check Graph Compiled Data）按上述设计实现，VS Code `graph.*` 诊断到编译器 `compile.*` 错误码的映射表留档于实现（warning 级类型别名一律静默 canonical 化、未知类型 fail-closed）。EditMode 新增 19 例（确定性双跑、默认值物化与 alias canonical 化、Check 不写盘、stale 生命周期、subgraph 正路径、11 个错误码负路径、失败保留产物、Batch 契约）随全套 133/133 通过；batchmode 垂直切片：Graph Compile Generate/Check 与 Structured/Entity/Table 编译、Graph Catalog 全部退出码 0；样例 `Encounter.vbflow` 编译产物与 mapping 经二次运行字节一致校验，四套 manifest（structured/entity/table/graph）共存互不干扰。产物 subgraph 节点保留 `subgraphId`（与 position 同理：文档 required 字段，无权威分类排除）。

> 13.7 的 Runtime 产物形态冻结决策已迁移至 [Runtime Bridge 与 Graph 执行观察](UnityIntegrationArchitectureRuntime.md#137-runtime-产物形态冻结决策vb-ux-072026-08-31)。
