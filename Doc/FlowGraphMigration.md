# ActionEditor FlowGraph 迁移设计

## 范围

本文记录 ActionEditor `Packages/com.kyle.action-framework/FlowGraph` 向 VisualBridge Graph 的功能映射和实施边界。当前只开发宿主无关的文档模型、Catalog、VS Code 编辑器与 MCP 共用能力；Unity Package 的代码扫描、Catalog 导出、运行时编译和调试连接暂不实现。

## 旧节点定义模型

旧 FlowGraph 的节点由三层组成：

```text
可序列化数据 struct
  -> TFlowNode<TData> Unity 子资产包装类
  -> Executor<TData, RuntimeData, Context> 运行时行为
```

数据 struct 是节点编辑契约的主要来源：

- 实现 `IFlowInputable`、`IFlowOutputable`、`IFlowConditionable`、`IFlowDynamicOutputable`、`IFlowUpdateable`、`IFlowDataProvider` 或 `IFlowEntry`，声明控制流和执行特征。
- `[FlowTag]` 通过 struct 实现的接口提供节点分组；Graph 上的 `[FlowGraphTags]` 决定允许的分组。
- `[FlowNodePath]` 定义创建菜单路径，`[Alias]` 定义显示名称。
- `[Inputable] public T Field` 同时是可编辑字段和数据输入端口；`OutputData<T>` 是数据输出端口。
- `[DynamicOutput] List<T>` 产生实例级动态流程输出。
- `[FormerlySerializedAs]` 为输入、输出字段提供旧名称修复。

类型发现链为 `TypeCollector -> FlowNodeTypeCollector -> FlowTypeSelectWindow -> FlowGraphView.OnNodeCreate`。旧系统通过包装脚本的 Unity GUID 保持资产类型引用，通过 `FlowNode.UID` 标识节点实例，通过 `FlowDataEdge.EdgeID` 标识数据边。它没有显式稳定的节点类型 ID；动态输出也使用可变数组索引，因此这两点不能原样迁移。

## VisualBridge Catalog 映射

Unity Package 未来应把 C# 声明导出为 `.vbgraphcatalog`，Catalog 是代码声明的编辑契约，而不是 Unity 序列化快照：

| VisualBridge 字段 | C# 来源 |
| --- | --- |
| `nodeType.id` | 新增的显式稳定 ID；不得直接使用 C# 全名 |
| `nodeType.aliases` | 历史稳定类型 ID；`[Alias]` 不是身份别名 |
| `title` | `[Alias]` 或类型/字段显示名 |
| `category`、`menuPath` | `[FlowNodePath]` |
| `tags` | `[FlowTag]` 与 Graph 可用 Tag |
| `traits` | 节点能力接口组合 |
| `source` | 程序集、数据类型和包装类型，仅用于诊断及导出追踪 |
| `ports` | 控制流接口、`[Inputable]`、`OutputData<T>` |
| `port.aliases` | `[FormerlySerializedAs]` 或显式成员旧 ID |
| `properties` | 可编辑的 public 实例字段 |
| `property.aliases` | 字段旧 ID |
| `property.editor` | enum、multiline、range、readonly、引用等显示提示 |

过渡导出器可用 `assembly + dataType.FullName` 产生派生 ID，但必须报告不稳定 ID 诊断。默认值只能来自确定性声明或 `default(T)`；不能为了导出 Catalog 自动执行可能带副作用的 `OnCreate()`。

动态端口必须改成实例级稳定 ID。Catalog 只声明动态端口组模板，`.vbgraph` 节点保存带独立 ID 的端口项；排序不能改变连线身份。旧系统以列表索引改写边的行为只用于旧资产导入，不进入新格式。

## 功能对照

| 功能 | VisualBridge 当前状态 | 后续动作 |
| --- | --- | --- |
| Flow/Data 分离、允许环路 | 已完成 | 保持现有语义 |
| 稳定节点/边/端口身份 | 已完成 | 类型、端口和字段旧 ID 已进入统一解析 |
| Catalog 节点搜索与创建 | 已完成 | 支持菜单路径、Tag、Trait 和来源元数据搜索 |
| 节点字段内联编辑 | 已完成 | 支持 select、multiline、range、readonly 等显示提示 |
| 节点类型安全替换、未知类型保留 | 已完成 | 校验与替换规则识别成员别名 |
| 子图公开接口和内嵌导航 | 已完成 | typed subgraph 同时保留调用节点类型和目标 Graph Type；Inspector 不提供接口管理 |
| Graph Inspector | 已完成 | 仅编辑 Graph 名称和 Graph Type 字段，不暴露原始 JSON |
| 入口唯一性、节点数量规则 | 已完成 | 通用 selector + min/max，创建时生成初始节点 |
| 实例级动态输出 | 已完成 | Catalog 组模板 + 实例稳定 ID + 原子增删改排序 |
| 多选、复制、粘贴、Duplicate | 已完成 | 原子节点和内部边以批量 Operation 粘贴并生成新 ID；必需单例和子图暂不复制 |
| 输入接线后默认值状态 | 已完成 | 字段与输入端口同排；连接后隐藏编辑器并保留字面值，断开后恢复编辑 |
| 分层菜单、同类型选择、MiniMap | 已完成 | `menuPath` 分层、全文搜索、规范类型同选和缩略图导航已落地 |
| 悬空连线创建节点 | 已完成 | 按方向、端口种类、数据类型和 Graph Type 约束筛选并原子创建 |
| C# Catalog 导出 | 缺失 | 最终在 Unity Package Editor 程序集中实现 |
| Runtime、代码生成、执行预算、调试追踪 | 延期 | 等 Unity 连接阶段单独设计 |

## 实施顺序

1. 已完成 Catalog 来源、Tag、Trait、菜单路径、成员别名和字段编辑提示；解析、验证、连线及替换逻辑使用语义身份。
2. 已完成 Graph Type、入口/实例数量约束及 typed subgraph 契约；根图和子图具有独立类型，调用节点保留静态字段与数据端口。
3. 已完成实例级动态端口组、稳定端口项和原子增删排序操作；排序不再改写连线身份。
4. 已完成连接覆盖状态、批量选择、复制粘贴与 Duplicate；持久修改继续通过 Graph Operation 批量提交。
5. 已完成分层创建菜单、悬空连线创建、同类型选择和 MiniMap。
6. Graph 作者功能验证完成后，再在 `Packages/com.kyl.visualbridge` 中实现 C# Catalog Exporter 与旧 FlowGraph 导入诊断；此前不得加入 Unity 实现。
7. 最后设计 Runtime Compiler、执行协议和 Debug Overlay。

Unity 导出器必须只依赖 Protocol/Catalog 契约，输出确定性 JSON；VS Code、MCP 与未来 Unity 编译器继续共享同一套稳定 ID、连接和属性规则。

Unity 侧后续导出约束：Graph/Node Type 都必须使用显式稳定 ID，C# 全名只进入 `source`；`[FlowGraphTags]` 导出为允许节点 selector；`IFlowEntry` 导出 trait、数量约束和初始节点；`TSubGraphNode<TData,TGraph>` 导出为带 `subgraph.graphTypeIds` 的调用节点类型。不得执行 `OnCreate()` 取默认值，且新 exporter 不得覆盖更高版本 Catalog。Unity 代码、测试、导入器与运行时实现均在 Graph 作者功能完成并单独确认后开始。
