# VisualBridge Graph 语义模型

## 范围

本文定义已落地的 Graph Document V3 与 Graph Catalog V4 的 Authoring 契约。内容涵盖稳定身份、多 Catalog 登记、Graph Type、流程与数据连接、带类型的内嵌子图、Catalog 驱动的校验，以及安全的节点类型替换。Runtime 执行、Unity 编译与调试不在当前实现范围内。

## 稳定身份

序列化的 Reference 绝不依赖显示名、源文件名、C# 类名或命名空间。以下值是稳定 ID：

- `documentId` 与 `graphId` 标识文档与内嵌图。
- `nodeId` 在编辑与移动过程中标识一个节点实例。
- `nodeTypeId` 标识由 Graph Catalog 声明的语义节点类型。
- `graphTypeId` 标识每个根图或内嵌图的语义契约。
- `portId`、`propertyId` 与 `interfacePortId` 标识连接与属性契约。

显示名可以随意重命名。节点实现在其源类被重命名时必须保留现有 `nodeTypeId`。Catalog `aliases` 为节点类型、Graph Type、端口与属性提供显式的旧 ID。项目把其声明的 Catalog 加载进同一个注册表。Catalog ID 与 Data Type ID 全局唯一；Node Type 与 Graph Type 的规范化 ID 及别名在各自命名空间内全局无歧义。VisualBridge 拒绝冲突的注册表，而不是按 Catalog 加载顺序裁决。如果某个类型不可用，VisualBridge 会保留节点及其完整属性对象，并将其报告为未知。

## 文档所有权与内嵌子图

一个 `.vbgraph` 包含一个根图和零个或多个内嵌图：

```json visualbridge-schema=visualbridge-graph.schema.json visualbridge-parser=graph-document
{
  "formatVersion": 3,
  "documentId": "combat_logic",
  "rootGraphId": "root",
  "graphs": [
    {
      "id": "root",
      "graphTypeId": "game.main-flow",
      "title": "Combat Logic",
      "properties": {},
      "interfacePorts": [],
      "nodes": [],
      "edges": []
    }
  ]
}
```

图以扁平集合存储，以保证 Operation 寻址的稳定性。子图节点通过 `subgraphId` 拥有另一个图；每个非根图恰好有一个所有者。删除子图节点会在同一 Operation 中删除其拥有的图层级。流程与数据边可以包含环，但子图所有权必须保持为无环树。

每个图还拥有一个 JSON `properties` 对象。其 Graph Type 声明由可折叠的 Graph Inspector 渲染的类型化字段与编辑器提示。节点标题和 Catalog 定义的字段直接在每个画布节点上编辑；标题只有在双击头部后才进入编辑模式。与数据输入端口共享身份的属性会和该端口一起渲染。一旦连接，其字面量编辑器会被隐藏，同时保留已存储的回退值，以便断开连接后恢复。Inspector 绝不因节点或边的选择而改变其目标，也不暴露原始 JSON 或图接口管理。

图属性与动态端口条目值还可以额外声明共享的 `reference` 契约。Reference 值在 Graph 文档中仍是普通字符串或数字；Catalog 提供 Provider 种类、稳定的目标选择器与缺失值策略。画布和 Inspector 使用与 Entity/Table 字段相同的宿主 Reference Picker 与目标导航，而 GraphOperation 校验只拒绝新引入的 Reference 错误。参见 `ReferenceSystem.md`。

子图暴露显式的接口端口。从父图看，输入接口是输入手柄，输出接口是输出手柄。在子图内部，方向是相反的：输入接口向内部节点提供值或流程，输出接口接收它们。边不能绕过这一公开接口去寻址另一个图中的节点。子图可以创建 `dataTypeId: "any"` 的 `dynamic` 数据接口端口。在子接口节点或其父调用节点任一侧的第一次具体连接会把共享端口锁定为该 Data Type。只要任一侧存在连接，它就保持锁定，并在最后一条连接被移除后回到 `any`。动态端口在子接口与父调用节点两侧始终可见；编辑器以浅灰色渲染未锁定的 `any` 状态。

## 流程与数据连接

每条边都显式声明 `kind`：

- `flow` 定义执行顺序，可以成环。
- `data` 传递值，从不调度或排序节点执行。

