# 附录 B · Unity 调试契约（固化自草案 U）

> 本附录是 Unity 侧调试运行时的**唯一契约依据**。标注「回填」的由 D3 在实现时确定并写回。

## B.1 特性、枚举与宏

```csharp
[AttributeUsage(AttributeTargets.Interface, AllowMultiple = false, Inherited = false)]
public sealed class VisualBridgeDebugerAttribute : Attribute
{
    public VisualBridgeDebugerAttribute(string category);
    public string Category { get; }
    public VisualBridgeDebugerKind Kind { get; set; }             // 默认 Event（get/set 见 B.2.4）
    public string GeneratedDirectory { get; set; }                // 必填，无隐式默认（缺失 → VBDBG013）
}

public enum VisualBridgeDebugerKind { Event = 0, Query }

[AttributeUsage(AttributeTargets.Parameter, AllowMultiple = false, Inherited = false)]
public sealed class VisualBridgeDebugInstanceAttribute : Attribute { }

[AttributeUsage(AttributeTargets.Parameter, AllowMultiple = false, Inherited = false)]
public sealed class VisualBridgeDebugTagAttribute : Attribute
{
    public VisualBridgeDebugTagAttribute(ushort tag);
    public ushort Tag { get; }
}
```

- 编译边界：`#if UNITY_EDITOR || VISUALBRIDGE_RUNTIME_BRIDGE`。宏关闭时生成门面只保留 `return false;`，通信实现整体不参与编译。
- 程序集：`VisualBridge.Debug`（`noEngineReferences`，可进 Player，引用 `VisualBridge.Runtime`）；`VisualBridge.Debug.Bridge`（引用两者，仅宏内）。业务 asmdef 显式引用。

### B.1.1 回填：命名空间与 asmdef（D1）

- 程序集名与 asmdef 文件名保持 `VisualBridge.Debug` / `VisualBridge.Debug.Bridge`；**源码命名空间是 `VisualBridge.Diagnostics` / `VisualBridge.Diagnostics.Bridge`**。
- 原因：命名空间 `VisualBridge.Debug` 会在 `VisualBridge.Editor` 等程序集内遮蔽 `UnityEngine.Debug`（22 处未限定 `Debug.Log*` 会变成 CS0234）。只改命名空间、不改程序集名，引用方仍只加 asmdef 引用。
- `VisualBridge.Debug` 的 asmdef：`references: ["VisualBridge.Runtime"]`、`noEngineReferences: true`、`includePlatforms: []`、`defineConstraints: []`、`autoReferenced: true`。
- `VisualBridge.Debug.Bridge` 的 asmdef：`references: ["VisualBridge.Runtime", "VisualBridge.Debug"]`、`noEngineReferences: false`（需要 `UnityEngine.Debug.LogWarning`）、`includePlatforms: []`、`defineConstraints: []`。
- 宏边界只能用源文件里的 `#if UNITY_EDITOR || VISUALBRIDGE_RUNTIME_BRIDGE` 表达：asmdef 的 `defineConstraints` 是 AND 语义，写成 `["VISUALBRIDGE_RUNTIME_BRIDGE"]` 会让未定义该符号的 Editor 整体不编译。宏关闭时 Bridge 程序集没有任何类型（Unity 只会提示“no scripts”，不报错）；Debug 程序集只保留特性、枚举、接口、请求结构与门面，门面没有任何静态字段，全部成员返回 `false` / 空实现（`isDebugBuild` 除外，按 B.2.2）。
- `VISUALBRIDGE_RUNTIME_BRIDGE` 在本仓库**没有定义处**（只有源码 `#if` 与本节文字）：独立 Player 构建时由 E1/E2 的宿主或构建配置注入该符号，仓库自身不定义。
- **验证限制（契约级）**：EditMode 测试程序集恒定义 `UNITY_EDITOR`，**无法执行宏关闭分支**；宏关闭的验收证据只有静态审查与独立的宏关编译/Player 构建，**不能由 EditMode 用例替代**。EditMode 用例只能覆盖“已编译但未挂接（没有注入传输）”态（见 B.3.1）。

### B.1.2 回填：`ConnectType`

```csharp
public enum ConnectType
{
    Editor = 0,      // Unity Editor 非播放态（默认值）
    EditorPlayer,    // Editor 内的 Play 模式
    Player,          // 独立 Player 构建
}
```

- 取值由传输层提供（`IVisualBridgeDebugTransport.ConnectType`），业务只读。
- 未注入传输时按编译平台取默认值：Editor 内是 `Editor`，Player 内是 `Player`；宏关闭固定 `Player`（宏关闭只发生在独立 Player 构建）。

### B.1.3 回填：传输注入缝 `IVisualBridgeDebugTransport`

```csharp
public interface IVisualBridgeDebugTransport
{
    bool IsConnected { get; }
    ConnectType ConnectType { get; }
    long ConnectionGeneration { get; }          // 每次新连接建立后递增，断连期间不变
    void SendCreate(string instanceId, string category, string resName, string debugInfo, ushort instanceSlot);
    void SendFinish(string instanceId, ushort instanceSlot);
    void SendEvent(ushort instanceSlot, ushort methodId, string category, string iface, string method,
                   long frame, VisualBridgeDebugEncodedMessage message);
    void SendResult(uint requestSeq, VisualBridgeDebugEncodedMessage message);
    void SendQueryError(uint requestSeq, string code, string detail);   // D4：查询运行期失败应答（A.6 错误码）
    void SendControl(VisualBridgeDebugEncodedMessage message);   // debugFrame 等控制消息
    void SendReject(uint requestSeq, string reason);
}
```

