using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using NUnit.Framework;
using VisualBridge.Diagnostics;
using VisualBridge.Diagnostics.Bridge;

namespace VisualBridge.GraphDebug.Tests
{
    /// <summary>
    /// G1c 的 EditMode 用例：同一段执行事实经发射端产出**预期的事件序列**（方法名、参数、顺序），
    /// 并验证实例生命周期（每会话只 Create 一次、结束才 Finish、断连后自动补建）。
    /// 发射端直接驱动（它就是采集门面的观察者实现），传输与编码器都用假实现：
    /// 采集门面 → 观察者的接线由 Runtime 侧用例覆盖，Play 模式下的端到端由 runtime-e2e 覆盖。
    /// </summary>
    public sealed class VisualBridgeGraphDebugEmitterTests
    {
        private const string Category = "graph";
        private const string InterfaceId = "IGraphDebuger";

        [SetUp]
        public void SetUp()
        {
            VisualBridgeGraphDebugEmitter.Uninstall();
            VisualBridgeDebugBridge.Uninstall();
            VisualBridgeDebug.SetEncoder(null);
            VisualBridgeDebug.SetFrame(-1);
            VisualBridgeDebugReporting.SetEnabled(true);
        }

        [TearDown]
        public void TearDown()
        {
            VisualBridgeGraphDebugEmitter.Uninstall();
            VisualBridgeDebugBridge.Uninstall();
            VisualBridgeDebug.SetEncoder(null);
            VisualBridgeDebugReporting.SetEnabled(true);
        }

        [Test]
        public void EmitsTheContractSequenceOncePerInstance()
        {
            var transport = new RecordingTransport();
            VisualBridgeDebugBridge.Install(transport);
            var encoder = new RecordingEncoder();
            VisualBridgeDebug.SetEncoder(encoder);
            var emitter = VisualBridgeGraphDebugEmitter.Instance;

            emitter.OnInstanceStarted("exec-1", "logicGraph", "encounter", "Encounter", "hero", 1);
            emitter.OnNodeStarted("exec-1", "step_a", 2);
            emitter.OnNodeOutput("exec-1", "step_a", 3, 2);
            emitter.OnDataNode("exec-1", "data_b", 3);
            emitter.OnEdgeValueChanged("exec-1", "data_b", 1, "42", 3);
            emitter.OnInstanceStopped("exec-1", 4);

            // 实例生命周期：开始时一次 Create，结束时一次 Finish；事件再多也不重复 Create。
            Assert.That(transport.Creates.Count, Is.EqualTo(1), "实例只能在开始时 Create 一次。");
            Assert.That(transport.Creates[0].InstanceId, Is.EqualTo("exec-1"));
            Assert.That(transport.Creates[0].Category, Is.EqualTo(Category));
            Assert.That(transport.Creates[0].ResName, Is.EqualTo("Encounter"));
            Assert.That(transport.Creates[0].DebugInfo, Is.EqualTo("logicGraph/encounter @hero"));
            Assert.That(transport.Finishes.Count, Is.EqualTo(1));
            Assert.That(transport.Finishes[0].InstanceId, Is.EqualTo("exec-1"));

            // 方法名与顺序：契约方法名（PascalCase）逐条对应六种执行事实。
            Assert.That(Methods(encoder), Is.EqualTo(new[]
            {
                "InstanceStarted",
                "NodeStarted",
                "NodeOutput",
                "DataNode",
                "EdgeValueChanged",
                "InstanceStopped",
            }));
            foreach (var message in encoder.Messages)
            {
                Assert.That(message.Category, Is.EqualTo(Category));
                Assert.That(message.Iface, Is.EqualTo(InterfaceId));
                Assert.That(message.InstanceId, Is.EqualTo("exec-1"));
                Assert.That(message.InstanceSlot, Is.EqualTo(transport.Creates[0].Slot));
                Assert.That(message.Kind, Is.EqualTo(VisualBridgeDebugMessageKind.Debug));
            }

            // `record.frame` 取的是 Start 时刻的会话帧号：发射端把每条事实的图执行帧同步给它（见下方
            // EachFactSetsTheGraphFrameOnTheSession），所以这里按事实各自的帧号断言；不再单独 SetFrame(7)。
            Assert.That(transport.Events.Count, Is.EqualTo(encoder.Messages.Count));
            foreach (var recorded in transport.Events)
            {
                Assert.That(recorded.Frame, Is.GreaterThanOrEqualTo(-1L));
                Assert.That(recorded.Category, Is.EqualTo(Category));
                Assert.That(recorded.Iface, Is.EqualTo(InterfaceId));
                Assert.That(recorded.Slot, Is.EqualTo(transport.Creates[0].Slot));
            }

            // 实例开始：文档身份 + 图名 + 执行者 + 帧号都是真载荷，不是只有 instanceId 的空壳。
            Assert.That(Parameters(encoder.Messages[0]), Is.EqualTo(new[]
            {
                "documentTypeId=1:logicGraph",
                "documentId=2:encounter",
                "graphName=3:Encounter",
                "debugKey=4:hero",
                "frameIndex=5:1",
            }));
            Assert.That(Parameters(encoder.Messages[1]), Is.EqualTo(new[] { "nodeId=1:step_a", "frameIndex=2:2" }));
            Assert.That(Parameters(encoder.Messages[2]), Is.EqualTo(new[]
            {
                "nodeId=1:step_a",
                "outputIndex=2:3",
                "frameIndex=3:2",
            }));
            Assert.That(Parameters(encoder.Messages[3]), Is.EqualTo(new[] { "nodeId=1:data_b", "frameIndex=2:3" }));
            Assert.That(Parameters(encoder.Messages[4]), Is.EqualTo(new[]
            {
                "nodeId=1:data_b",
                "outputIndex=2:1",
                "value=3:42",
                "frameIndex=4:3",
            }));
            Assert.That(Parameters(encoder.Messages[5]), Is.EqualTo(new[]
            {
                "documentId=1:encounter",
                "frameIndex=2:4",
            }));
        }