每个端口声明稳定 ID、标签、种类、方向、可选的数据类型和可选的 `maxConnections`。子图数据接口可以额外声明 `dynamic: true`；流程接口与根 Graph 接口不能是动态的。其 Graph Type 还把 `portConnectionRules.input` 和 `.output` 声明为 `single` 或 `multiple`。生效的限制取更严格的结果：`single` 把该方向的连接数限制为一，而端口级上限可以进一步收紧但绝不会放宽。当用户对一个已被占用的单连接端口建立有效的新连接时，编辑器会以一个 Operation 批次提交旧边的移除与新边的添加。已达到容量上限的多连接端口仍会拒绝新连接，因为编辑器无法选择替换哪条已有边。校验要求输出到输入的方向、边与端口种类匹配、数据类型兼容、端点存在、连接唯一以及基数得到遵守。没有全局的环校验器；未来的项目专属校验器可以施加额外约束。

数据兼容性是整个注册表范围的规则，而不是按 Catalog 划分的规则。当不同 Catalog 的端口所对应的全局注册 Data Type 兼容时，它们可以连接。相同类型、`any`、在 `accepts` 中显式列出来源类型的目标类型，以及 `acceptsAnySource: true` 的目标类型是兼容的。该通配标志是方向性的，只放宽目标输入；它不会让该类型的输出可以赋给所有其他类型。`stringFromAny` 输入将该标志与字符串值属性搭配使用，因此其断开连接时的回退值按文本编辑，而连接可以提供任意 Data Type 以供运行时字符串转换。它仍然区别于普通 `string` 输入，后者只接受兼容的字符串来源。VisualBridge 不会插入隐式转换节点。Data Type 还可以声明可选的 `#RRGGBB` 展示颜色。颜色绝不影响 Graph 实例的兼容性或序列化；Catalog 未提供时，编辑器使用稳定的内置调色板。

Catalog 的 Data Type 保留运行时区别。C# `System.Int32` 与 `System.Single` 由各自独立的稳定 Data Type ID 表示（默认为 `int` 与 `float`），而不是共用一个 `number` 类型。数值属性仍使用 `valueType: "number"`，因为 JSON 只有一个数值标量类别；其 `dataTypeId` 携带 C# 语义类型。如果项目允许 C# 从 `int` 到 `float` 的放宽转换，`float` Data Type 就声明 `accepts: ["int"]`；反方向的连接仍不兼容，除非显式建模。

编辑器可以把一次连接当作节点创建手势。把未完成的边拖放到画布空白处时，会用相同的语义规则过滤新原子节点的端口，然后一并提交 `graph.addNode` 与 `graph.addEdge`。数据输入在连接期间保留其序列化字面量作为回退值；节点 UI 会把该字段标记为已覆盖，并在边被移除后恢复编辑。

可编辑的 C# `List<T>` 字段使用 `listPortMode: "list"` 或 `"element"` 的数据动态端口组。有序元素即使整个 List 是唯一端口，也会作为稳定 ID 的 `dynamicPorts` 条目持久化；因此重排顺序绝不改变元素的身份。整个 List 模式把组 ID 暴露为一个 `List<T>` 输入，其条目 ID 只是值。元素模式把每个条目 ID 暴露为一个 `T` 输入，不暴露组端口。已连接的整个 List 输入覆盖完整的字面量列表；已连接的元素输入只覆盖该元素。未配置的动态组保留其现有的动态分支/端口语义。

## Graph Catalog

一个 Graph 文档类型声明一个或多个相对项目路径的 `.vbgraphcatalog` 文件：

```json visualbridge-schema=visualbridge-project.schema.json#/properties/documentTypes/items
{
  "id": "logicGraph",
  "editor": "graph",
  "include": ["Graph/**/*.vbgraph"],
  "catalogs": [
    "Catalog/Common.vbgraphcatalog",
    "Catalog/Logic.vbgraphcatalog"
  ]
}
```

每个节点类型属于声明它的 Catalog 文件。注册表合并所有已加载的 Catalog，是 Graph Type、节点类型、端口、Data Type、属性、默认值、别名和跨 Catalog 引用的权威。Catalog 必填的 `title` 是其显示名，也是其自身节点的根路径。节点可选的 `menuPath` 在该根路径上扩展且绝不重复它；节点 `title` 是最后一个路径段。例如，Catalog `通用`、节点路径 `操作 / 整数` 与节点标题 `加法` 生成 `通用 / 操作 / 整数 / 加法`。分类、标签、能力特征、源码来源、描述和属性编辑器提示保持为可搜索的元数据。编辑器提示只影响呈现；声明的值类型仍是权威。