- 注入方：E1/E2 的传输适配实现本接口、经 `VisualBridge.Debug.Bridge` 注入；业务与生成代码不接触它。
- `SendCreate` 只在“已挂接且已连接”时调用；`resName` / `debugInfo` 由传输层负责发出后丢弃，运行时不在本地保留。
- `SendEvent` 的 `category` / `iface` / `method` 供传输层诊断与路由；`frame` 是消息构造时刻（`Start`）读到的值；`message` 是编码器 `End()` 产出的「完整载荷 + 载荷格式 + 目标队列」描述，传输层不得二次编码。
- `SendResult` / `SendReject` 对应 `StartResult` / `RejectRequest`；`requestSeq` 是信封里的请求号。`SendResult` 的描述符已含调试载荷：二进制头为 `methodId + instanceSlot + u32 requestId`，JSON 为 `type/category/instance/iface/method/requestId`（`"req-<n>"`）与 args。
- `SendQueryError`（D4 回填）承载查询运行期自己产生的失败应答（A.6 的 `runtime.queryBusy` / `runtime.queryTimeout` / `runtime.queryUnregistered` / `runtime.instanceNotFound` / `runtime.invalidArgument`），`detail` 是诊断文本；`SendReject` 只承载业务侧 `RejectRequest` 的拒绝原因，码由传输层固定为 `runtime.queryRejected`（A.6，E6 登记）。两者都写到通道 1 的 `response`，不进入调试流；传输层负责把 `code`/`reason` 落成 A.5 的 `response` 字段（E6）。
- `SendControl` 是 D3 回填的控制通道入口：当前只承载 `debugFrame`，`message.Format` 恒为 JSON、`message.TargetQueue` 恒为 Control、`message.Payload` 是完整 `{"type":"debugFrame","frame":N}`。传输层必须保证它先于之后的数据消息写出（连接建立时先发当前帧；帧值变化且有数据要发时补发）。注意它是**通道 1 的调试控制消息**，不是通道 0 的编辑器控制队列；实现方不要把两者混用。
- **实现约束**：所有成员都可能在业务线程被同步调用；实现不得回调调试 API、不得阻塞、不得自行重试。连接事件由宿主显式调用 `Attach()` / `Detach()` 表达。
- `ConnectionGeneration` 拿不到时可以恒返回 `0`；此时宿主必须在断连时调用 `Detach()`，否则“还没观察到断连就又连上”的静默重连不会重置会话（`Start` 可能把旧实例发到新连接）。
- 控制通道（`debugFrame` 等）由 `SendControl` 承载；D1 只保留事件与结果载荷两条数据发送路径，D3 在其上扩展控制入口。

### B.1.4 回填：`VisualBridgeDebugBridge`（Debug.Bridge 程序集）

```csharp
public static class VisualBridgeDebugBridge
{
    public static bool IsInstalled { get; }
    public static void Install(IVisualBridgeDebugTransport transport);  // 注入并挂接；重复注入以最后一次为准
    public static void Uninstall();                                     // 解除注入并按断连语义重置会话状态
    public static void Attach();                                        // 重连后显式挂接：建立连接、flush 待发描述，并按原槽位重放仍活着的实例登记
    public static void Detach();                                        // 只解除挂接（按断连语义清空会话快照）；保留注入的传输实现、实例登记与槽位游标，供下次 Attach 重放
}
```

- `Install(null)` 是空实现，`Uninstall()` 可重复调用。
- Debug 程序集是 `noEngineReferences`，`Install` 期间把内部告警 sink 接到 `UnityEngine.Debug.LogWarning`；未注入时告警只留在内部环形缓冲（测试与诊断可读），不产生控制台输出。

## B.2 `VisualBridgeDebug` 静态 API

```csharp
public static class VisualBridgeDebug
{
    public static bool isDebugBuild { get; }        // 编译期常量
    public static bool isConnected { get; }
    public static ConnectType ConnectType { get; }  // Editor / EditorPlayer / Player

    public static bool Create(string instanceId, string category, string resName, string debugInfo);
    public static bool Finish(string instanceId);

    public static void SetFrame(long frame);        // 默认 -1 = 无帧；只写内部值，不产生消息
    public static void SetEncoder(IDebugMessageEncoder encoder);

    public static bool Start(string instanceId, string category, ushort methodId,
                             string iface, string method);
    public static bool StartResult(VisualBridgeDebugRequest request);   // 结果回发入口
    public static bool RejectRequest(VisualBridgeDebugRequest request, string reason);
    public static void RegisterRequestHandler(string category, string interfaceId, Delegate handler);

    public static void Attach();   // 显式挂接（Bridge 程序集）
    public static void Detach();

    public static bool End();      // 结束当前消息；true = 载荷已交给数据队列（语义见 B.2.1）
}
```

`PushParam` 重载（只有这一组，收窄类型由生成代码显式转换）：`bool` / `int` / `long` / `ulong` / `float` / `double` / `Enum` / `string` / `byte[]`；签名均为 `PushParam(string name, ushort tag, T value)`。

```csharp
public readonly struct VisualBridgeDebugRequest
{
    public string InstanceId { get; }    // 业务可读
    // RequestId 仅运行时与生成代码使用，不对业务暴露
}
```

不变式：

- `Start` 返回 `true` 只表示消息被接受；无连接时直接丢弃并计数，不编码、不入队。
- `Start` 返回 `false` 后生成代码**必须立即返回**，不得调用 `PushParam`/`End`。
- `PushParam` 按 `tag` 升序压入；`name` 必填（≤64），供 JSON；`tag` 供二进制。
- 默认值在编码阶段跳过，调用方可以无条件压入全部参数。
- `End` 把完整载荷写入**数据队列**；编码前按字节预算检查，避免为大 `byte[]` 分配后再丢。