        [Test]
        public void DefaultPayloadValuesAreSpreadOutLikeTheWireContract()
        {
            var transport = new RecordingTransport();
            VisualBridgeDebugBridge.Install(transport);
            var encoder = new RecordingEncoder();
            VisualBridgeDebug.SetEncoder(encoder);
            var emitter = VisualBridgeGraphDebugEmitter.Instance;

            emitter.OnInstanceStarted("exec-1", "logicGraph", "encounter", "Encounter", string.Empty, 0);
            emitter.OnNodeOutput("exec-1", "step_a", 0, 0);

            // 附录 A.4/B.2：默认值（0/""）在编码前跳过，参数区是稀疏的。
            // 注意 outputIndex=0 **不在线上**：消费侧只对 nodeOutput 把缺失显式读成 0
            // （`graphDebugFacet.ts` 的 `?? 0`，P1-1 的裁决），这条用例锁的是"线格式稀疏"这一事实。
            Assert.That(Parameters(encoder.Messages[0]), Is.EqualTo(new[]
            {
                "documentTypeId=1:logicGraph",
                "documentId=2:encounter",
                "graphName=3:Encounter",
            }));
            Assert.That(Parameters(encoder.Messages[1]), Is.EqualTo(new[] { "nodeId=1:step_a" }));
        }

        /// <summary>
        /// E11 §2/§3：宿主结算过的断连（<c>Detach</c>）之后，实例由**会话层**按原槽位重放，
        /// 不再依赖发射端自己补建。发射端的 <c>EnsureCreated</c> 自愈仍然保留（见下一条用例），
        /// 但在这条路径上它是**第二道**防线：实例在下一帧之前就已经回到会话里。
        ///
        /// 旧断言（"必须重新 Create 并补发 InstanceStarted"）对应的是"会话复位 = 实例消失"的旧语义；
        /// E11 把"仍然活着的登记"跨会话保留下来，所以这里改成断言重放本身（槽位不变、事件送达）。
        /// </summary>
        [Test]
        public void RestoresTheInstanceByReplayAfterTheDebugSessionResets()
        {
            var transport = new RecordingTransport();
            VisualBridgeDebugBridge.Install(transport);
            var encoder = new RecordingEncoder();
            VisualBridgeDebug.SetEncoder(encoder);
            var emitter = VisualBridgeGraphDebugEmitter.Instance;

            emitter.OnInstanceStarted("exec-1", "logicGraph", "encounter", "Encounter", "hero", 1);
            emitter.OnNodeStarted("exec-1", "step_a", 2);
            Assert.That(transport.Creates.Count, Is.EqualTo(1));
            ushort originalSlot = transport.Creates[0].Slot;

            // 断连：宿主 Detach（会话快照清空、**登记保留**）；重连后 Attach。
            transport.SetConnected(false);
            VisualBridgeDebugBridge.Detach();
            transport.SetConnected(true);
            VisualBridgeDebugBridge.Attach();

            // 新会话里会话层已经把仍活着的实例重放回来，且**沿用原槽位**（E11 §3）。
            Assert.That(transport.Creates.Count, Is.EqualTo(2), "会话复位后必须重放 debugCreate。");
            Assert.That(transport.Creates[1].InstanceId, Is.EqualTo("exec-1"));
            Assert.That(transport.Creates[1].Slot, Is.EqualTo(originalSlot), "重放必须沿用原槽位。");
            Assert.That(VisualBridgeDebug.isInstanceRegistered("exec-1"), Is.True);

            emitter.OnNodeStarted("exec-1", "step_b", 3);

            // 实例已在会话里：发射端不得再 Create（Create 幂等，但重复描述是噪声）；事件照常送达。
            Assert.That(transport.Creates.Count, Is.EqualTo(2), "重放之后发射端不得再次 Create。");
            Assert.That(Methods(encoder), Is.EqualTo(new[]
            {
                "InstanceStarted",
                "NodeStarted",
                "NodeStarted",
            }));
            Assert.That(Parameters(encoder.Messages[2]), Is.EqualTo(new[] { "nodeId=1:step_b", "frameIndex=2:3" }));
            Assert.That(transport.Events.Count, Is.EqualTo(3));
            Assert.That(transport.Events[2].Slot, Is.EqualTo(originalSlot), "事件必须按重放后的槽位发出。");
        }

        /// <summary>
        /// E11 的分界：**宿主没有结算**（没有 <c>Detach</c>）的断连仍按旧语义作废登记，此时
        /// 发射端的自愈（<c>EnsureCreated</c>）是恢复路径——它必须继续有效，否则这类断连就再也回不来。
        /// </summary>
        [Test]
        public void RecreatesTheInstanceWhenTheDisconnectWasNotSettledByTheHost()
        {
            var transport = new RecordingTransport();
            VisualBridgeDebugBridge.Install(transport);
            var encoder = new RecordingEncoder();
            VisualBridgeDebug.SetEncoder(encoder);
            var emitter = VisualBridgeGraphDebugEmitter.Instance;

            emitter.OnInstanceStarted("exec-1", "logicGraph", "encounter", "Encounter", "hero", 1);
            Assert.That(transport.Creates.Count, Is.EqualTo(1));

            // 断连但没有宿主结算：一次冷路径调用让会话自己观察到断连（登记随旧语义作废）。
            transport.SetConnected(false);
            Assert.That(VisualBridgeDebug.Create("other", Category, "R", string.Empty), Is.True);
            transport.SetConnected(true);
            VisualBridgeDebugBridge.Attach();
            encoder.Messages.Clear();

            emitter.OnNodeStarted("exec-1", "step_b", 3);

            // 发射端自愈：重新 Create 并补发 InstanceStarted，事件才能送达。
            Assert.That(transport.Creates.Count, Is.EqualTo(3), "未被宿主结算的断连后，发射端必须自愈补建。");
            Assert.That(Methods(encoder), Is.EqualTo(new[] { "InstanceStarted", "NodeStarted" }));
            Assert.That(Parameters(encoder.Messages[1]), Is.EqualTo(new[] { "nodeId=1:step_b", "frameIndex=2:3" }));
        }