每个 Graph Catalog V4 还声明公共的顶层 `source` 状态。在 Unity 接入之前它可以显式为 `unknown`，或者携带最新/过期的外部源 SHA-256 元数据。Host 根据实际字节计算 Catalog 的 `contentHash`，并通过只读的 Catalog Browser 同时暴露两者；参见 [`ProjectCatalogManagement.md`](ProjectCatalogManagement.md)。

VS Code 与当前 MCP V2 适配器使用相同的解析器、注册表、Operation、校验器与序列化器。Catalog 文件是文本契约；当编辑必须在没有 Unity 的环境下可用时，应当将其提交入库。当前解析器只接受 Graph Catalog V4；V1-V3 以及旧有的属性级 `required` 方言会被拒绝，而不是被静默升级。这个开发基线有意移除不兼容的遗留解释，而不是同时维护两套字段模型。

Catalog 序列化是确定性的：无序的类型集合和身份别名会排序，defaults 中 JSON object 的键会规范化，输出以换行符结尾。端口、动态组和属性数组保留声明顺序，因为该顺序控制编辑器布局。这让未来的 Unity 导出器能够重新生成相同的文件而不产生噪声 diff，同时保留 C# 字段与分支顺序。

## Graph Type 与实例约束

每个 Graph Type 拥有稳定 ID 与别名、取值为 `root`、`subgraph` 或 `any` 的 `usage`、`supportedCatalogIds`、方向性连接规则、Graph 属性定义、允许节点选择器、直接节点数量约束、初始节点模板和子图策略。Catalog 支持范围是粗粒度的节点允许清单。`allowedNodeSelectors`（如果存在）是这些 Catalog 之内的第二层过滤。选择器可以匹配规范化或别名的节点类型 ID、任意列出的标签，以及全部列出的特征；选择器各维度之间按 AND 组合，而允许选择器列表之间按 OR 组合。初始节点和被显式引用的选择器节点必须属于受支持的 Catalog。

数量约束有自己的稳定 ID 与非负的 `minInstances`/`maxInstances`。它们只统计直接的类型化节点，绝不递归进子图。入口唯一性用普通的特征约束表达，例如 `traits: ["flow.entry"]` 且上下界都为一。初始模板必须满足所有最小值约束，使新建的根图与内嵌图从一开始就有效。移除、添加或替换节点不得违反边界；节点选择器还会隐藏已达到最大数量的类型。

Graph Type 的指派在当前编辑器中不可变。新文档选择一个与根图兼容的类型，类型化子图选择一个与内嵌兼容的类型。遗留的 V2 文档仍可作为无类型图读取，但任意类型迁移推迟到未来的无损转换工作流。

## 带类型的子图调用

子图节点除 `subgraphId` 外还可以携带自己的 `nodeTypeId`。该节点类型描述调用点属性、静态数据端口、动态数据端口组以及兼容的目标 Graph Type。子图仍是 `graphTypeId` 与公开接口端口的权威。生效的调用点端口是节点类型的静态/动态端口与子图接口的并集；身份不得冲突。

禁止静态的类型化子图流程端口。流程通过公开接口跨越子图边界，而调用节点的静态契约表示旧的 `TSubGraphNode<TData,TGraph>` 数据字段与端口。未知的调用类型保留其属性、连接与子图导航。

## 稳定的动态端口

节点类型可以声明 `dynamicPortGroups`。每个组定义连接契约、条目值契约、默认值、编辑器提示、别名和可选的条目上限。节点实例把其条目存储在 `dynamicPorts` 中：

```json visualbridge-schema=visualbridge-graph.schema.json#/$defs/dynamicPort
{
  "id": "choice_a",
  "groupId": "branches",
  "title": "Choice A",
  "value": 10
}
```

条目 `id` 就是实际的端点 `portId`，在条目重命名或重排时绝不改变。添加、更新、移除与重排都是原子 Graph Operation。移除条目会在同一撤销单元中显式移除其相连的边。组别名让生成的 Catalog 可以重命名其声明而不丢失既有条目。安全节点替换要求每个动态条目与连接在目标类型中保持有效。

## 安全的节点替换

节点类型在画布上仅用于显示。替换可从节点上下文菜单发起，且只列出无损候选。候选安全的条件是：

- 每个现有属性 ID 都存在且值类型兼容；
- 每个目标额外属性都有其声明的确定性默认值；
- 每个已连接的端口 ID 仍存在且种类与方向不变；
- 每个动态端口组、条目值、条目上限与实例端口契约保持兼容；
- 既有数据类型、基数和所有其他连接规则保持有效。
- 目标类型为当前 Graph Type 所允许，且替换不破坏任何节点数量约束。

