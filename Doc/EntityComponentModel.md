# Entity / Component 编辑模型

## 文档定位

本文定义 VisualBridge 当前落地的 Entity / Component JSON 模型、共享字段约束和 VS Code 编辑行为。它参考了 ActionEditor EasyConfig Entity 编辑器的组织方式，但不迁移其 `ScriptableObject`、子资源、包装类或导出按钮。

当前实现只负责离线 Authoring JSON、Catalog、语义校验、确定性 Operation 和 VS Code 可视化编辑。Unity Catalog Exporter、Importer、Runtime、Debug 和任何 `ScriptableObject` 兼容层都不在本阶段范围内。

## 数据所有权

正式游戏项目只定义运行时实际使用的 C# 结构，例如 Entity 根结构、Component 结构和普通自定义结构体。VisualBridge JSON 是这些配置的权威编辑源，目标是替代以 `ScriptableObject` Inspector 保存配置的工作流，而不是再生成一层用于编辑的 `ScriptableObject`。

```text
游戏运行时 C# 结构
  -> 后续 Unity Catalog Exporter 生成描述
  -> Entity Catalog
  -> VS Code / MCP 编辑 Entity Document
  -> 后续 Importer / Compiler 生成运行时所需数据
```

Authoring Document 不保存 Unity 对象实例、子资源关系、Inspector 展开状态或临时菜单状态。Catalog 中可保留 `source.providerId` 和 `source.typeName` 便于追踪来源，但 C# 类型名不承担持久身份。

## 编辑器大类、项目子类与文件扩展名

VisualBridge 插件按少量稳定的编辑器大类注册能力。当前大类包括 `graph` 和 `entity`，后续可以增加 `table` 等大类。项目通过 `documentTypes` 声明业务子类：

- `documentTypes[].editor` 选择编辑器大类，例如 `entity`。
- `documentTypes[].id` 是项目内稳定的业务子类 ID，例如 `hero-config`、`monster-config`。
- `include` / `exclude` 决定该子类实际包含哪些文件。
- `catalogs` 决定该子类使用哪些 Catalog。
- 文件扩展名不是编辑器类型标识，也不要求使用 VisualBridge 预设后缀。
- 同一个实际文件必须只匹配一个 Document Type；项目应使用更具体的 `include` 或 `exclude` 消除子类重叠，不依赖声明顺序决定类型。

例如，同一个 Entity 编辑器可以处理项目自定义的 `.herojson` 和 `.monsterdata`：

```json
{
  "formatVersion": 1,
  "projectId": "game.authoring",
  "documentRoots": ["Config"],
  "documentTypes": [
    {
      "id": "hero-config",
      "editor": "entity",
      "include": ["Config/Heroes/**/*.herojson"],
      "exclude": [],
      "catalogs": ["Catalog/Common.vbentitycatalog", "Catalog/Hero.vbentitycatalog"]
    },
    {
      "id": "monster-config",
      "editor": "entity",
      "include": ["Config/Monsters/**/*.monsterdata"],
      "exclude": ["Config/Monsters/Generated/**"],
      "catalogs": ["Catalog/Common.vbentitycatalog", "Catalog/Monster.vbentitycatalog"]
    }
  ]
}
```

插件打开文件时始终由 Project Registry 先按所属 Project、`include` 和 `exclude` 解析唯一 Document Type，再按其 `editor` 路由到对应模块。`.vbgraph` 和 `.vbentity` 只作为开箱即用的默认关联；它们不是业务判断条件。VS Code 的 Custom Editor 文件选择器来自静态扩展清单，不能直接从每个 Project File 动态增加后缀，因此项目自定义后缀通过 Explorer 的 `VisualBridge: Open Document`、命令面板或工作区级编辑器关联打开。创建 Graph / Entity 文档时，插件会从所选业务子类的第一个可解析 `include` 推导目录和扩展名，并在写入前再次用 Project Registry 校验目标路径。

## Entity Catalog V1

Entity Catalog 使用 JSON，默认便利后缀为 `.vbentitycatalog`。一个 Entity Document Type 可以按 Project File 声明顺序加载多个 Catalog，并建立 Registry。Registry 在所有 Catalog 间校验稳定身份和跨 Catalog 引用，不依赖加载顺序解决冲突。

Catalog 顶层结构：

```json
{
  "formatVersion": 1,
  "catalogId": "game.entity.gameplay",
  "title": "Gameplay",
  "componentGroups": [],
  "entityTypes": [],
  "componentTypes": []
}
```

### Component Group

Component Group 表达 Entity 类型允许挂载的组件大组，等价于旧编辑器中用于组织组件菜单和限制 Entity 种类的分组概念：

```json
{
  "id": "game.group.combat",
  "title": "Combat",
  "aliases": ["legacy.group.combat"]
}
```

`id` 和 `aliases` 在整个 Registry 的 Group 身份命名空间中必须无歧义。显示标题可以修改，不能替代稳定 ID。

### Entity Type

Entity Type 描述一类根配置结构以及它允许的 Component Group：

