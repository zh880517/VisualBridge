# Unity Graph 执行过程调试接入指南

## 0. 迁移状态

协议正在从 `graphExecution` 字符串事件批量上报迁移到接口式调试通道（`VisualBridge.Debug` + 生成契约）。迁移分阶段：

- **阶段 U（已完成）**：Unity 侧契约特性、`VisualBridgeDebug` 运行时门面、`NdjsonFramer` 成帧、代码生成器与启动策略。阶段 U 不包含 VS Code 对新通道的消费（阶段 C，消费侧；区别于远程连接的阶段 C）与两端连接/传输（阶段 T）。
- **阶段 C / T（未实现）**：VS Code 对新通道的消费与传输接入。当前 `VisualBridgeDebug.StartTransport()` 只挂载 `NullDebugTransport`，`isConnected` 恒为 `false`；插桩代码可以先行落地，但不会发出数据。
- **旧路径（本文 §1–§6）**：`VisualBridgeGraphExecutionCapture`、`graphExecution` 消息、`getGraphExecutionInstances` / `subscribeGraphExecution` / `unsubscribeGraphExecution` / `getGraphExecutionSnapshot` 仍可用，但标注为**待移除**；阶段 T 完成后连同 VS Code 旧消费路径一并删除，本文 §1–§6 届时移除。
- **新接入**：使用 §7 的 `IGraphDebuger` / `IGraphQueryDebuger` 与生成的静态门面；不要再新增旧采集门面的调用。

## 1. 文档定位

本文是**游戏侧引擎**接入 VisualBridge Graph 执行观察链路的操作指南：如何把引擎的图执行事件转发到 VisualBridge 采集门面，以及稳定 ID 映射规则。设计语义（范围裁决、事件模型、订阅与权限）冻结在 [`UnityIntegrationArchitecture.md`](UnityIntegrationArchitecture.md) 第 19 章；协议契约见 [`ProtocolContracts.md`](ProtocolContracts.md) 的 `visualbridge-runtime-bridge` 条目。VS Code 侧旧路径的页面交互已实现（Graph 编辑器「执行调试」入口：实例选择、实时高亮/边流光/值显示与时间轴回放），其交互语义见同章 §19.5；新接口通道的 VS Code 消费仍属阶段 C，尚未实现。

链路全景（旧路径）：游戏引擎执行图 → 引擎 debug provider 适配器转发 → `VisualBridgeGraphExecutionCapture` 采集门面（分配执行实例 ID、维护实例注册表、按订阅缓冲事件）→ Runtime Bridge 协议（`graphExecution` 批量事件）→ VS Code Graph 页面实时跟踪与回放。**只观察、不做断点**；执行引擎归游戏侧，VisualBridge 不实现节点调度或求值。接口式调试通道（§7）是迁移目标，上文描述的是当前仍在承载数据的旧路径。

## 2. 前置条件：稳定 ID 映射

- `.vbflow` 图文档是唯一创作源。Graph 编译产物（`Library/VisualBridge/Compiled`，Play 模式经 Runtime ArtifactStore 加载）中每个节点携带 VisualBridge 文档的**稳定节点 ID**。
- 游戏侧导入器（把编译产物转成游戏执行数据）**必须**把该稳定 ID 带入运行时数据的节点 UID 表（等价于 FlowGraph 参考实现的 `NodeUIDs`：`NodeID -> NodeUID` 映射，注释即「用于调试器显示」）。
- 转发事件时，节点参数一律使用稳定节点 ID（即 UID 表中的 UID），**不得**使用节点列表下标等重排后会漂移的临时 ID；否则 VS Code 页面无法点亮对应节点。
- 执行实例身份由 VisualBridge 分配（`exec-<n>`），游戏侧不自造执行 ID 体系；游戏侧自己的执行者标识（哪个角色在跑，如参考实现的 `debugKey`）作为 `debugKey` 原样上报。