`graph.replaceNodeType` 只更改稳定的类型契约并添加确定性默认值。它保留节点 ID、标题、位置、属性与连接，并作为一个 VS Code Undo/Redo 单元提交。VisualBridge 绝不在替换过程中静默丢弃属性或断开边。

## 编辑事务与瞬态

多选、视口、MiniMap 位置、菜单和剪贴板内容属于编辑器状态，绝不序列化进 `.vbgraph`。批量删除、粘贴、复制和由连接创建的节点会作为有序的 Graph Operation 批次提交，并在宿主创建单个 `WorkspaceEdit` 之前接受一次最终语义校验；因此 VS Code Undo/Redo 把每个手势视为一次文档编辑。

`graph.renameElement` 原子地重命名一个实例级的 `graph`、`node`、`interfacePort` 或 `dynamicPort` 稳定 ID。图重命名会更新 `rootGraphId` 与所有拥有的 `subgraphId`；节点重命名会更新匹配的边端点；接口端口重命名会同时更新子图接口端点和父级子图调用端点；动态端口重命名会更新其所属节点上的端点。该 Operation 拒绝冲突与不完整的所有者范围，然后运行与其他所有 Operation 相同的完整 Graph 校验。Catalog 类型 ID 与静态 Catalog 端口 ID 不是实例元素，不会由该 Operation 重命名。

剪贴板 V1 载荷包含所选的原子节点，以及两端点都在复制集合内的边。粘贴会分配新的稳定 ID 并重映射其内部端点。Graph Type 要求的单例节点和内嵌子图暂被排除，直到未来的载荷能够无歧义地保留所有权与必需实例语义。剪贴板输入被视为不可信，除非其格式、版本、标识符、JSON 值、节点与边在结构上有效，否则会被拒绝。

## 文档生命周期目标契约

剪贴板载荷不是整文档复制契约。在 Document Lifecycle V1 之下，Graph 生命周期动作使用共享的 [`DocumentLifecycle.md`](DocumentLifecycle.md) 服务：

- 路径移动保留完整的源字节、`documentId`、每个图/元素 ID 和每个 Reference 值。
- 整文档复制要求调用方在预览请求中为 `documentId`、每个 Graph、Node、Interface Port、Dynamic Port 和 Edge ID 提交完整的 `stableIdRemap`。适配器将其应用到 `rootGraphId`、拥有的 `subgraphId` 以及每个匹配的边端点。预览会校验并规范化该映射；应用绝不生成替换 ID。
- 安全删除计算完整的结构闭包。Node 闭包包括其动态端口、关联边和任何拥有的子图层级；接口或动态端口包括其关联边。根 Graph 只能随其 Document 一起移除，非根 Graph 通过拥有它的子图 Node 移除。
- Reference 覆盖必须完整，闭包之外的任何出现都不得解析或可能解析到闭包。结构删除之后，Graph Type 数量约束、子图所有权与完整 Graph 校验仍然适用。

`graph.removeNode`、`graph.removeInterfacePort` 与 `graph.removeDynamicPort` 是普通的单文件 Operation，可直接由编辑器与 MCP 提交，不依赖引用方文件的保存状态；被同文档字段引用的元素会被原子拒绝（`graph.removedElementReferenced`），跨文档悬空引用由持有方文档的 Reference 校验兜底。`graph.removeEdge` 同样是普通的 Graph Operation。

Lifecycle Delete 用 `kind: "graph.element"`、`graphId`、`elementKind` 与 `elementId` 标识 Graph 目标；Dynamic Port 还额外要求其所属的 `nodeId`。这些是来自当前读取结果的完整语义范围，不是显示名。删除完整的 Graph 文档则使用 `target.kind: "document"`。

## MCP V2 映射

Graph 使用统一的 MCP 工具，而不是 Graph 专属的顶层工具。`visualbridge_catalog` 读取/搜索 Data Type、Graph Type 与 Node Type 定义；Node Type 搜索接受 `selector.graphTypeId` 与 `selector.includeSubgraphNodeTypes`。`visualbridge_document` 读取/搜索/校验一个已声明的 Graph；实例搜索接受取值为 `graph`、`node`、`port`、`edge`、`field` 或 `all` 的 `selector.kind`。`visualbridge_apply_operations` 接受一个有序非空的 GraphOperation 数组，以及读取/校验返回的确切 `baseHash`。过期的 hash 或进行中的 Project Transaction 返回 `conflict`；解析器、Operation 或新引入的 Reference 错误返回 `invalid` 且不修改字节。持久化写入使用 `VisualBridgeMcp.md` 所述的共享可恢复 Project Transaction。