        [Test]
        public void QueuesTheCreateWhileDisconnectedAndAnnouncesOnTheNextFact()
        {
            var transport = new RecordingTransport(connected: false);
            VisualBridgeDebugBridge.Install(transport);
            var encoder = new RecordingEncoder();
            VisualBridgeDebug.SetEncoder(encoder);
            var emitter = VisualBridgeGraphDebugEmitter.Instance;

            emitter.OnInstanceStarted("exec-1", "logicGraph", "encounter", "Encounter", "hero", 1);
            // 已挂接未连接：Create 只入待发队列，实例描述还发不出去。
            Assert.That(transport.Creates.Count, Is.EqualTo(0));
            // 连接建立后 flush 待发描述。
            transport.SetConnected(true);
            VisualBridgeDebugBridge.Attach();
            Assert.That(transport.Creates.Count, Is.EqualTo(1));

            // 连接建立前的 InstanceStarted 不发（发了必丢并计 dropped），第一条事实补发。
            emitter.OnNodeStarted("exec-1", "step_a", 2);
            Assert.That(Methods(encoder), Is.EqualTo(new[] { "InstanceStarted", "NodeStarted" }));
            Assert.That(transport.Creates.Count, Is.EqualTo(1), "补发不得重复 Create。");
        }

        [Test]
        public void DoesNothingForAFactOfAnUnknownInstance()
        {
            var transport = new RecordingTransport();
            VisualBridgeDebugBridge.Install(transport);
            var encoder = new RecordingEncoder();
            VisualBridgeDebug.SetEncoder(encoder);
            var emitter = VisualBridgeGraphDebugEmitter.Instance;

            emitter.OnNodeStarted("exec-missing", "step_a", 2);
            emitter.OnInstanceStopped("exec-missing", 3);

            Assert.That(transport.Creates.Count, Is.EqualTo(0));
            Assert.That(transport.Finishes.Count, Is.EqualTo(0));
            Assert.That(encoder.Messages.Count, Is.EqualTo(0));
        }

        [Test]
        public void ResetFinishesTheRegisteredInstances()
        {
            var transport = new RecordingTransport();
            VisualBridgeDebugBridge.Install(transport);
            var encoder = new RecordingEncoder();
            VisualBridgeDebug.SetEncoder(encoder);
            var emitter = VisualBridgeGraphDebugEmitter.Instance;

            emitter.OnInstanceStarted("exec-1", "logicGraph", "encounter", "Encounter", "hero", 1);
            encoder.Messages.Clear();
            emitter.Reset();

            // 登记还活着：Reset 必须补齐 InstanceStopped + Finish，不能留下"Create 过、永不 Finish"。
            Assert.That(transport.Finishes.Count, Is.EqualTo(1), "Reset 必须对仍登记的实例补 Finish。");
            Assert.That(transport.Finishes[0].InstanceId, Is.EqualTo("exec-1"));
            Assert.That(Methods(encoder), Is.EqualTo(new[] { "InstanceStopped" }));

            // 之后这条实例的事实不再产生消息（登记已清），也不会重新 Create。
            encoder.Messages.Clear();
            emitter.OnNodeStarted("exec-1", "step_a", 2);
            Assert.That(encoder.Messages.Count, Is.EqualTo(0));
            Assert.That(transport.Creates.Count, Is.EqualTo(1));
        }

        [Test]
        public void ResetSkipsFinishWhenTheSessionAlreadyDroppedTheInstance()
        {
            var transport = new RecordingTransport();
            VisualBridgeDebugBridge.Install(transport);
            var encoder = new RecordingEncoder();
            VisualBridgeDebug.SetEncoder(encoder);
            var emitter = VisualBridgeGraphDebugEmitter.Instance;

            emitter.OnInstanceStarted("exec-1", "logicGraph", "encounter", "Encounter", "hero", 1);

            // 会话先被服务端清空（Detach 语义）：远端已经没有任何实例可结束。
            transport.SetConnected(false);
            VisualBridgeDebugBridge.Detach();
            encoder.Messages.Clear();
            Assert.That(VisualBridgeDebugSession.LiveRegistrations, Is.EqualTo(1),
                "Detach 只清会话快照，登记仍在（E11）。");

            emitter.Reset();

            // 不能对不存在的实例 Finish（那只会得到 false + 告警），也不该发 InstanceStopped。
            Assert.That(transport.Finishes.Count, Is.EqualTo(0), "会话已清空时不得 Finish 一个不存在的实例。");
            Assert.That(encoder.Messages.Count, Is.EqualTo(0));
            // **E11（评审 P1-2）的判别点**：`Reset` 必须把登记一起结清（`Finish` 不再被
            // "实例已不在快照"跳过）；回退那处改动会让僵尸登记留到下一次重连被重放。
            Assert.That(VisualBridgeDebugSession.LiveRegistrations, Is.EqualTo(0),
                "Reset 必须注销登记，否则下一次重连会重放已经停止的执行。");
        }