### B.2.1 回填：`End()` 与消息生命周期

```csharp
public static bool End();   // true = 完整载荷已交给数据队列；false = 没有可结束的消息 / 跨线程 / 已断连 / 连接换代
```

- `Start` / `StartResult` 成功后才允许 `PushParam` / `End`；`Start` 返回 false 后生成代码必须立即返回。
- 同一条消息的 `Start → PushParam → End` **必须在同一线程连续调用**（生成代码天然满足）。消息上下文放在 `Start` 线程的 `[ThreadStatic]` 槽位里（`Start` 热路径不分配）；其它线程的 `PushParam` / `End` 被忽略，会计入跨线程计数并告警一次，不改变消息本身。
- **编码器在 `Start` 时绑定**：整条消息的 `Begin` / `PushParam` / `End` 都用当时注入的编码器；中途 `SetEncoder` 只影响下一条消息，`SetEncoder(null)` 也不影响进行中的消息。
- `End` 以及会话重置路径都会调用已绑定编码器的 `End()` 收尾，编码器不会留下半条消息；`SetEncoder(null)` 与“会话在 Start/End 之间被重置”都不例外。B.4.1 仍要求 `Begin` 可重置状态，以防业务中途停止调用 `End`。以下情况丢弃载荷并计入 dropped：已断连、`Start` 之后连接代次变化（`ConnectionGeneration` 不同 → 该槽位属于上一条连接）。
- `frame` 在 `Start` 构造消息时读取，之后的 `SetFrame` 不影响在途消息。
- **默认值判定在门面层、调用编码器之前完成**（B.2 的“编码阶段跳过”指载荷里不出现默认值）：`false` / `0` / `null` / `""` / 空 `byte[]` 跳过；**`float` / `double` 按位判断**，只有 `+0.0` 是默认值，`-0.0` 会照常写出（附录 A.4，D3 按位编码的前置契约）。

### B.2.2 回填：`isDebugBuild`

- 编译期常量，等价于 `UNITY_EDITOR || DEVELOPMENT_BUILD`（Unity `Debug.isDebugBuild` 的编译期近似），与 B.1 的调试宏边界**相互独立**：宏关闭的 Development Player 仍可能返回 true，但 `Create` / `Start` 返回 false。

### B.2.3 回填：`VisualBridgeDebugRequest` 的构造与可见性

```csharp
public readonly struct VisualBridgeDebugRequest
{
    public VisualBridgeDebugRequest(string instanceId, ushort instanceSlot, ushort methodId, uint requestSeq);
    public VisualBridgeDebugRequest(string instanceId, ushort instanceSlot, ushort methodId, uint requestSeq,
                                   string category, string interfaceId, string method);   // D4 生产路径
    public string InstanceId { get; }    // 业务只读
}
```

- **生产路径（D4 回填）**：D2 生成的 Dispatcher 在分发时按方法号用 7 参构造为每次请求构造句柄，`category` / `iface` / `method` 随句柄一起到达运行期，**运行期不再反射任何生成成员**（`TryGetMethodName` 因此降级为纯诊断产物，见 B.5）；IL2CPP 裁剪不会让 `debugResult` 的归属静默缺失。
- 4 参 public 构造函数保留给手写处理器 / 旧生成代码（生成代码落在业务程序集，没有 IVT 可用）：句柄不带归属时 `StartResult` 只用槽位绑定的分类补 `category`，`iface` / `method` 缺失时按 A.5 省略、消费端按 `requestId` 兜底（D3 的反射反查已移除）。
- 业务代码只读 `InstanceId`；槽位 / 方法号 / 请求号 / 结果归属都是 internal，`RequestId` 只在信封里（A.5）。
- 实例存活校验（D4 回填）：`StartResult` 要求 `InstanceId` 在当前实例集合里（`Finish` 与断连会移除），否则返回 false、不产生消息并计入 dropped。
- 请求作废（D4 回填）：排队/执行超时、实例结束或业务已拒绝的句柄进入**有界作废表**（≤64 条，先进先出淘汰）；之后的 `StartResult` / `RejectRequest` 返回 false、不产生消息并计入 dropped，重复晚到同样丢弃（防长跑泄漏，见 B.6.1）。
- `default` 句柄（`InstanceId == null`）无效：`StartResult` / `RejectRequest` 对它返回 false。

### B.2.4 回填：特性成员形态

```csharp
[VisualBridgeDebuger("graph", Kind = VisualBridgeDebugerKind.Event, GeneratedDirectory = "Assets/...")]
public interface IGraphDebuger { ... }
```

- `VisualBridgeDebugerAttribute(string category)`：`Category { get; }` 只读；`Kind { get; set; }` 默认 `Event`；`GeneratedDirectory { get; set; }` 必填（缺失 → `VBDBG013`）。
- `VisualBridgeDebugTagAttribute(ushort tag)`：`Tag { get; }` 只读。
- `VisualBridgeDebugInstanceAttribute`：无成员。

## B.3 实例与槽位