GraphOperation 的结构化字段如下；`node`、`subgraph`、`edge` 和 `port` 必须使用本文对应 Document 结构的完整对象，不能只传显示名：

| `type` | 必填字段 | 可选字段 |
| --- | --- | --- |
| `graph.renameElement` | `graphId`, `elementKind`, `elementId`, `newElementId` | dynamic port 时的 `nodeId` |
| `graph.addNode` | `graphId`, `node` | — |
| `graph.addSubgraph` | `graphId`, `node`, `subgraph` | — |
| `graph.removeNode` | `graphId`, `nodeId` | — |
| `graph.moveNode` | `graphId`, `nodeId`, `position: {x,y}` | — |
| `graph.updateNode` | `graphId`, `nodeId`, `title`, `properties` | — |
| `graph.replaceNodeType` | `graphId`, `nodeId`, `nodeTypeId` | — |
| `graph.addDynamicPort` | `graphId`, `nodeId`, `port` | — |
| `graph.updateDynamicPort` | `graphId`, `nodeId`, `portId`, `title`, `value` | — |
| `graph.removeDynamicPort` | `graphId`, `nodeId`, `portId` | — |
| `graph.reorderDynamicPorts` | `graphId`, `nodeId`, `portIds` | — |
| `graph.addEdge` | `graphId`, `edge` | — |
| `graph.removeEdge` | `graphId`, `edgeId` | — |
| `graph.assignType` | `graphId`, `graphTypeId` | — |
| `graph.updateGraph` | `graphId`, `title`, `properties` | — |
| `graph.addInterfacePort` | `graphId`, `port` | — |
| `graph.updateInterfacePort` | `graphId`, `portId`, `title` | — |
| `graph.removeInterfacePort` | `graphId`, `portId` | — |
| `graph.reorderInterfacePorts` | `graphId`, `portIds` | — |

Operation 中复用的完整对象结构如下。所有 ID 都是稳定 ID；`nodeTypeId`、`groupId` 和数据类型必须来自当前 Graph Type 允许的 Catalog 定义：

| 对象 | 必填字段 | 可选字段 |
| --- | --- | --- |
| `GraphAtomicNode` | `kind: "node"`, `id`, `nodeTypeId`, `title`, `position: {x,y}`, `properties`, `dynamicPorts` | — |
| `GraphSubgraphNode` | `kind: "subgraph"`, `id`, `subgraphId`, `title`, `position: {x,y}`, `properties`, `dynamicPorts` | `nodeTypeId` |
| `GraphDefinition` | `id`, `title`, `properties`, `interfacePorts`, `nodes`, `edges` | `graphTypeId` |
| `GraphDynamicPort` | `id`, `groupId`, `title`, `value` | — |
| `GraphEdge` | `id`, `kind: "flow" \| "data"`, `source`, `target` | — |
| node endpoint | `kind: "node"`, `nodeId`, `portId` | — |
| interface endpoint | `kind: "interface"`, `portId` | — |
| `GraphInterfacePort` | `id`, `title`, `kind`, `direction: "input" \| "output"` | `dataTypeId`, `maxConnections`, `dynamic` |

`properties` 是 JSON object，`dynamicPorts`、`interfacePorts`、`nodes` 和 `edges` 即使为空也必须显式传数组。`graph.addSubgraph` 的 `node.subgraphId` 必须等于 `subgraph.id`，并且两个对象在同一 Operation 中原子加入。

## 自动化语义基线

`TestData/GraphSemanticProject` 是签入仓库的 Graph 语义测试夹具，由 Core 测试与 stdio MCP 集成测试共享。它的三个 Catalog 和一个 Graph 覆盖 Registry 身份与别名、受支持 Catalog 与选择器过滤、方向性的流程/数据基数、`int`/`float`/`any`/`stringFromAny` 兼容性、两种 `List<T>` 端口模式、动态子图接口锁定、声明式 Reference、无损节点替换、稳定的元素重命名传播、原子 Operation 批次以及确定性的 Graph/Catalog 序列化。

Graph 包使用 Node 内置的测试运行器，不包含 Unity 测试。`npm test` 先运行这套语义测试套件，然后针对同一 Authoring Project 的临时副本启动真实的 MCP stdio 服务器。集成测试证明：过期的 hash 会被拒绝且不修改文件，有效的 GraphOperation 批次会被原子持久化，而后续某个 Operation 失败时整个批次都不会被应用。