        /// <summary>
        /// E11（评审 P1-2）：<c>OnInstanceStopped</c> 的 `Finish` 也不能被"会话已复位"跳过。
        /// 回退那处改动 ⇒ <c>LiveRegistrations</c> 停在 1，下一次重连会把已经结束的执行重放回来。
        /// 同时锁定"未登记时不发 InstanceStopped"（与改动前同一行为：会话对未登记实例的 Start 返回
        /// false，消息整条被丢弃、不编码也不计数）。
        /// </summary>
        [Test]
        public void InstanceStoppedDropsTheRegistrationWhenTheSessionAlreadyReset()
        {
            var transport = new RecordingTransport();
            VisualBridgeDebugBridge.Install(transport);
            var encoder = new RecordingEncoder();
            VisualBridgeDebug.SetEncoder(encoder);
            var emitter = VisualBridgeGraphDebugEmitter.Instance;

            emitter.OnInstanceStarted("exec-1", "logicGraph", "encounter", "Encounter", "hero", 1);
            transport.SetConnected(false);
            VisualBridgeDebugBridge.Detach();
            encoder.Messages.Clear();
            Assert.That(VisualBridgeDebugSession.LiveRegistrations, Is.EqualTo(1));

            emitter.OnInstanceStopped("exec-1", 3);

            Assert.That(transport.Finishes.Count, Is.EqualTo(0), "远端没有这个实例，不得写 Finishes。");
            Assert.That(encoder.Messages.Count, Is.EqualTo(0), "未登记实例的 InstanceStopped 不编码、不发。");
            Assert.That(VisualBridgeDebugSession.LiveRegistrations, Is.EqualTo(0),
                "实例结束必须注销登记，否则下一次重连会复活它。");
        }

        /// <summary>
        /// E11（评审 P2-1）：**结束没生效**（抑制期 / 队列满）时，发射端不能丢本地实例。
        ///
        /// 会话会保留登记（P1-1 的修复），重连时把它重放给面板；若发射端已经把本地实例删掉，
        /// 面板上就会出现一个"活着但永不更新"的**幽灵**——发送端再也不产事件，会话却认为它还在跑。
        /// 红态（改回无条件 `Instances.Remove` / `FinishAll` 清空）：抑制期 Finish 之后
        /// `OnNodeStarted` 不再产出任何事件，本用例第一条断言即红。
        /// </summary>
        [Test]
        public void SuppressedFinishKeepsTheLocalInstanceSoAReplayCannotCreateAGhost()
        {
            var transport = new RecordingTransport();
            VisualBridgeDebugBridge.Install(transport);
            var encoder = new RecordingEncoder();
            VisualBridgeDebug.SetEncoder(encoder);
            var emitter = VisualBridgeGraphDebugEmitter.Instance;

            emitter.OnInstanceStarted("exec-1", "logicGraph", "encounter", "Encounter", "hero", 1);
            Assert.That(transport.Creates.Count, Is.EqualTo(1));

            // 结束没生效：真实触发是关闭期抑制 / 控制队列满，二者都表现为**传输层**让 SendFinish 返回 false。
            transport.FailFinish = true;
            emitter.OnInstanceStopped("exec-1", 2);
            Assert.That(transport.Finishes.Count, Is.EqualTo(0));
            transport.FailFinish = false;

            // 结束没生效 ⇒ 发射端必须保留本地登记：下一条事实仍然产事件（不是"活着但静默"）。
            encoder.Messages.Clear();
            emitter.OnNodeStarted("exec-1", "step_b", 3);
            Assert.That(Methods(encoder), Is.EqualTo(new[] { "NodeStarted" }),
                "抑制期 Finish 失败后，发射端不得丢掉本地实例（否则后续事实全部静默）。");

            // 会话结算断连 → 重连：登记被重放，而且**仍然产事件** —— 与"被重放成活实例"自洽。
            VisualBridgeDebugBridge.Detach();
            VisualBridgeDebugBridge.Attach();
            Assert.That(transport.Creates.Count, Is.EqualTo(2), "仍活着的登记必须在重连时重放。");
            encoder.Messages.Clear();
            emitter.OnNodeStarted("exec-1", "step_c", 4);
            Assert.That(Methods(encoder), Is.EqualTo(new[] { "NodeStarted" }),
                "重放之后发射端仍须为该实例产事件——否则面板上就是一个永不更新的幽灵。");
        }

        [Test]
        public void ResetDropsTheRegisteredInstances()
        {
            var transport = new RecordingTransport();
            VisualBridgeDebugBridge.Install(transport);
            var encoder = new RecordingEncoder();
            VisualBridgeDebug.SetEncoder(encoder);
            var emitter = VisualBridgeGraphDebugEmitter.Instance;

            emitter.OnInstanceStarted("exec-1", "logicGraph", "encounter", "Encounter", "hero", 1);
            emitter.Reset();
            encoder.Messages.Clear();

            emitter.OnNodeStarted("exec-1", "step_a", 2);
            Assert.That(encoder.Messages.Count, Is.EqualTo(0));
            Assert.That(transport.Creates.Count, Is.EqualTo(1), "Reset 之后不该重建已被结束的实例。");
        }

        /// <summary>
        /// 发射端公开实例成员的**显式分类表**（G1c2）：每个成员必须归入两类之一，没有"默认归类"。
        /// - `EmitsRecord = true`：会产生调试流 record，必须被下面 `cases` 的某一行以同名 `Path` 覆盖；
        /// - `EmitsRecord = false`：不产生 record，第三列写明为什么。
        ///
        /// `DebugInfo` 定义在发射端的内部实例描述类型 `EmittedInstance` 上（同文件末尾），不是
        /// <see cref="VisualBridgeGraphDebugEmitter"/> 自己的方法；它仍纳入本表，因为它是这条路径上
        /// 另一个公开实例方法，不显式归类就会成为下一次"新增成员没人管"的盲区。
        /// 反射范围见用例内的 `emitterTypes`：发射端本身 + **它的全部嵌套类型**（不硬编码类型名）。
        /// </summary>
        private static readonly (string Name, bool EmitsRecord, string Reason)[] EmitterInstanceMemberClassification =
        {
            ("OnInstanceStarted", true, "Create + InstanceStarted（连接建立后补发走同一入口）"),
            ("OnInstanceStopped", true, "InstanceStopped + Finish"),
            ("OnNodeStarted", true, "NodeStarted"),
            ("OnNodeOutput", true, "NodeOutput"),
            ("OnDataNode", true, "DataNode"),
            ("OnEdgeValueChanged", true, "EdgeValueChanged"),
            ("Reset", true, "为仍登记着的实例补发 InstanceStopped"),
            ("DebugInfo", false, "EmittedInstance 的只读实例描述（文档身份 + 执行者），只作为 Create 载荷，不写调试流"),
        };