## 3. 采集门面 API（旧路径，待移除）

> 本条路径在阶段 T 完成后删除；新接入见 §7。

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

## 5. 订阅与事件流模型（旧路径，待移除；游戏侧无需实现，仅供理解）

- VS Code 通过 `getGraphExecutionInstances`（可按 `documentId` 过滤）列活跃实例 → `subscribeGraphExecution` 订阅单个实例 → `getGraphExecutionSnapshot` 取浅快照（当前节点 + 运行状态；无订阅期间当前节点不更新）。
- 事件按「满 64 条或 100ms」批量冲刷（`graphExecution` 消息，载荷非空）；不同帧送达是设计允许的。
- 观察者语义不占租约：多个客户端可并行观察同一实例，与 DAP 检查会话、MCP 工具互不影响。
- 退订/断开即停录：最后一个订阅者退出后节点事件不再进缓冲（缓冲清空），实例注册表保留至实例停止。

## 6. 验证与已知边界

- 门面与服务端转发有 EditMode 全量覆盖（实例生命周期、无订阅快速路径、批量冲刷、64 条提前冲刷、实例停止清除订阅与快照、documentId 过滤、多客户端观察）。
- 待发缓冲上限 16384 条：执行泵滞后时丢弃最旧事件，防无界内存增长。
- mid-play domain reload 窗口内新旧服务端短暂共存时共享进程级采集门面，事件由先冲刷的泵投递（窗口极短；发现记录的 generation/心跳语义不受影响）。
- `ScriptableObject` 排除条款与单一权威源原则对本链路同样适用：执行观察不写回任何 Authoring 数据。

## 7. 接口式调试通道

新路径用 C# 接口声明调试契约，由代码生成器产出静态门面与实现；业务代码不接触字符串、JSON 或 `PushParam`。运行时细节与程序集边界见 [`UnityIntegrationArchitectureRuntime.md`](UnityIntegrationArchitectureRuntime.md#20-调试通道)。

### 7.1 声明事件接口

```csharp
using VisualBridge.Diagnostics;

[VisualBridgeDebuger(
    "graph",
    Version = 1,
    GeneratedDirectory = "Assets/Game/Scripts/Debug/Generated",
    InstanceParameter = "uid",
    FrameParameter = "frameIndex")]
public interface IGraphDebuger
{
    void ExecutionStarted(string uid, string graphName, string documentId, string debugKey);
    void NodeStart(string uid, string nodeId, int frameIndex);
    void NodeOutput(string uid, string nodeId, int outputIndex, int frameIndex);
    void DataNode(string uid, string nodeId, int frameIndex);
    void EdgeValueChanged(string uid, string nodeId, int outputIndex, string value, int frameIndex);
    void ExecutionStopped(string uid);
}
```

约束：

- 接口必须 `public`、顶层、非泛型、不继承其它接口；只允许方法，且方法返回 `void`。
- 不允许重载、泛型方法、`ref`/`out`/`in`、可选参数或 `params`。
- 参数类型限定为 `bool`、`int`、`long`、`ulong`、`float`、`double`、`string`、`byte[]`、`enum`；`byte` / `sbyte` / `short` / `ushort` / `char` 收窄为 `int`，`uint` 收窄为 `long`。
- 参数默认从 tag `0` 递增；可用 `[VisualBridgeDebugTag(n)]` 显式指定，显式值必须严格大于前一个 tag。
- `InstanceParameter` 指定调试实例标识，必须是 `string` 参数；`FrameParameter` 指定帧号，必须是 `int` 或 `long` 参数。生成器把实例值写入消息的 `instance` 字段、把帧号写入 `frame` 字段。
- `GeneratedDirectory` 必填，且必须位于工程根的 `Assets/` 或 `Packages/` 下；生成物写入该目录并与接口同命名空间。