```json
{
  "id": "game.entity.player",
  "title": "Player",
  "aliases": [],
  "description": "Player runtime configuration.",
  "allowedComponentGroupIds": [
    "game.group.combat",
    "game.group.movement"
  ],
  "properties": []
}
```

`allowedComponentGroupIds` 可以引用其他 Catalog 中的规范 ID 或 alias。Entity Document 创建后锁定 `entityTypeId`；当前编辑器不提供任意切换 Entity Type 的入口，避免静默丢失根字段或组件。

### Component Type

Component Type 描述可添加到 Entity 的运行时组件结构：

```json
{
  "id": "game.component.health",
  "title": "Health",
  "aliases": ["legacy.component.health"],
  "groupId": "game.group.combat",
  "menuPath": ["Attributes"],
  "source": {
    "providerId": "csharp",
    "typeName": "Game.HealthComponent"
  },
  "properties": []
}
```

组件添加菜单按 Catalog 标题、Group 标题、`menuPath` 和 Component 标题组织。`source` 只用于诊断和导航。规范 `id` 与 alias 必须在整个 Registry 的 Component Type 身份命名空间中无歧义。

## 全项目共享字段模型

字段不是 Entity 私有能力。`Core/Form` 定义宿主无关的字段语义，`Editors/Form` 提供可复用 React 控件；Entity 是当前第一个完整使用者。Graph 属性、Structured Document、Table 单元格和后续自定义结构编辑应逐步复用同一字段定义、校验和 UI 组件，不各自实现数值、颜色或普通自定义结构体编辑规则。

字段定义包含：

- `id`：稳定字段 ID。
- `aliases`：旧字段 ID，用于兼容重命名。
- `title` / `description`：显示信息。
- `valueType`：JSON 形态，取值为 `string`、`number`、`boolean`、`object`、`array` 或 `json`。
- `dataTypeId`：运行时语义类型，例如 `int`、`float`、`color`、`Game.SpawnSettings`。
- `defaultValue`：创建实例时使用的完整 JSON 默认值。
- `editor`：通用控件提示。
- `reference`：可选的统一引用 kind、结构化 target 与缺失策略。
- `fields`：`object` 的递归子字段。
- `item`：`array` 的递归元素定义。

`valueType` 只描述 JSON 存储形态，不能抹平运行时类型。例如 C# `int` 和 `float` 都存为 JSON number，但 `dataTypeId` 必须继续分别为 `int` 和 `float`，且 `int` 使用 `editor.integer: true`。

### 数值

```json
{
  "id": "level",
  "title": "Level",
  "aliases": [],
  "valueType": "number",
  "dataTypeId": "int",
  "defaultValue": 1,
  "editor": {
    "kind": "number",
    "readOnly": false,
    "integer": true,
    "min": 1,
    "step": 1
  }
}
```

通用校验会检查有限数值、整数约束、最小值、最大值和步进定义。

### 颜色

```json
{
  "id": "tint",
  "title": "Tint",
  "aliases": [],
  "valueType": "string",
  "dataTypeId": "color",
  "defaultValue": "#FFFFFFFF",
  "editor": {
    "kind": "color",
    "readOnly": false,
    "integer": false
  }
}
```

颜色使用 `#RRGGBB` 或 `#RRGGBBAA`。表单同时提供颜色选择和十六进制文本编辑。

### 非框架自定义结构

普通游戏结构体使用递归 `object` 描述，不要求继承 VisualBridge 类型：

```json
{
  "id": "spawn",
  "title": "Spawn",
  "aliases": [],
  "valueType": "object",
  "dataTypeId": "Game.SpawnSettings",
  "defaultValue": {
    "position": {
      "x": 0,
      "y": 0,
      "z": 0
    }
  },
  "fields": [
    {
      "id": "position",
      "title": "Position",
      "aliases": [],
      "valueType": "object",
      "dataTypeId": "UnityEngine.Vector3",
      "defaultValue": { "x": 0, "y": 0, "z": 0 },
      "fields": []
    }
  ]
}
```

实际 Catalog 中 `position.fields` 继续声明 `x`、`y`、`z`。对象和数组可以递归组合；数组通过 `item` 描述元素，并由共享表单提供新增、删除和排序。

Entity、Structured 和 Table Document 的字段 List 共享同一个编辑器和样式，不得按 Document Type 复制实现。每个元素右侧使用同一组功能图标：拖拽手柄负责排序，添加按钮在当前元素后插入默认值，删除按钮移除当前元素；空 List 保留唯一的添加入口。拖拽由 dnd-kit Sortable 负责鼠标、触摸和键盘交互，完成时仍只提交一次完整字段值，继续经过所属 Document 的 Operation、Undo/Redo 与校验流程。

### 通用编辑器种类

当前共享字段编辑器支持：

- `text`、`multiline` 和 `color`：字符串。
- `reference`：字符串或数值稳定键，由字段的 `reference` 契约选择、解析、校验和跳转目标。
- `number`：数值，可附带整数和范围提示。
- `checkbox`：布尔值。
- `select`：使用结构化 `options` 值。
- `json`：任意 JSON 值。
- 没有显式 `editor` 时按 `valueType` 选择默认控件。