        /// <summary>
        /// 公开入口 → 该入口**自己**产出的 record 方法（G1c2 P2-2 的绑定表）。
        ///
        /// `cases` 的 `Path` 只是声明，光比较集合看不出"这行实际调的是不是它"；每行 Arrange 以 `Path`
        /// 入口收尾，因此逐行断言"该行**最后一条** record 必须正好是这张表给该入口登记的 record"，
        /// 只改 Path 或只改 Arrange 都会红（"包含"不够：同行前面的 record 会替错误的 Path 蒙混过关）。
        /// 事实入口遵循 `On&lt;Record&gt;` 命名；`Reset` 是唯一的非事实入口，它补发的是
        /// `InstanceStopped`（与 `OnInstanceStopped` 同一种 record），按真实产出登记，不硬凑同名。
        /// 表与分类表的"产生 record"集合双向相等由用例断言，新增入口时必须两边一起加。
        /// </summary>
        private static readonly (string Entry, string Record)[] RecordProducedByEntry =
        {
            ("OnInstanceStarted", "InstanceStarted"),
            ("OnInstanceStopped", "InstanceStopped"),
            ("OnNodeStarted", "NodeStarted"),
            ("OnNodeOutput", "NodeOutput"),
            ("OnDataNode", "DataNode"),
            ("OnEdgeValueChanged", "EdgeValueChanged"),
            ("Reset", "InstanceStopped"),
        };

        /// <summary>
        /// 每 Path 的**期望行数**（G1c2 变异 2 的守卫，选 (a)）：`OnNodeStarted` 由两行覆盖——事实行
        /// `nodeStarted` 与自愈补发行的 `replayedInstanceStarted`，其余 Path 各一行。
        ///
        /// 与 `cases` 按 Path 分组后的计数**双向相等**：删掉任意一行 ⇒ 计数对不上 ⇒ 红；cases 出现表外
        /// 的 Path ⇒ 键集合对不上 ⇒ 红。选 (a) 而不是常量 8：这张表能表达"OnNodeStarted 被两行覆盖"
        /// 这个真实结构，而总数常量在"删一行、另加一行别的 Path"时仍可能凑够 8 而变绿。
        /// </summary>
        private static readonly (string Path, int Rows)[] ExpectedCaseRowsPerPath =
        {
            ("OnInstanceStarted", 1),
            ("OnInstanceStopped", 1),
            ("OnNodeStarted", 2),
            ("OnNodeOutput", 1),
            ("OnDataNode", 1),
            ("OnEdgeValueChanged", 1),
            ("Reset", 1),
        };

