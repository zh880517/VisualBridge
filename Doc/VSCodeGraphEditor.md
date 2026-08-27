# VisualBridge Graph V1

Graph V1 是 VisualBridge 首个可编辑 Document Type，只覆盖通用图结构与 VS Code 编辑闭环，不包含 Unity、Catalog、运行时连接和项目业务规则。

## 工程声明

Authoring Project 通过 `VisualBridge.project.vbjson` 启用 Graph 编辑器：

```json
{
  "formatVersion": 1,
  "projectId": "ExampleGame",
  "documentRoots": ["Graph"],
  "documentTypes": [
    {
      "id": "logicGraph",
      "editor": "graph",
      "include": ["Graph/**/*.vbgraph"],
      "exclude": []
    }
  ]
}
```

插件只会为有效 ProjectContext 中、匹配上述规则的文件创建 Graph Editor。可以执行 `VisualBridge: Create Graph Document` 创建空文档。

## 文档格式

`.vbgraph` 是 JSON 文本文件。V1 顶层包含 `formatVersion`、`documentId`、`nodes` 和 `edges`。节点包含稳定 ID、类型、标题、坐标和自由 JSON 属性；连线使用节点 ID 与端口 ID 表达端点。

```json
{
  "formatVersion": 1,
  "documentId": "example_graph",
  "nodes": [],
  "edges": []
}
```

序列化会按元素 ID 和属性键稳定排序。未知结构、重复 ID、无效坐标和指向不存在节点的连线会产生诊断。

## 当前编辑能力

- 新增、选择、拖动和删除节点。
- 编辑节点标题、类型和 JSON 属性。
- 从输出端口连接到输入端口，选择和删除连线。
- 每次操作通过 Graph Operation 进入 Core，再通过 `WorkspaceEdit` 更新文本，因此支持 VS Code Undo/Redo 和脏状态。
- 检测到磁盘外部修改后，要求选择覆盖，或放弃本地修改并刷新；取消时不执行当前操作。

V1 固定提供 `input` 和 `output` 两个通用端口，不限制节点类型、自连接、重复语义连接、环或属性内容。后续业务规则应通过 Validator 和 Document Type 扩展加入。

## Webview 实现

Graph Canvas 使用 React 和 React Flow。`Editors/Graph/` 将 TSX 构建为独立的 `graphEditor.js` 与 `graphEditor.css`，VS Code 扩展在构建时把产物复制到自身的 `dist/webview/`，并通过受限的 Webview 本地资源 URI 加载。

React Flow 采用受控模式：节点和连线由当前 Graph Document 派生，选择、视口以及拖动中的坐标属于临时视图状态。新增、删除、连接和 Inspector 修改必须发送 Graph Operation；拖动只在结束时发送一次 `graph.moveNode`。React Flow 自身的数据结构和视口状态不写入 `.vbgraph`。

未来运行时调试状态同样作为临时 Overlay 叠加到 React Flow 节点和连线上，不改变 Graph Document。本版本尚未接入调试通信。