- `instanceId` 加入 `HashSet<string>`（`StringComparer.Ordinal`）；`Create` 加入、`Finish` 移除；`Start` 用 `Contains` 判断。
- 重复 `Create` 同一 id：`Add` 返回 `false`，不重发 `Create`，返回 `true` 并告警。
- 实例上限 **1024**；超限 `Create` 返回 `false` 并告警（每会话一条）。
- 槽位：`u16`，`0` = 未分配；**同一连接内从 1 单调递增、绝不复用**；**会话复位后的重放沿用登记的首选槽位**（重连前后同一实例的槽位不漂移，消费端按 `(category, instanceId, instanceSlot)` 建立的查询归属才继续成立）；上限 65535，耗尽后 `Create` 返回 `false` 并告警。
- 待发描述队列：无连接时入队，连接建立后按入队顺序 flush 一次，发送后清空。
- 连接断开（E11 起分两种结算方式）：
  - **宿主 `Detach` 结算的断连**（它观察到整栈断开，附录 A.9 的结算入口）：快照 / 待发队列 / 槽位表复位，但**保留活跃实例登记与槽位游标**；重连后按原槽位重放 `debugCreate`，这些实例的 `Start` 恢复。
  - **惰性断连 / 无 `Detach` 的静默换代**（会话自己发现 `ConnectionGeneration` 变化）：实例集合、槽位表、待发队列、**活跃登记**一起清空、槽位计数归 1，旧实例的 `Start` 从此返回 `false`——这是无法区分"抖动"与"真断开"时的保守取舍。
- 保留四类长期状态：实例 id 集合、槽位映射（`instanceId → slot`）、槽位绑定的分类（`slot → category`），以及（E11 新增）**活跃实例登记 `instanceId → 描述 + 首选槽位`**。分类必须保留：A.4 的 `slot → instance → category` 是二进制路由依据，也是 `debugResult` 补全 JSON `category` 的唯一来源。登记的 `resName` / `debugInfo` **不再"发送后丢弃"**：登记保存二者，供会话复位后按原槽位重放 `debugCreate`；只有 `Finish` 或换传输才注销一条登记。

### B.3.1 回填：未挂接 / 未连接 / 已连接时的返回值

| 状态 | `Create` | `Finish` | `Start` | `PushParam` / `End` |
| --- | --- | --- | --- | --- |
| 宏关闭（独立 Player 构建，未参与编译） | false，无副作用 | false | false，不计数 | 空实现（`End` 返回 false） |
| 已编译但未挂接（没有注入传输） | false，无副作用 | false | false，不计数 | 空实现（`End` 返回 false） |
| 已挂接、无连接 | true（描述入待发队列、槽位照常分配） | 见下 | 已知实例计入 dropped，未知实例不计数 | 空实现（`End` 返回 false） |
| 已挂接、已连接 | true（立即发送） | true（发送 Finish） | true（被接受） | 生效 |

- **覆盖边界**：前两行在 EditMode 里只可执行“未挂接”一行；宏关闭一行不可由 EditMode 用例覆盖（B.1.1 的验证限制），只能静态审查/独立 Player 构建取证，EditMode 用例不得充当宏关闭证据。
- `Finish` 在“已挂接、无连接”时：实例存在则移除并返回 true；若它的 `Create` 还在待发队列里，直接撤销该描述（不向客户端制造“建了立刻结束”的实例），但**槽位仍算消耗、绝不复用**。
- 未知实例（从未 `Create`，或**会话以静默重连 / 惰性断连方式复位**、实例集合与活跃登记已被清空）的 `Start` 返回 false 且**不**计入 dropped；宿主 `Detach` 结算过的断连**不属于**这一类——它保留登记，重连重放后 `Start` 恢复。未挂接/宏关闭时的 `Start` 也不计数。
- 会话状态是只读快照：`Create` / `Finish` / 断连时整体替换，`Start` 只做一次 volatile 读即可无锁、零分配地判断实例与连接态。

### B.3.2 回填：连接代次、`End` 的会话校验与会话切换

- `Start` 抓取当时 transport 的 `ConnectionGeneration`；`End` 发送前再次比较，不同则丢弃（旧槽位不能发到新连接）。
- 会话切换触发点（E11 起按“是否有宿主结算”分三种，不再一句话概括）：
  - **`Install` / `Uninstall`（换传输）**：注入任意 transport 一律视为新会话——实例、槽位、待发描述、活跃登记、连接代次**全部作废**，旧会话的 pending 不会带进新传输。
  - **宿主 `Detach`**：按断连语义复位会话快照，但**保留活跃实例登记与槽位游标**；下一次 `Attach`/建连时按原槽位重放 `debugCreate`（`Start` 恢复）。
  - **静默换代（没有宿主 `Detach`）**：`ConnectionGeneration` 变化被会话惰性发现时，**清空登记**、不重放——没有宿主结算就无法区分抖动与真断开，保守丢弃。
  - `Create` / `Finish` / `Attach` 冷路径也会惰性发现断连；`ConnectionGeneration` 变化用于识别“未被观察到的静默重连”。
- 传输层不提供代次（恒 `0`）时，宿主必须保证断连时调用 `Detach()`；否则上述静默重连检测不生效——这是 D3 / E2 共同承担的替代约束。

### B.3.3 回填：诊断计数

- `DroppedMessages`（无连接/无编码器/编码失败/连接换代而丢弃的消息数）、`DroppedOversizeMessages`（其中超 1 MB / 二进制 u16 字符串超限的部分）与 `CrossThreadCalls`（跨线程调用次数）都是 **internal 诊断量**，业务不可见；D1 不提供公开读取，**D3 回填**为 E4 的 `dropped` 聚合提供公开只读快照：`VisualBridgeDebugMetrics.GetSnapshot()`（`VisualBridge.Debug` 程序集，编辑器与运行时宿主都可引用），`VisualBridgeDebugBridge.GetDiagnostics()` 是同一快照的宿主入口。
- 三者**随会话重置归零**（`Install` / `Uninstall` / `Detach` / 断连重置）；按差值读聚合的消费者会看到回退，需按会话边界处理或要求转发 API 提供绝对值/重置事件。

