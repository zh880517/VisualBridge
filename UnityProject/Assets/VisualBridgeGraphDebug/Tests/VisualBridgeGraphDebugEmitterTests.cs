using System;
using System.Collections.Generic;
using System.Linq;
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
        /// 表 B 的类级断言：**所有**会产生一条 record 的调用路径，其 `record.frame` 必须等于该 record 载荷里的
        /// `frameIndex`（无并发生产者时）。覆盖：正常四类事实、补发的 InstanceStarted（会话重置后）、
        /// InstanceStopped、Reset 补的 InstanceStopped。新增一条产生 record 的路径时，这里应该跟着加一行。
        /// </summary>
        [Test]
        public void EveryRecordFrameEqualsItsPayloadFrameIndex()
        {
            var cases = new (string Name, Action<VisualBridgeGraphDebugEmitter, RecordingTransport> Arrange)[]
            {
                ("instanceStarted", (emitter, _) => emitter.OnInstanceStarted("exec-1", "logicGraph", "encounter", "Encounter", "hero", 3)),
                // 四类节点/边事实都要求"登记已存在"（`Prepare` 只对已登记实例发事件），所以先起实例。
                ("nodeStarted", (emitter, _) => { emitter.OnInstanceStarted("exec-1", "logicGraph", "encounter", "Encounter", "hero", 3); emitter.OnNodeStarted("exec-1", "step_a", 4); }),
                ("nodeOutput", (emitter, _) => { emitter.OnInstanceStarted("exec-1", "logicGraph", "encounter", "Encounter", "hero", 3); emitter.OnNodeOutput("exec-1", "step_a", 1, 5); }),
                ("dataNode", (emitter, _) => { emitter.OnInstanceStarted("exec-1", "logicGraph", "encounter", "Encounter", "hero", 3); emitter.OnDataNode("exec-1", "data_b", 6); }),
                ("edgeValueChanged", (emitter, _) => { emitter.OnInstanceStarted("exec-1", "logicGraph", "encounter", "Encounter", "hero", 3); emitter.OnEdgeValueChanged("exec-1", "step_a", 2, "v", 7); }),
                // 补发路径：会话重置后再来一条事实 ⇒ 发射端自愈重建实例并补发 InstanceStarted，
                // 其 `record.frame` 必须等于这条事实的图执行帧号（帧号提前同步，P1-1 的回归点）。
                // 场景用"无连接时起实例"构造待发描述（连接态起实例不会留下待发），随后断连语义清空会话。
                ("replayedInstanceStarted", (emitter, transport) =>
                {
                    transport.SetConnected(false);
                    emitter.OnInstanceStarted("exec-1", "logicGraph", "encounter", "Encounter", "hero", 3);
                    transport.SetConnected(true);
                    ResetSession();
                    emitter.OnNodeStarted("exec-1", "step_a", 11);
                }),
                ("instanceStopped", (emitter, _) =>
                {
                    emitter.OnInstanceStarted("exec-1", "logicGraph", "encounter", "Encounter", "hero", 3);
                    emitter.OnInstanceStopped("exec-1", 12);
                }),
                // Reset 补的 InstanceStopped：帧号取会话当前帧（最近一次事实的帧），不再是占位 0。
                ("resetInstanceStopped", (emitter, _) =>
                {
                    emitter.OnInstanceStarted("exec-1", "logicGraph", "encounter", "Encounter", "hero", 3);
                    emitter.OnNodeStarted("exec-1", "step_a", 13);
                    emitter.Reset();
                }),
            };

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
