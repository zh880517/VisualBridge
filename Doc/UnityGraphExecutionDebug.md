# Unity Graph 执行过程调试接入指南

## 1. 文档定位

本文是**游戏侧引擎**接入 VisualBridge Graph 执行观察链路的操作指南：如何把引擎的图执行事件转发到 VisualBridge 采集门面，以及稳定 ID 映射规则。设计语义（范围裁决、事件模型、订阅与权限）冻结在 [`UnityIntegrationArchitecture.md`](UnityIntegrationArchitecture.md) 第 19 章；协议契约见 [`ProtocolContracts.md`](ProtocolContracts.md) 的 `visualbridge-runtime-bridge` 条目。VS Code 侧页面交互已实现（Graph 编辑器「执行调试」入口：实例选择、实时高亮/边流光/值显示与时间轴回放），其交互语义见同章 §19.5。

链路全景：游戏引擎执行图 → 引擎 debug provider 适配器转发 → `VisualBridgeGraphExecutionCapture` 采集门面（分配执行实例 ID、维护实例注册表、按订阅缓冲事件）→ Runtime Bridge 协议（`graphExecution` 批量事件）→ VS Code Graph 页面实时跟踪与回放。**只观察、不做断点**；执行引擎归游戏侧，VisualBridge 不实现节点调度或求值。

## 2. 前置条件：稳定 ID 映射

- `.vbflow` 图文档是唯一创作源。Graph 编译产物（`Library/VisualBridge/Compiled`，Play 模式经 Runtime ArtifactStore 加载）中每个节点携带 VisualBridge 文档的**稳定节点 ID**。
- 游戏侧导入器（把编译产物转成游戏执行数据）**必须**把该稳定 ID 带入运行时数据的节点 UID 表（等价于 FlowGraph 参考实现的 `NodeUIDs`：`NodeID -> NodeUID` 映射，注释即「用于调试器显示」）。
- 转发事件时，节点参数一律使用稳定节点 ID（即 UID 表中的 UID），**不得**使用节点列表下标等重排后会漂移的临时 ID；否则 VS Code 页面无法点亮对应节点。
- 执行实例身份由 VisualBridge 分配（`exec-<n>`），游戏侧不自造执行 ID 体系；游戏侧自己的执行者标识（哪个角色在跑，如参考实现的 `debugKey`）作为 `debugKey` 原样上报。

## 3. 采集门面 API

`VisualBridge.Runtime.VisualBridgeGraphExecutionCapture`（静态类，线程安全，无 Unity API 依赖）：

| 方法 | 语义 |
| --- | --- |
| `OnInstanceStarted(documentTypeId, documentId, graphName, debugKey, out executionId)` | 执行实例开始。返回 `false` 表示未在追踪（Runtime Bridge 服务端未运行），调用方应忽略后续事件。生命周期追踪在服务端运行期间常开——实例列表无需订阅即可查询。 |
| `OnInstanceStopped(executionId)` | 实例停止；实例从注册表移除，订阅者收到 `instanceStopped` 后订阅自动失效。 |
| `OnNodeStart(executionId, nodeStableId, frameIndex)` | 节点开始执行。 |
| `OnNodeOutput(executionId, nodeStableId, outputIndex, frameIndex)` | 节点输出端口触发。 |
| `OnDataNode(executionId, nodeStableId, frameIndex)` | 数据节点执行。 |
| `OnEdgeValueChanged(executionId, nodeStableId, outputIndex, value, frameIndex)` | 数据边值变化；`value` 为引擎侧字符串化结果（上限 4096 字符，超长自行截断）。 |
| `IsTracking` / `IsSubscribed` | 服务端是否在追踪 / 当前是否有订阅者（诊断用）。 |

开销语义：**无订阅者时全部节点级方法走零分配快速路径直接返回**（不必编译宏，无需重编译开关）；只有实例起止（低频）在无订阅时仍登记注册表。每条事件携带引擎 `frameIndex`（帧号逐条携带，VS Code 侧支持事件级/帧级回放步进）。

## 4. 适配器示例