        /// <summary>
        /// 表 B 的类级断言：**所有**会产生一条 record 的调用路径，其 `record.frame` 必须等于该 record 载荷里的
        /// `frameIndex`（无并发生产者时）。覆盖：正常四类事实、补发的 InstanceStarted（会话重置后）、
        /// InstanceStopped、Reset 补的 InstanceStopped。
        ///
        /// G1c2 起不再直接比较"反射枚举到的全部公开实例方法"与 cases：那样无法表达"某个公开入口
        /// **故意**不产生 record"（`DebugInfo`），一加进来就会把表逼成"删行/放水"。现在分四步守卫：
        /// ① 分类表与代码的公开实例成员**双向相等**（代码里有而表里没列 ⇒ 红；表里列了而代码里没有 ⇒ 红）；
        /// ② 分类为"产生 record"的入口与 cases 的 `Path` 集合**双向相等**（漏掉一条 Path ⇒ 红；指向
        ///    非 record 成员 ⇒ 红）。注意 `coveredPaths` 是去重后的集合，它**抓不住**同一 Path 有两行时
        ///    删掉其中一行，所以还需要 ④；
        /// ③ **每行的 Path 与驱动绑定**：每行 Arrange 的**最后一个动作**必须是调用 `Path` 那个入口，
        ///    因此该行实际产出的 record 序列必须等于声明的 `ExpectedRecords`，并且**最后一条**必须正好是
        ///    `RecordProducedByEntry` 给该 `Path` 登记的 record——只改 Path、只改 Arrange、或新加一行却
        ///    调用别的入口，都会红；
        /// ④ **每 Path 的行数**（选 (a)：期望行数表 `ExpectedCaseRowsPerPath`）与 cases 分组计数**双向
        ///    相等**：删掉任意一行都红（`OnNodeStarted` 期望 2 行，由事实行与自愈补发行共同覆盖）。
        /// **边界（别读成类级自动覆盖）**：行本身仍是**手工**安排驱动步骤——每条路径的前置状态不同
        /// （事实要求实例已登记、补发要求先断连、Reset 要求先有实例），反射造不出前置条件，
        /// 所以它只能保证"漏一条 Path / 删一行 / 调错入口 / 改错 Path 就红"，不能保证"新路径自动被驱动"。
        /// </summary>
        [Test]
        public void EveryRecordFrameEqualsItsPayloadFrameIndex()
        {
            // 每行四部分：Arrange 驱动哪个入口（Path）、该行**真实产出**的 record 方法序列
            // （ExpectedRecords，按产出顺序）、构造前置状态的动作。ExpectedRecords 不是 Path 的同义词：
            // `replayedInstanceStarted` 由 `OnNodeStarted` 驱动，产出 `InstanceStarted + NodeStarted`；
            // `resetInstanceStopped` 由 `Reset` 驱动，产出 `InstanceStopped`——按真实产出写，不硬凑同名。
            // Arrange 必须**以 Path 那个入口的调用收尾**（前置状态动作只能放它前面）：`replayedInstanceStarted`
            // 的最后一步是 `OnNodeStarted`，`resetInstanceStopped` 的最后一步是 `Reset`。断言只认"最后一条
            // record"，所以不要为了凑断言去改动作顺序——若最后一条 record 不是绑定的那条，先查绑定表。
            var cases = new (string Name, string Path, string[] ExpectedRecords, Action<VisualBridgeGraphDebugEmitter, RecordingTransport> Arrange)[]
            {
                ("instanceStarted", "OnInstanceStarted", new[] { "InstanceStarted" }, (emitter, _) => emitter.OnInstanceStarted("exec-1", "logicGraph", "encounter", "Encounter", "hero", 3)),
                // 四类节点/边事实都要求"登记已存在"（`Prepare` 只对已登记实例发事件），所以先起实例。
                ("nodeStarted", "OnNodeStarted", new[] { "InstanceStarted", "NodeStarted" }, (emitter, _) => { emitter.OnInstanceStarted("exec-1", "logicGraph", "encounter", "Encounter", "hero", 3); emitter.OnNodeStarted("exec-1", "step_a", 4); }),
                ("nodeOutput", "OnNodeOutput", new[] { "InstanceStarted", "NodeOutput" }, (emitter, _) => { emitter.OnInstanceStarted("exec-1", "logicGraph", "encounter", "Encounter", "hero", 3); emitter.OnNodeOutput("exec-1", "step_a", 1, 5); }),
                ("dataNode", "OnDataNode", new[] { "InstanceStarted", "DataNode" }, (emitter, _) => { emitter.OnInstanceStarted("exec-1", "logicGraph", "encounter", "Encounter", "hero", 3); emitter.OnDataNode("exec-1", "data_b", 6); }),
                ("edgeValueChanged", "OnEdgeValueChanged", new[] { "InstanceStarted", "EdgeValueChanged" }, (emitter, _) => { emitter.OnInstanceStarted("exec-1", "logicGraph", "encounter", "Encounter", "hero", 3); emitter.OnEdgeValueChanged("exec-1", "step_a", 2, "v", 7); }),
                // 补发路径：会话重置后再来一条事实 ⇒ 发射端自愈重建实例并补发 InstanceStarted，
                // 其 `record.frame` 必须等于这条事实的图执行帧号（帧号提前同步，P1-1 的回归点）。
                // 场景用"无连接时起实例"构造待发描述（连接态起实例不会留下待发），随后断连语义清空会话。
                ("replayedInstanceStarted", "OnNodeStarted", new[] { "InstanceStarted", "NodeStarted" }, (emitter, transport) =>
                {
                    transport.SetConnected(false);
                    emitter.OnInstanceStarted("exec-1", "logicGraph", "encounter", "Encounter", "hero", 3);
                    transport.SetConnected(true);
                    ResetSession();
                    emitter.OnNodeStarted("exec-1", "step_a", 11);
                }),
                ("instanceStopped", "OnInstanceStopped", new[] { "InstanceStarted", "InstanceStopped" }, (emitter, _) =>
                {
                    emitter.OnInstanceStarted("exec-1", "logicGraph", "encounter", "Encounter", "hero", 3);
                    emitter.OnInstanceStopped("exec-1", 12);
                }),
                // Reset 补的 InstanceStopped：帧号取会话当前帧（最近一次事实的帧），不再是占位 0。
                ("resetInstanceStopped", "Reset", new[] { "InstanceStarted", "NodeStarted", "InstanceStopped" }, (emitter, _) =>
                {
                    emitter.OnInstanceStarted("exec-1", "logicGraph", "encounter", "Encounter", "hero", 3);
                    emitter.OnNodeStarted("exec-1", "step_a", 13);
                    emitter.Reset();
                }),
            };

            // 成员分类守卫（G1c2）：先证明"分类表 == 代码里的公开实例成员"（双向），再证明
            // "分类为产生 record 的成员 == cases 的 Path 集合"（双向），最后证明"Path 与驱动绑定"。
            //
            // 反射范围 = 发射端本身 + **直接**嵌套类型（P2-3：不再硬编码 `EmittedInstance` 一个名字）。
            // 将来在发射端里加第三个带 public 实例方法的嵌套类型时，成员集合自动变大、分类表缺项 ⇒ 红，
            // 逼作者显式归类。唯一排除的是编译器生成的闭包类型（如 `<>c__DisplayClass`）：它们的方法
            // 不是发射端入口，收进来只会让这条守卫永远红。
            // 边界一：`GetNestedTypes` 只取**直接**嵌套层（不递归）。将来新增"嵌套里再嵌套"的类型时，
            // 要改成递归枚举或显式列出，否则它的 public 实例方法不会被这条守卫看见。
            // 边界二：下面枚举用的 `BindingFlags.Instance` **不含 static** 成员。将来新增 static 入口时，
            // 要单独把它纳入反射范围（静态公开方法当前不在分类表与 Path 守卫内）。
            var emitterTypes = new[] { typeof(VisualBridgeGraphDebugEmitter) }
                .Concat(typeof(VisualBridgeGraphDebugEmitter)
                    .GetNestedTypes(BindingFlags.Public | BindingFlags.NonPublic)
                    .Where(type => type.GetCustomAttribute<CompilerGeneratedAttribute>() == null))
                .ToArray();
            Assert.That(emitterTypes.Length, Is.GreaterThan(1),
                "发射端至少应有一个嵌套类型（当前是 EmittedInstance，DebugInfo 定义在它上面）；"
                + "若这个类型被移走，请同步更新这里的反射范围与分类表。");
            var codeMembers = emitterTypes
                .SelectMany(type => type.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly))
                .Where(method => !method.IsSpecialName)
                .Select(method => method.Name)
                .OrderBy(name => name, StringComparer.Ordinal)
                .ToArray();
            var classifiedMembers = EmitterInstanceMemberClassification
                .Select(member => member.Name)
                .OrderBy(name => name, StringComparer.Ordinal)
                .ToArray();
            foreach (var member in EmitterInstanceMemberClassification)
            {
                Assert.That(member.Reason, Is.Not.Empty,
                    member.Name + "：分类项必须写明它产生/不产生 record 的理由。");
            }