## B.4 编码器接口

```csharp
public enum VisualBridgeDebugMessageKind : byte { Debug = 0, DebugResult = 1 }
public enum VisualBridgeDebugPayloadFormat : byte { Binary = 0, Json = 1 }
public enum VisualBridgeDebugTargetQueue : byte { Data = 0, Control = 1 }
public enum VisualBridgeDebugEncodeStatus : byte { Ok = 0, TooLarge = 1, UnsupportedValue = 2, LengthOverflow = 3 }

public readonly struct VisualBridgeDebugEncodedMessage
{
    public VisualBridgeDebugPayloadFormat Format { get; }        // 二进制 / JSON
    public VisualBridgeDebugTargetQueue TargetQueue { get; }     // 数据队列 / 控制队列
    public ReadOnlyMemory<byte> Payload { get; }                 // 完整载荷
    public VisualBridgeDebugEncodeStatus Status { get; }         // 非 Ok = 整条丢弃
    public bool IsEncoded { get; }
}

public interface IDebugMessageEncoder
{
    void Begin(VisualBridgeDebugMessageKind kind, string instanceId, string category, string iface, string method,
               ushort methodId, ushort instanceSlot, uint requestId);  // requestId 仅 debugResult
    void PushParam(string name, ushort tag, object value);             // 运行时值只能是九种声明类型之一
    VisualBridgeDebugEncodedMessage End();                              // 完整载荷 + 目标队列
}
```

- 替换编码器的**唯一**要求：`SetEncoder` 之后生成代码零改动，两套编码器跑通同一批用例。
- JSON 与二进制必须产出同一组"非默认参数"，可用同一事件序列比对两种载荷。
- **Begin 精确参数（D3 回填）**：`kind` 区分 debug / debugResult；`instanceId`、`category`、`iface`、`method` 供 JSON 信封（二进制编码器忽略）；`methodId` / `instanceSlot` 供二进制头；`requestId` 只写入 debugResult。`debugResult` 的归属由生成 Dispatcher 用 7 参 `VisualBridgeDebugRequest` 构造直接携带（D4 生产路径，B.2.3），运行期不再反查；JSON 信封与 A.5 一致包含 `iface` / `method`，只有手写处理器的 4 参句柄可能缺这两项，此时按 A.5 省略、结果仍发送。
- **End 产出描述（D3 回填）**：`End()` 不再只返回字节，而是返回 `Format + TargetQueue + Payload + Status`。两个数据编码器恒为 `TargetQueue = Data`；`debugFrame` 由运行期构造同样形状的描述（`Json + Control`）交给传输层。`Status` 为 `TooLarge`（超 1 MB）、`LengthOverflow`（二进制 u16 字符串超限）或 `UnsupportedValue`（收到九种类型之外的运行时值）时，`Payload` 为空，门面按 dropped 计数且不发送。
- **PushParam 不接受任意 object（D3 回填）**：运行时值只能是 `bool` / `int` / `long` / `ulong` / `float` / `double` / `Enum` / `string` / `byte[]`；`uint→long`、`short→int` 等收窄由生成代码显式转换，编码器不做数值类型推断或 `Convert`。
- JSON 载荷形状：`{ type, category, instance, iface, method, requestId: "req-<n>", args: [{ tag, name, type, value }] }`（`requestId` 仅 debugResult，JSON 用 `"req-<n>"` 字符串、二进制用 `u32`）；`long`/`ulong` 用字符串、enum 用成员名、`byte[]` 用 base64、`float`/`double` 的 `-0.0` 写 `-0.0`、NaN/±Infinity 用字符串。字段名以 D3 定稿的 `iface` 为准（A.5 已同步）；`type` 是线上类型名，声明类型仍由 `debug-contracts.json` 反查。
- 单条消息上限 **1 MB**，超限丢弃并计数（两种载荷一致），不阻塞后续消息。

### B.4.1 回填：编码器实现约束（D1 定，D3 可扩展）

- 实现不得回调调试 API、不得阻塞；`Begin` 必须重置内部状态（断连丢弃路径也会先调用 `End` 收尾）。
- 编码器经 `SetEncoder` 注入；生成代码只依赖门面、不依赖编码器签名。
- 两个实现：`VisualBridgeDebugJsonEncoder`（JSON 降级）与 `VisualBridgeDebugBinaryEncoder`（附录 A.4 的二进制布局），都是 `VisualBridge.Debug` 的公开类型，由宿主按协商结果注入。
- 稀疏编码与默认值判定在门面层和编码器各做一次防御；编码器仍按 `tag` 升序输出，直接调用编码器也满足附录 A.4。
- 丢弃计数（含超限/长度溢出）经 `VisualBridgeDebugMetrics.GetSnapshot()` 暴露给 E4 的 `dropped` 聚合（`VisualBridge.Debug` 程序集，编辑器与运行时宿主都可引用；`VisualBridgeDebugBridge.GetDiagnostics()` 是同一快照的宿主入口）。计数随会话重置归零。

## B.5 生成器产物