与旧路径的语义差异：新路径**不再由 VisualBridge 分配执行实例 ID**。`uid` 由游戏侧生成，并在该执行实例的生命周期内保持稳定；它同时作为消息分流键和 `DescribeInstance` 的实例键。

### 7.2 插桩

生成器为上面的接口产出静态门面 `GraphDebuger`（命名规则见 [`§20.4`](UnityIntegrationArchitectureRuntime.md#204-契约与代码生成)：接口名去掉前导 `I` 与后缀 `Debuger` 得到 stem，门面类名为 stem + `Debuger`），方法签名与接口一致，另有一个实例元数据方法：

```csharp
GraphDebuger.DescribeInstance(string uid, string label, params string[] keywords);
```

在引擎适配器中直接调用门面，不再引用 `VisualBridgeGraphExecutionCapture`：

```csharp
public sealed class VisualBridgeFlowDebuger : FlowRuntimeDebuger
{
    private readonly string uid;

    public VisualBridgeFlowDebuger(string uid) { this.uid = uid; }

    protected override void OnNodeData(FlowDebugNodeData data)
    {
        switch (data.Type)
        {
            case FlowDebugNodeType.Execute:
                GraphDebuger.NodeStart(uid, ResolveNodeUid(data.NodeID), data.FrameIndex);
                break;
            case FlowDebugNodeType.Output:
                GraphDebuger.NodeOutput(uid, ResolveNodeUid(data.NodeID), data.OutputIndex, data.FrameIndex);
                break;
            case FlowDebugNodeType.ExecuteDataNode:
                GraphDebuger.DataNode(uid, ResolveNodeUid(data.NodeID), data.FrameIndex);
                break;
            case FlowDebugNodeType.OutputValue:
                GraphDebuger.EdgeValueChanged(
                    uid,
                    ResolveNodeUid((int)(data.EdgeID >> 32)),
                    (int)(data.EdgeID & uint.MaxValue),
                    data.OutputValue,
                    data.FrameIndex);
                break;
        }
    }
}
```

实例开始与结束时：

```csharp
GraphDebuger.DescribeInstance(uid, graphName, documentId, debugKey);
GraphDebuger.ExecutionStarted(uid, graphName, documentId, debugKey);

// 执行结束
GraphDebuger.ExecutionStopped(uid);
```

- 在实例创建时调用一次 `DescribeInstance`；`label` 为空时客户端回退为实例标识，关键词上限 16 个、每个截断到 64 字符，由调用方显式给出，客户端不从参数值猜测。未调用时实例仍可用，显示名与唯一关键词都取实例标识。
- 事件门面只在 `isDebugBuild && isConnected` 同时为真时构造消息，否则直接返回；`DescribeInstance` 由运行时门面按 `isConnected` 短路。因此插桩不要求传输已接入，也不会在未连接时产生关键路径开销。
- 事件上报的时机与粒度由引擎插桩点决定；VisualBridge 只做透传，不改写顺序。
- 节点参数仍必须使用 VisualBridge 稳定节点 ID（§2 的映射规则不变）。

### 7.3 注册查询

查询接口声明请求方法，不声明返回值：

```csharp
[VisualBridgeDebuger(
    "graph",
    Version = 1,
    Kind = VisualBridgeDebugerKind.Query,
    GeneratedDirectory = "Assets/Game/Scripts/Debug/Generated",
    InstanceParameter = "uid")]
public interface IGraphQueryDebuger
{
    void GetSnapshot(string uid, string requestId);
}
```

生成器产出 `GraphQueryDebuger` 门面和按方法名分发的实现。业务侧实现接口、注册处理器，并用统一的结果方法回发：

```csharp
public sealed class GraphQueryHandler : IGraphQueryDebuger
{
    public void GetSnapshot(string uid, string requestId)
    {
        string payload = BuildSnapshotJson(uid); // 调用方自行序列化
        GraphQueryDebuger.SendGetSnapshotResult(uid, requestId, payload);
    }
}

GraphQueryDebuger.Register(new GraphQueryHandler());
// 需要撤销时
GraphQueryDebuger.Unregister();
```

- 结果签名固定为 `Send<Method>Result(<instance>, string requestId, string payload)`；`payload` 只支持字符串，结构化数据由调用方编码，单条消息受 NDJSON 的 1 MiB 行上限约束。
- 结果消息携带客户端提供的 `requestId`；生成的结果方法不传帧号（`frame = -1`），即使接口声明了 `FrameParameter` 也不适用于查询结果。
- 生成分发器按下标取参（NDJSON 不写 tag；生成代码调用 `request.TryGetArg(<参数下标>, out ...)`）并做类型转换。参数不合法回 `invalidArgument`；接口未注册回 `unregistered`；处理器抛异常回 `handlerError` 并累加 `VisualBridgeDebug.Counters.handlerErrors`。
- 同一接口重复 `Register` 以最后一次为准并输出警告；超时与重试由客户端负责，Unity 侧不重试。
- 与旧路径一样，查询只读取运行时状态，不写回 Authoring 数据。

### 7.4 生成与校验

- 菜单：`Tools/VisualBridge/Debug/Generate Debug Contracts`。
- batch：`VisualBridge.Editor.VisualBridgeDebugContractBatch.Generate` / `.Check`；`Check` 逐字节比较磁盘产物，漂移时退出码为 `1`，成功为 `0`。
- 生成物：事件门面与实现，或查询门面与分发器，外加每个目录一份 `debug-contracts.json`（接口 id、category、version、kind、实例/帧参数、方法参数与 tag、枚举成员）。
- 目录已位于既有 asmdef 内时直接写入；接口位于 asmdef 程序集且目录没有 asmdef 时，生成器补一个引用接口程序集与 `VisualBridge.Debug` 的 asmdef；预定义程序集不写 asmdef；既有 asmdef 内容不符时拒绝覆盖。
- 样例接口与生成物：`Packages/com.kyle.visualbridge/Tests/Editor/Debug/Fixtures/GraphDebugContracts.cs` 与 `Packages/com.kyle.visualbridge/Tests/Editor/Debug/Generated/`。
- **`Check` 的覆盖边界**：发现逻辑跳过程序集名以 `.Tests` / `.Test` 结尾的程序集；本仓库唯一的契约样例位于 `VisualBridge.Editor.Tests`，因此 `Check` 在本仓库发现 0 个接口并恒成功。样例生成物的门禁是 `Packages/com.kyle.visualbridge/Tests/Editor/Debug/VisualBridgeDebugGeneratedContractTests.cs`，不是 `Check`；`Check` 只用于校验游戏工程里非测试程序集中的接口。
- **生成目录的 asmdef 前提**：若 `GeneratedDirectory` 位于一个既有 asmdef 下，该 asmdef 必须显式引用 `VisualBridge.Debug`（`autoReferenced` 只对预定义程序集生效）；查询接口生成的门面使用 `UnityEngine.Debug.LogWarning`，因此所在 asmdef 必须 `noEngineReferences: false`。生成器目前不会自动校验这两点（已知限制）。

### 7.5 新旧的对应关系

| 旧采集门面（待移除） | 新接口门面 |
| --- | --- |
| `OnInstanceStarted` | `ExecutionStarted` + `DescribeInstance` |
| `OnInstanceStopped` | `ExecutionStopped` |
| `OnNodeStart` | `NodeStart` |
| `OnNodeOutput` | `NodeOutput` |
| `OnDataNode` | `DataNode` |
| `OnEdgeValueChanged` | `EdgeValueChanged` |

旧路径的 `graphExecution` 是批量数组事件、按订阅冲刷；新路径是逐条消息、`seq` 单调、NDJSON 一行一条。新路径尚未接入传输（阶段 T），因此当前两端的实际数据仍由旧路径承载；阶段 T 完成后删除旧路径。