            // 方向一：表里列了而代码里没有 ⇒ 红（防止名单腐化成"什么都归类"）。
            Assert.That(classifiedMembers.Except(codeMembers), Is.Empty,
                "分类表登记了发射端代码里不存在的公开实例成员（表与代码漂移）。");
            // 方向二：代码里有而表里没列 ⇒ 红（新增入口必须显式归类，不许靠名字前缀混过去）。
            Assert.That(codeMembers.Except(classifiedMembers), Is.Empty,
                "发射端有公开实例成员没有在分类表里显式归类：产生 record 的必须在 cases 里加一行，"
                + "不产生的必须写明原因。");

            var recordPaths = EmitterInstanceMemberClassification
                .Where(member => member.EmitsRecord)
                .Select(member => member.Name)
                .OrderBy(name => name, StringComparer.Ordinal)
                .ToArray();
            var coveredPaths = cases.Select(testCase => testCase.Path).Distinct()
                .OrderBy(name => name, StringComparer.Ordinal).ToArray();
            // 方向一：cases 指向了"不产生 record"的成员（或表外成员）⇒ 红。
            Assert.That(coveredPaths.Except(recordPaths), Is.Empty,
                "cases 的 Path 必须指向分类表里标记为'产生 record'的公开入口（每行都要写明它由谁驱动）。");
            // 方向二：有产生 record 的入口却没有任何 cases 行覆盖 ⇒ 红（漏掉一条 Path 不再能悄悄变绿）。
            Assert.That(recordPaths.Except(coveredPaths), Is.Empty,
                "分类表里有产生 record 的公开入口没有被 cases 覆盖：新增一条产生 record 的入口时，为它加一行。");

            // 行数守卫（变异 2，选 (a) 期望行数表）：上面比较的是 `Distinct()` 后的 Path 集合，同一 Path
            // 有两行时删掉其中一行它仍然相等——被删的那行会静默失去覆盖（例如 P1-1 的自愈补发行）。
            // 所以这里按 Path 数行数，并与 `ExpectedCaseRowsPerPath` 双向比较：删掉任意一行都红。
            var actualRowsPerPath = cases
                .GroupBy(testCase => testCase.Path)
                .ToDictionary(group => group.Key, group => group.Count());
            var expectedRowsPerPath = ExpectedCaseRowsPerPath
                .ToDictionary(entry => entry.Path, entry => entry.Rows);
            Assert.That(actualRowsPerPath.Keys, Is.EquivalentTo(expectedRowsPerPath.Keys),
                "cases 的 Path 与 ExpectedCaseRowsPerPath 的键必须双向一致：增删一条路径时必须同步这张行数表。");
            foreach (var expectedRows in ExpectedCaseRowsPerPath)
            {
                Assert.That(actualRowsPerPath[expectedRows.Path], Is.EqualTo(expectedRows.Rows),
                    expectedRows.Path + "：期望 " + expectedRows.Rows + " 行 cases 覆盖它；"
                    + "删行不能靠别的行覆盖同一个 Path 蒙混过去。");
            }

            // Path → 该入口自己产出的 record 的登记表必须与"产生 record 的入口"双向相等：
            // 否则新增入口可以只加 cases 行、不加绑定，P2-2 的每行断言就会在 `Single` 上抛异常或漏检。
            var boundPaths = RecordProducedByEntry
                .Select(entry => entry.Entry)
                .OrderBy(name => name, StringComparer.Ordinal)
                .ToArray();
            Assert.That(boundPaths.Except(recordPaths), Is.Empty,
                "RecordProducedByEntry 登记了分类表里不产生 record 的入口（绑定表与分类表漂移）。");
            Assert.That(recordPaths.Except(boundPaths), Is.Empty,
                "分类表里有产生 record 的入口没有登记它产出的 record：新增入口时分类表与 RecordProducedByEntry 要同时加。");

            foreach (var testCase in cases)
            {
                var transport = new RecordingTransport();
                VisualBridgeDebugBridge.Install(transport);
                var encoder = new RecordingEncoder();
                VisualBridgeDebug.SetEncoder(encoder);
                var emitter = VisualBridgeGraphDebugEmitter.Instance;
                VisualBridgeDebug.SetFrame(-1);

                // 每个分支都从干净状态开始：上一分支的观察者登记必须清掉，否则这条实例会被判成"已存在"。
                VisualBridgeGraphDebugEmitter.Install();
                testCase.Arrange(emitter, transport);

                var records = transport.Events;
                Assert.That(records.Count, Is.GreaterThan(0), testCase.Name + "：应至少产生一条 record。");
                // 逐行绑定：这行**实际**产出的 record 序列必须等于它声明的真实产出；且 Arrange 以 Path 入口
                // 收尾 ⇒ **最后一条** record 必须正好是 RecordProducedByEntry 给该 Path 登记的那条。
                // 只改 Path 时"包含"仍可能成立（同一行前面的 record 会撞上错误 Path 的登记），
                // 所以这里断言末条相等，不能只断言包含。
                var producedMethods = records.Select(entry => entry.Method).ToArray();
                Assert.That(producedMethods, Is.EqualTo(testCase.ExpectedRecords),
                    testCase.Name + "：这行由 " + testCase.Path + " 驱动，产出的 record 方法序列必须等于该行声明的真实产出。");
                var recordForPath = RecordProducedByEntry.Single(entry => entry.Entry == testCase.Path).Record;
                Assert.That(producedMethods[^1], Is.EqualTo(recordForPath),
                    testCase.Name + "：Arrange 的最后一个动作必须是 " + testCase.Path
                    + "，因此最后一条 record 必须是它登记的 " + recordForPath
                    + "（只改 Path 或只改 Arrange 都会在这里红）。");
                foreach (var (slot, methodId, category, iface, method, frame) in records)
                {
                    var message = encoder.Messages.First(entry => entry.InstanceSlot == slot && entry.Method == method);
                    var payloadFrames = message.Parameters
                        .Where(parameter => parameter.Name == "frameIndex")
                        .Select(parameter => (long)(int)parameter.Value)
                        .ToList();
                    // 载荷里缺席 = 值 0（默认值不进载荷，附录 A.4/B.2）⇒ "缺席 ⇒ 0"，不是"缺席 ⇒ 无帧"。
                    var payloadFrame = payloadFrames.Count == 0 ? 0L : payloadFrames[0];

                    Assert.That(frame, Is.EqualTo(payloadFrame),
                        testCase.Name + "：" + method + " 的 record.frame 必须等于载荷 frameIndex。");
                }

                VisualBridgeGraphDebugEmitter.Uninstall();
                VisualBridgeDebugBridge.Uninstall();
                VisualBridgeDebug.SetEncoder(null);
            }
        }