| 产物 | 适用 | 说明 |
| --- | --- | --- |
| `<X>Debuger.g.cs` | 全部 | 静态门面；Event 方法返回 `bool`；`Send<Method>Result` 返回 `bool` |
| `VisualBridgeGenerated<X>Debuger.g.cs` | Event | 接口实现 + `Try<Method>`，逐方法调 `Start/PushParam/End` |
| `VisualBridgeGenerated<X>DebugerDispatcher.g.cs` | Query | 请求分发；`Register` 时挂载 Dispatcher 委托与参数声明表；用 7 参构造携带结果归属 |
| `<Category>Category.g.cs` | 全部 | 分类名 + `GraphProtocol`（只含接口方法，从 10 起） |
| `<category>.g.ts` | 全部 | 模块调试展示用的类型与常量；宿主不加载 |
| `debug-contracts.json` | 全部 | 接口、分类名、方法号、参数清单 + 顶层 `contractHash` |
| `VisualBridgeDebugContract.g.cs` | 全部 | 全局一份：`public const string Hash = "…"` |
| `debug-ids.json` | 全部 | 号分配器持久状态：`{ "categories": { "graph": { "nextMethodId": 17, "methods": {…} } } }` |

规则：

- 接口名去 `I` 即类名（`IGraphDebuger` → `GraphDebuger`）；同类多接口合并到同目录。
- 生成器**不创建 asmdef**；生成目录必须已被 asmdef 覆盖，否则 `VBDBG011` 失败。预定义程序集（如 `Assembly-CSharp`）放行。
- 产物带 `// <auto-generated />`，确定性输出（稳定排序、无时间戳、LF）。
- 三个全局产物（`debug-contracts.json`、`VisualBridgeDebugContract.g.cs`、`debug-ids.json`）只写到 `VisualBridgeDebugConfig.ArtifactsRoot`，且该目录必须在 asmdef 覆盖内；一个项目只有一份。
- 方法号：`0` 保留、`1`/`2` = Create/Finish、`3–9` 预留、`10+` 分类；删除的方法号不复用，`nextMethodId` 不回退；已删除分类条目保留。
- 参数号：显式 `[VisualBridgeDebugTag(ushort)]` 优先，同一方法内必须唯一（重复 → `debug.tagDuplicate`）；未标记的载荷参数按声明顺序从 `1` 起自动分配、跳过显式占用的号；`0` 保留给系统字段（`Create`/`Finish` 的固定 tag 表）与查询结果。二进制参数区按 `tag` 升序写出（A.4 的 `u16 tag + u8 type + value`），接收端按契约声明匹配 `tag`。
- `contractHash`：把分类、接口、方法、参数、枚举按固定顺序拼文本后取 SHA-256 前 8 字节（16 位十六进制）；与生成顺序、遍历顺序无关。
- `debug-contracts.json` 以 `manifest.schemaVersion = 2` 标记契约文件格式版本；只有 payload 参数带 `tag`（`instance` / `request` 参数不进入载荷），`enums` 条目含底层类型 `underlyingType`。

错误码：`VBDBG011` 目录未被 asmdef 覆盖；`VBDBG012` Event 接口实例参数不合法（必须恰好一个 `string` 实例参数，优先 `[VisualBridgeDebugInstance]`，否则取名为 `instanceId` 的唯一 `string` 参数）；`VBDBG013` `GeneratedDirectory` 缺失；`VBDBG014` 同分类方法重名；`VBDBG015` 同分类同号不同名。

### B.5.1 回填：Query 产物契约（D4）

生成 Dispatcher 的公开成员（都在 `#if UNITY_EDITOR || VISUALBRIDGE_RUNTIME_BRIDGE` 内，`public static`）：

| 成员 | 签名 | 契约 |
| --- | --- | --- |
| `Register` | `void Register(<接口> implementation)` | 保存实现并调用 `VisualBridgeDebug.RegisterRequestHandler(category, interfaceId, new VisualBridgeDebugRequestDispatcher(Dispatch), new VisualBridgeDebugRequestParameterDecoder(TryGetParameters))` |
| `Unregister` | `void Unregister()` | 以 `handler = null` 再注册一次解除挂载 |
| `Dispatch` | `bool Dispatch(ushort methodId, string instanceId, ushort instanceSlot, uint requestSeq, object[] parameters)` | 运行期统一委托 `VisualBridgeDebugRequestDispatcher` 的实体；每个方法号的 case 用 **7 参 `VisualBridgeDebugRequest`** 构造句柄（携带 `category` / `interfaceId` / `method`），再交给 `Dispatch<Method>` |
| `TryGetParameters` | `bool TryGetParameters(ushort methodId, out string[] names, out ushort[] tags, out Type[] types)` | 方法号 → 载荷参数声明表（顺序＝业务方法声明顺序，不含请求句柄）；适配运行期委托 `VisualBridgeDebugRequestParameterDecoder`，运行期按它把请求 args 从 tag 重排成声明顺序 |
| `TryGetMethodName` | `bool TryGetMethodName(ushort methodId, out string methodName)` | **纯诊断产物**：运行期不再调用它补齐 `debugResult` 归属（D4 改走 7 参句柄）；保留给本地诊断/工具，生成器测试断言它存在 |

- 生成代码**不再**声明各接口自带的 `DispatchHandler` 委托：统一用 `VisualBridge.Diagnostics` 里的两个运行期委托，运行期直接调用（不 `DynamicInvoke`、不反射生成成员），IL2CPP 裁剪无风险。
- 门面 `<X>Debuger.g.cs` 的 `Send<Method>Result` 形状：`public static bool Send<Method>Result(VisualBridgeDebugRequest request[, <TResult> result])`——先 `StartResult(request)`，false 立即返回；结果参数按 `tag` 压入后 `End()`。归属（`iface`/`method`）来自 `request` 句柄，门面自己不再拼。
- 生成目录、确定性与 `// <auto-generated />` 规则不变；本次改造只改 Dispatcher 与门面的 Query 分支，Event 产物零变化。