Catalog Parser 会拒绝控件与 JSON 形态不兼容、数组缺少 `item`、对象缺少 `fields`、默认值类型错误和同级字段身份冲突。

Entity 根字段与每个 Component 字段都会递归收集引用。`table.row` 可将普通 C# `int`/`string` ID 字段指向项目表格记录；`entity.component` 可将字符串字段指向同一 Project Document Type 下的稳定 Component 实例 ID。后者的 target 只保存 `documentTypeId`，完整 `documentId` / `componentId` 由 Provider Location 返回；跨文档同 ID 会明确歧义。VS Code 使用原生候选列表，可精确打开并展开、高亮 Component 卡片；Entity Operation 若新引入缺失、歧义或无效 target 会被原子拒绝。引用的完整跨文档契约见 `ReferenceSystem.md`。

## Entity Document V1

Entity Document 使用 JSON，默认便利后缀为 `.vbentity`；项目可以通过 `include` 改成任意扩展名。

```json
{
  "formatVersion": 1,
  "documentId": "game.player.default",
  "entityTypeId": "game.entity.player",
  "title": "Default Player",
  "properties": {},
  "components": [
    {
      "id": "health",
      "componentTypeId": "game.component.health",
      "enabled": true,
      "properties": {}
    }
  ]
}
```

- `documentId` 是文件内容身份，不等于文件路径。
- `entityTypeId` 解析为 Registry 中的规范 ID 或 alias。
- `properties` 保存 Entity 根字段值。
- `components` 是有序组件实例数组。
- Component 实例 `id` 在当前文档中唯一，排序不改变其身份。
- `componentTypeId` 决定字段结构和所属 Group。
- `enabled` 是实例状态，不影响类型合法性。
- 未知 Component Type 的实例和值完整保留并给出 warning，避免 Catalog 暂时缺失时丢数据。
- 已知但不被当前 Entity Type 允许的 Component Type 是 error。

Serializer 固定顶层字段顺序，按字段键确定性排序，并保留 Component 用户顺序。

## Entity Operation

所有持久修改通过 Entity Operation 完成：

- `entity.setTitle`
- `entity.setProperty`
- `entity.addComponent`
- `entity.renameComponent`
- `entity.removeComponent`
- `entity.moveComponent`
- `entity.setComponentEnabled`
- `entity.setComponentProperty`
- `entity.duplicateComponent`

一批 Operation 先在副本上完整执行和校验。任一操作失败或引入新的语义 error 时，整批拒绝且原文档不变。添加 Component 会从 Catalog 字段创建默认属性；复制 Component 使用新的实例 ID 并深复制 JSON 值；项目级 Component 重命名通过 `entity.renameComponent` 修改目标实例，再由统一重构计划更新所有解析到该完整位置的引用。

## VS Code 编辑器

当前 Entity Webview 提供：

- Entity 标题、类型和根字段编辑。
- Component 卡片折叠、启用开关、复制，以及共享列表风格的拖拽排序、在后添加和删除操作组。
- 按 Catalog / Group / 菜单路径组织的可搜索 Add Component 对话框。
- 数值、颜色、选择项、普通对象和 List 的共享字段控件。
- 未知 Component Type 的只读 JSON 展示与原样保留。
- VS Code Problems 诊断、文本 Document 脏状态、Save 和 Undo/Redo。
- 外部磁盘修改检测；覆盖或放弃刷新由用户明确选择。
- 引用跳转按完整 Location 打开所属 Entity，展开、滚动聚焦并临时高亮目标 Component；陈旧文档或缺失组件不会按同名猜测。

Webview 只发送 Operation，不直接读写文件。Extension Host 使用 `WorkspaceEdit` 修改当前文本 Document，因此正常 VS Code Save、Undo 和 Redo 仍然有效。编辑器没有 Export 按钮；Authoring JSON 本身就是需要保存和提交的源文件。

## 后续 Unity 约束

后续实现 Unity Catalog Exporter 时必须遵守：

- 只扫描游戏运行时真正使用的普通 class / struct 和显式元数据。
- 不要求类型继承 `ScriptableObject`，不生成用于编辑的 `ScriptableObject` 包装资产或子资源。
- 为 Entity Type、Component Group、Component Type 和每个递归字段输出显式稳定 ID 与 alias；C# 全名只写入 `source`。
- 将 C# `int`、`float`、颜色、List 和普通自定义结构递归映射为共享字段模型，不能在 Entity 模块复制一套字段规则。
- 确定性生成 Catalog，不通过执行业务初始化方法或临时 Unity 对象猜测默认值。
- Importer / Compiler 的产物是派生数据，不能反向成为权威编辑源。
- Unity Runtime、Debug 和导入编译协议在正式设计后单独实现；当前代码不预留半成品运行路径。

固定语义样例位于 `TestData/EntitySemanticProject`。它使用项目自定义 `.herojson` 后缀，并覆盖多 Catalog Registry、稳定 ID / alias、跨 Catalog Group 引用、Entity Component 引用、数值、颜色、递归对象、List、组件限制、启用状态、Operation 原子性和确定性序列化。