        /// <summary>模拟"会话重置完成、已重新挂接"（会话按断连语义清空实例/槽位/待发描述）。</summary>
        private static void ResetSession()
        {
            VisualBridgeDebugBridge.Detach();
            VisualBridgeDebugBridge.Attach();
        }

        private static string[] Methods(RecordingEncoder encoder)
        {
            return encoder.Messages.Select(message => message.Method).ToArray();
        }

        private static string[] Parameters(RecordedMessage message)
        {
            return message.Parameters
                .Select(parameter => parameter.Name + "=" + parameter.Tag + ":" + parameter.Value)
                .ToArray();
        }

        private sealed class RecordedMessage
        {
            public RecordedMessage(
                VisualBridgeDebugMessageKind kind,
                string instanceId,
                string category,
                string iface,
                string method,
                ushort methodId,
                ushort instanceSlot)
            {
                Kind = kind;
                InstanceId = instanceId;
                Category = category;
                Iface = iface;
                Method = method;
                MethodId = methodId;
                InstanceSlot = instanceSlot;
            }

            public VisualBridgeDebugMessageKind Kind { get; }

            public string InstanceId { get; }

            public string Category { get; }

            public string Iface { get; }

            public string Method { get; }

            public ushort MethodId { get; }

            public ushort InstanceSlot { get; }

            public List<(string Name, ushort Tag, object Value)> Parameters { get; } =
                new List<(string, ushort, object)>();
        }

        /// <summary>假编码器：记录 Begin/PushParam，用来断言方法名、顺序与参数 tag。</summary>
        private sealed class RecordingEncoder : IDebugMessageEncoder
        {
            private RecordedMessage current;

            public List<RecordedMessage> Messages { get; } = new List<RecordedMessage>();

            public void Begin(
                VisualBridgeDebugMessageKind kind,
                string instanceId,
                string category,
                string iface,
                string method,
                ushort methodId,
                ushort instanceSlot,
                uint requestId)
            {
                current = new RecordedMessage(
                    kind,
                    instanceId,
                    category,
                    iface,
                    method,
                    methodId,
                    instanceSlot);
            }

            public void PushParam(string name, ushort tag, object value)
            {
                current.Parameters.Add((name, tag, value));
            }

            public VisualBridgeDebugEncodedMessage End()
            {
                Messages.Add(current);
                current = null;
                return new VisualBridgeDebugEncodedMessage(
                    VisualBridgeDebugPayloadFormat.Json,
                    VisualBridgeDebugTargetQueue.Data,
                    new byte[] { 0x7B, 0x7D });
            }
        }

        /// <summary>假传输：记录 Create/Finish/事件；未连接时任何发送都视为契约破坏。</summary>
        private sealed class RecordingTransport : IVisualBridgeDebugTransport
        {
            private bool connected;
            private long generation;

            public RecordingTransport(bool connected = true)
            {
                this.connected = connected;
            }

            public bool IsConnected => connected;

            public ConnectType ConnectType => ConnectType.Editor;

            public long ConnectionGeneration => generation;

            public List<(string InstanceId, string Category, string ResName, string DebugInfo, ushort Slot)> Creates { get; } =
                new List<(string, string, string, string, ushort)>();

            public List<(string InstanceId, ushort Slot)> Finishes { get; } = new List<(string, ushort)>();

            public List<(ushort Slot, ushort MethodId, string Category, string Iface, string Method, long Frame)> Events
                { get; } = new List<(ushort, ushort, string, string, string, long)>();

            public void SetConnected(bool value)
            {
                connected = value;
                if (value)
                {
                    generation++;
                }
            }

            public bool SendCreate(string instanceId, string category, string resName, string debugInfo,
                ushort instanceSlot)
            {
                EnsureConnected();
                Creates.Add((instanceId, category, resName, debugInfo, instanceSlot));
                return true;
            }

            /// <summary>模拟"结束没生效"（关闭期抑制 / 控制队列满）：Finish 返回 false 且不记录。</summary>
            public bool FailFinish { get; set; }

            public bool SendFinish(string instanceId, ushort instanceSlot)
            {
                EnsureConnected();
                if (FailFinish)
                {
                    return false;
                }

                Finishes.Add((instanceId, instanceSlot));
                return true;
            }

            public bool SendEvent(ushort instanceSlot, ushort methodId, string category, string iface, string method,
                long frame, VisualBridgeDebugEncodedMessage message)
            {
                EnsureConnected();
                Events.Add((instanceSlot, methodId, category, iface, method, frame));
                return true;
            }

            public bool SendResult(uint requestSeq, VisualBridgeDebugEncodedMessage message)
            {
                EnsureConnected();
                return true;
            }

            public bool SendQueryError(uint requestSeq, string code, string detail)
            {
                EnsureConnected();
                return true;
            }

            public bool SendControl(VisualBridgeDebugEncodedMessage message)
            {
                EnsureConnected();
                return true;
            }

            public bool SendReject(uint requestSeq, string reason)
            {
                EnsureConnected();
                return true;
            }

            private void EnsureConnected()
            {
                if (!connected)
                {
                    throw new InvalidOperationException("RecordingTransport 已断开，不应收到消息。");
                }
            }
        }
    }
}