## B.6 查询运行期

- socket 读线程只解析、校验、入队，**不调用业务实现**；pump 在主线程每帧取 **最多 1 条**执行。
- 注入位置：Player / Play 模式用 `PlayerLoop` 的 `Update` 阶段（`BeforeSceneLoad` 注册）；Editor 非播放态用 `EditorApplication.update`；reload 后重新挂接。
- 查询队列上限 8；满则立即 `runtime.queryBusy`，不入队。
- 超时：排队 `2000 ms` / 执行 `3000 ms`，超时回 `runtime.queryTimeout` 并作废该请求；晚到结果丢弃并计入 `dropped`。
- `RejectRequest` 返回失败应答（通道 1 的 `response`，`code` 恒 `runtime.queryRejected`，原因进 `detail`），不进入调试流。
- `requestId` 只存在于信封（JSON 为 `"req-<n>"`，二进制为 `u32`），句柄不暴露给业务。

### B.6.1 回填：公开入口与委托（D4）

```csharp
public static class VisualBridgeDebugQueryRuntime
{
    public const int MaxQueuedRequests = 8;
    public const int MaxConcurrentRequests = 8;
    public const int QueueTimeoutMilliseconds = 2000;
    public const int ExecutionTimeoutMilliseconds = 3000;

    public static VisualBridgeDebugQueryStatus TryEnqueue(VisualBridgeDebugQueryRequest request);
    public static int Pump();                                  // 主线程每帧一次；返回本次执行条数 0/1
    public static VisualBridgeDebugQueryMetrics GetMetrics();   // 队列/并发/超时/拒绝/丢弃计数快照
}

public readonly struct VisualBridgeDebugQueryArgument   // 一个载荷参数：tag + 已解码值（+ 可选 name）
public sealed class VisualBridgeDebugQueryRequest       // 信封：requestSeq / category / instanceId /
                                                       //       instanceSlot / methodId / interfaceId / method / arguments
public enum VisualBridgeDebugQueryStatus : byte
{ Accepted, Unavailable, InvalidArgument, QueueFull, ConcurrencyLimited, Unregistered, InstanceNotFound }

public delegate bool VisualBridgeDebugRequestDispatcher(ushort methodId, string instanceId, ushort instanceSlot,
                                                        uint requestSeq, object[] parameters);
public delegate bool VisualBridgeDebugRequestParameterDecoder(ushort methodId, out string[] names,
                                                              out ushort[] tags, out Type[] types);
```

- 传输层（E6）在 socket 读线程：解析 `request` 信封 + args → 构造 `VisualBridgeDebugQueryRequest` → `TryEnqueue`。
- 宿主（E5）在主线程每帧调用 `Pump()`；`Pump` 内部先结算两段超时，再最多执行 1 条。**pump 挂接不在 `VisualBridge.Debug` 程序集**（它 `noEngineReferences`，拿不到 `PlayerLoop` / `EditorApplication`），由 E5 的宿主完成并在 domain reload 后重挂。
- `GetMetrics()` 是宿主/测试的只读快照；业务与生成代码不依赖它（业务只看 `VisualBridgeDebug`）。
- 处理器注册（`RegisterRequestHandler(category, interfaceId, handler[, parameterDecoder])`）是**静态接线**，不随会话重置；查询队列、在途与作废表随会话重置（`Install` / `Uninstall` / `Detach` / 断连）清空、计数归零。

### B.6.2 回填：入队校验与错误码（D4）

`TryEnqueue` 按下列顺序校验；任何拒绝都**不入队、不丢弃已有请求**，并按 A.6 回失败应答（`Unavailable` 除外：没有可回应的通道，静默丢弃并计数）。

| 情形 | `VisualBridgeDebugQueryStatus` | 错误码 |
| --- | --- | --- |
| 未挂接 / 未连接 | `Unavailable` | 无（无通道可回；计入 `UnavailableRejectedCount`） |
| 信封缺 `instanceId`、`requestSeq == 0`、重复请求号、二进制槽位与实例不匹配、分类未知 | `InvalidArgument` | `runtime.invalidArgument` |
| 实例不存在或已 `Finish` | `InstanceNotFound` | `runtime.instanceNotFound` |
| 分类内没有该接口/方法号的处理器（`TryGetHandler` 未命中） | `Unregistered` | `runtime.queryUnregistered` |
| 排队队列已满（8） | `QueueFull` | `runtime.queryBusy` |
| 在途请求已达 8 | `ConcurrencyLimited` | `runtime.queryBusy` |

- 参数解码：按生成 Dispatcher 的 `TryGetParameters` 取「方法号 → 名称/tag/CLR 类型」，把 args 按 `tag` 重排成业务方法的**声明顺序**；缺省 tag 用该类型默认值；未知 tag、类型不匹配都按 `invalidArgument` 拒绝。**处理器已注册但参数声明表缺该方法号**时：`args` 为空仍可分发（无载荷参数的方法不需要声明表），`args` 非空则按 `invalidArgument` 拒绝——与上一行「分类内没有处理器」的 `queryUnregistered` 是两件事。线格式 → CLR 值的解码仍归 E4/E6，运行期只做枚举/数值的容错收窄。
- 二进制信封不带 `iface` 时，运行期用「分类内方法号唯一」这一不变式在已注册处理器里反查接口（调用 `TryGetParameters`，不反射生成成员）。

### B.6.3 回填：队列、两段超时与句柄生命周期（D4）