以参考实现（ActionEditor FlowGraph）的 provider 模式为例：引擎侧已有 `IFlowDebugerProvider` 风格的插桩缝时，写一个小适配器把事件转发到门面，引擎本体与 VisualBridge 互不引用：

```csharp
using VisualBridge.Runtime;

// 游戏侧实现：注册为引擎的 debug provider。
public sealed class VisualBridgeFlowDebugProvider : IFlowDebugerProvider
{
    public FlowRuntimeDebuger Create(string scriptName, string key)
    {
        // documentTypeId/documentId 来自游戏侧导入器加载的图文档身份。
        return VisualBridgeGraphExecutionCapture.OnInstanceStarted(
            DocumentTypeId, DocumentId, scriptName, key, out var executionId)
            ? new VisualBridgeFlowDebuger(executionId)
            : null;
    }

    public void OnStop(FlowRuntimeDebuger debuger) { /* 见下 */ }
}

public sealed class VisualBridgeFlowDebuger : FlowRuntimeDebuger
{
    private readonly string executionId;
    public VisualBridgeFlowDebuger(string executionId) { this.executionId = executionId; }

    protected override void OnNodeData(FlowDebugNodeData data)
    {
        switch (data.Type)
        {
            case FlowDebugNodeType.Execute:
                VisualBridgeGraphExecutionCapture.OnNodeStart(executionId, ResolveNodeUid(data.NodeID), data.FrameIndex);
                break;
            case FlowDebugNodeType.Output:
                VisualBridgeGraphExecutionCapture.OnNodeOutput(executionId, ResolveNodeUid(data.NodeID), data.OutputIndex, data.FrameIndex);
                break;
            case FlowDebugNodeType.ExecuteDataNode:
                VisualBridgeGraphExecutionCapture.OnDataNode(executionId, ResolveNodeUid(data.NodeID), data.FrameIndex);
                break;
            case FlowDebugNodeType.OutputValue:
                VisualBridgeGraphExecutionCapture.OnEdgeValueChanged(
                    executionId, ResolveNodeUid((int)(data.EdgeID >> 32)), (int)(data.EdgeID & uint.MaxValue), data.OutputValue, data.FrameIndex);
                break;
        }
    }
}
```

要点：

- `ResolveNodeUid` 是游戏侧 UID 表反查（运行时 NodeID → VisualBridge 稳定节点 ID），映射表由导入器在加载时建立。
- 实例停止转发 `OnInstanceStopped(executionId)`（引擎 `Stop()`/provider `OnStop` 处）。
- 事件上报的时机与粒度由引擎插桩点决定；VisualBridge 只做透传，不改写顺序。

## 5. 订阅与事件流模型（游戏侧无需实现，仅供理解）

- VS Code 通过 `getGraphExecutionInstances`（可按 `documentId` 过滤）列活跃实例 → `subscribeGraphExecution` 订阅单个实例 → `getGraphExecutionSnapshot` 取浅快照（当前节点 + 运行状态；无订阅期间当前节点不更新）。
- 事件按「满 64 条或 100ms」批量冲刷（`graphExecution` 消息，载荷非空）；不同帧送达是设计允许的。
- 观察者语义不占租约：多个客户端可并行观察同一实例，与 DAP 检查会话、MCP 工具互不影响。
- 退订/断开即停录：最后一个订阅者退出后节点事件不再进缓冲（缓冲清空），实例注册表保留至实例停止。

## 6. 验证与已知边界

- 门面与服务端转发有 EditMode 全量覆盖（实例生命周期、无订阅快速路径、批量冲刷、64 条提前冲刷、实例停止清除订阅与快照、documentId 过滤、多客户端观察）。
- 待发缓冲上限 16384 条：执行泵滞后时丢弃最旧事件，防无界内存增长。
- mid-play domain reload 窗口内新旧服务端短暂共存时共享进程级采集门面，事件由先冲刷的泵投递（窗口极短；发现记录的 generation/心跳语义不受影响）。
- `ScriptableObject` 排除条款与单一权威源原则对本链路同样适用：执行观察不写回任何 Authoring 数据。