- 入队时记录 `now`；pump 每帧先结算超时：
  - **排队超时 2000 ms**：只在队首前缀上过期（入队顺序即时间顺序），逐条回 `runtime.queryTimeout`（`detail` 标 `stage=queued`）并作废。
  - **执行超时 3000 ms**：在途请求按开始执行时刻判定，超时回 `runtime.queryTimeout`（`stage=executing`）并作废。
- 作废 = 移出在途 + 请求号进入**有界作废表**（≤64 条，先进先出淘汰）。之后的 `StartResult` / `RejectRequest` 命中作废表就返回 false、不发消息，并计入 dropped（`VisualBridgeDebugMetrics.GetSnapshot().DroppedMessages` 与查询计数的 `DroppedLateResultCount`）；重复晚到同样丢弃。
- 正常结算也会把请求号放进作废表（防同句柄二次回发）；`RejectRequest` 先 `transport.SendReject` 再结算，超时之后才到的拒绝只丢弃不重发。
- 实例存活在**分发时**再校验一次（排队期间可能 `Finish`）：直接回 `runtime.instanceNotFound`，不调用业务实现。
- handler 返回 false 且既没回发结果也没 `RejectRequest` 时，运行期补一条失败应答（`SendReject(seq, "handler-returned-false")`）并释放句柄，避免悬挂。
- 业务实现抛异常由生成代码 `catch` 并 `RejectRequest`；非生成处理器的异常由运行期兜底（同样回失败应答）。
- 并发上限（8）与队列上限（8）分开计：在途 = 已分发未结算；排队 = 尚未分发。两者都满时先报 `QueueFull`。

### B.6.4 回填：`request` 信封字段清单（供 E6 消费，D4）

`request`（通道 1）：`{ type: "request", requestId, action: "debugQuery", category, instance, iface, method, methodId, args: [{ tag, name, type, value }] }`

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `type` | 是 | 恒 `"request"` |
| `requestId` | 是 | JSON `"req-<n>"`；二进制为载荷头的 `u32`（A.4 的 `debugResult` 布局同源），同一连接内唯一且非 0 |
| `action` | 是 | 恒 `"debugQuery"` |
| `category` | 否 | 分类名；缺省时服务端用槽位绑定的分类补齐（二进制路由依据）；非空且与实例绑定分类不一致按 `invalidArgument` 拒绝 |
| `instance` | 是 | 实例 id；**必须已 `Create` 且未 `Finish`**（A.5 的 `instance` 必填语义） |
| `iface` | 否 | 接口 id（A.5 原本就有的字段，E6 任务文本遗漏了它）；缺省时服务端按分类内方法号唯一性反查（`methodId` 才是分发依据）；已注册但声明表缺该方法号且 `args` 非空按 `invalidArgument` 拒绝（B.6.2） |
| `method` | 否 | 方法名；仅诊断/展示，不参与分发 |
| `methodId` | 是 | u16 方法号，取 A.4 的 `10+` 分类号段（`0` = None、`1`/`2` = Create/Finish、`3–9` 预留）；**与二进制载荷头同一语义**，服务端的分发与参数声明表只认它。缺 `methodId` / 非整数 / 越界 / 落在 `0–9` 保留号段按 `invalidRequest` 丢弃并计入 `dropped.invalidRequest`（C# 侧错误串 `missing-method-id` / `invalid-method-id`；客户端解码同样拒绝 `0–9`，不发必然被拒的请求） |
| `args` | 否 | 载荷参数；每项必须带 `tag`（A.4 的稀疏参数区），值按 A.4 类型码表线上类型给出 |

- 键顺序固定：`type / requestId / action / category / instance / iface / method / methodId / args`。序列化只有 TS 的 `encodeDebugRequest` 一个入口（键序由对象字面量的插入顺序固定），**跨语言没有机械比对**：TS 用例断言该函数的输出字节（含 `args` 省略形态），C# 侧只用 `AssertKeyOrder` 守卫共享 fixture 的键序（C# 只解析、不生产）。
- JSON 信封**没有** `instanceSlot`：服务端由 `instance` 反查槽位；二进制信封在载荷头里携带 `methodId + instanceSlot`（与 A.4 一致），服务端校验二者与实例绑定是否一致，不一致按 `invalidArgument` 拒绝。`methodId` 是两种信封**共有**的字段，语义相同、取值相同。
- 结果/失败都以 `requestId` 关联：`debugResult`（成功，调试流）与 `response`（失败，通道 1）。`iface` / `method` 在结果里**可缺**（见 A.5），消费端必须用 `requestId` 兜底关联，不得因缺字段丢结果。
- 排队/并发/超时/未注册/实例不存在/参数不合法/业务拒绝七类失败由服务端在**调试流之外**以 `response` 回应（B.6.2/B.6.3），E6 负责把 `code` 落成 A.5/A.6 的字段。业务拒绝统一是 `runtime.queryRejected`（A.6，E6 登记），可区分原因在 `detail`。

### B.6.5 回填：pump 注入点归属

- 本任务（D4）只提供 `VisualBridgeDebugQueryRuntime.Pump()`；**实际挂接归 E5**：Player / Play 模式在 `BeforeSceneLoad` 把 `Pump` 注册到 `PlayerLoop` 的 `Update`；Editor 非播放态注册到 `EditorApplication.update`；domain reload 后重新注册。
- `Pump` 记录首次调用的线程，换线程时告警一次（不改变行为）；handler 只在 `Pump` 里执行，socket 读线程永远不直接调用业务实现。
- `Pump` 的返回值为本次执行条数（0/1），供宿主做预算与诊断。
