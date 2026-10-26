using System;
using System.Collections.Generic;
using System.Threading;
using NUnit.Framework;
using VisualBridge.Diagnostics;
using VisualBridge.Diagnostics.Bridge;

namespace VisualBridge.Editor.Tests
{
    /// <summary>
    /// D1 调试契约的 EditMode 用例：实例生命周期、重复 Create、Finish 幂等、槽位单调、实例上限、
    /// 未挂接/未连接态、PushParam 重载与默认值跳过、SetFrame 无消息。
    /// 传输与编码器都用假实现，用来断言“编码前跳过默认值”“SetFrame 不产生消息”这类只在边界上可观测的行为。
    /// </summary>
    public sealed class VisualBridgeDebugContractTests
    {
        private const string Category = "graph";
        private const string InterfaceId = "IGraphDebuger";

        [SetUp]
        public void SetUp()
        {
            VisualBridgeDebugBridge.Uninstall();
            VisualBridgeDebug.SetEncoder(null);
            VisualBridgeDebug.SetFrame(-1);
            VisualBridgeDebugDiagnostics.Reset();
        }

        [TearDown]
        public void TearDown()
        {
            VisualBridgeDebugBridge.Uninstall();
            VisualBridgeDebug.SetEncoder(null);
        }

        [Test]
        public void CreateAddsInstanceAndStartForwardsTheAcceptedEvent()
        {
            var transport = InstallTransport();
            var encoder = new FakeEncoder();
            VisualBridgeDebug.SetEncoder(encoder);
            VisualBridgeDebug.SetFrame(7);

            Assert.That(VisualBridgeDebug.Create("inst-1", Category, "res-a", "info-a"), Is.True);
            Assert.That(transport.Creates.Count, Is.EqualTo(1));
            Assert.That(transport.Creates[0].InstanceId, Is.EqualTo("inst-1"));
            Assert.That(transport.Creates[0].Category, Is.EqualTo(Category));
            Assert.That(transport.Creates[0].ResName, Is.EqualTo("res-a"));
            Assert.That(transport.Creates[0].DebugInfo, Is.EqualTo("info-a"));
            Assert.That((int)transport.Creates[0].Slot, Is.EqualTo(1));

            Assert.That(VisualBridgeDebug.Start("inst-1", Category, 10, InterfaceId, "NodeStart"), Is.True);
            Assert.That(encoder.Begins.Count, Is.EqualTo(1));
            Assert.That((int)encoder.Begins[0].MethodId, Is.EqualTo(10));
            Assert.That((int)encoder.Begins[0].Slot, Is.EqualTo(1));
            Assert.That(encoder.Begins[0].RequestSeq, Is.EqualTo(0u));

            VisualBridgeDebug.PushParam("nodeId", 1, "n-1");
            Assert.That(VisualBridgeDebug.End(), Is.True);
            Assert.That(encoder.EndCount, Is.EqualTo(1));
            Assert.That(transport.Events.Count, Is.EqualTo(1));
            Assert.That(transport.Events[0].Category, Is.EqualTo(Category));
            Assert.That(transport.Events[0].Iface, Is.EqualTo(InterfaceId));
            Assert.That(transport.Events[0].Method, Is.EqualTo("NodeStart"));
            Assert.That((long)transport.Events[0].Frame, Is.EqualTo(7L));
            Assert.That(transport.Events[0].Payload, Is.EqualTo(new byte[] { 0xCA, 0xFE }));
            Assert.That(encoder.Parameters.Count, Is.EqualTo(1));
        }

        [Test]
        public void StartRejectsUnknownInstanceWithoutTouchingTheEncoder()
        {
            var transport = InstallTransport();
            var encoder = new FakeEncoder();
            VisualBridgeDebug.SetEncoder(encoder);

            Assert.That(VisualBridgeDebug.Start("missing", Category, 10, InterfaceId, "NodeStart"), Is.False);
            Assert.That(encoder.Begins.Count, Is.EqualTo(0));
            Assert.That(encoder.EndCount, Is.EqualTo(0));
            Assert.That(transport.Events.Count, Is.EqualTo(0));
            Assert.That(VisualBridgeDebugSession.DroppedMessages, Is.EqualTo(0L));
        }

        [Test]
        public void DuplicateCreateReturnsTrueWithoutResendingTheDescriptor()
        {
            var transport = InstallTransport();
            var encoder = new FakeEncoder();
            VisualBridgeDebug.SetEncoder(encoder);

            Assert.That(VisualBridgeDebug.Create("inst-1", Category, "res-a", "info-a"), Is.True);
            Assert.That(VisualBridgeDebug.Create("inst-1", Category, "res-b", "info-b"), Is.True);
            Assert.That(transport.Creates.Count, Is.EqualTo(1));
            Assert.That(transport.Creates[0].ResName, Is.EqualTo("res-a"));
            Assert.That(VisualBridgeDebug.Start("inst-1", Category, 10, InterfaceId, "NodeStart"), Is.True);
            VisualBridgeDebug.End();

            var warnings = VisualBridgeDebugDiagnostics.GetWarnings();
            Assert.That(warnings.Length, Is.EqualTo(1));
            Assert.That(warnings[0].IndexOf("重复", StringComparison.Ordinal) >= 0, Is.True);
        }

        [Test]
        public void FinishRemovesTheInstanceAndIsIdempotent()
        {
            var transport = InstallTransport();
            var encoder = new FakeEncoder();
            VisualBridgeDebug.SetEncoder(encoder);

            Assert.That(VisualBridgeDebug.Create("inst-1", Category, "res-a", "info-a"), Is.True);
            Assert.That(VisualBridgeDebug.Start("inst-1", Category, 10, InterfaceId, "NodeStart"), Is.True);
            VisualBridgeDebug.End();

            Assert.That(VisualBridgeDebug.Finish("inst-1"), Is.True);
            Assert.That(transport.Finishes.Count, Is.EqualTo(1));
            Assert.That(transport.Finishes[0].InstanceId, Is.EqualTo("inst-1"));
            Assert.That((int)transport.Finishes[0].Slot, Is.EqualTo(1));

            Assert.That(VisualBridgeDebug.Finish("inst-1"), Is.False);
            Assert.That(transport.Finishes.Count, Is.EqualTo(1));
            Assert.That(VisualBridgeDebug.Start("inst-1", Category, 10, InterfaceId, "NodeStart"), Is.False);
        }

        [Test]
        public void SlotsStartAtOneAndAreNeverReusedWithinAConnection()
        {
            var transport = InstallTransport();

            Assert.That(VisualBridgeDebug.Create("a", Category, "res-a", ""), Is.True);
            Assert.That(VisualBridgeDebug.Create("b", Category, "res-b", ""), Is.True);
            Assert.That(VisualBridgeDebug.Finish("a"), Is.True);
            Assert.That(VisualBridgeDebug.Create("c", Category, "res-c", ""), Is.True);

            Assert.That(transport.Creates.Count, Is.EqualTo(3));
            Assert.That((int)transport.Creates[0].Slot, Is.EqualTo(1));
            Assert.That((int)transport.Creates[1].Slot, Is.EqualTo(2));
            Assert.That((int)transport.Creates[2].Slot, Is.EqualTo(3));
        }

        [Test]
        public void CreateStopsAtTheInstanceLimitAndWarnsOncePerSession()
        {
            var transport = InstallTransport();

            for (int index = 0; index < 1024; index++)
            {
                Assert.That(VisualBridgeDebug.Create("inst-" + index.ToString(), Category, "res", ""), Is.True);
            }

            Assert.That(VisualBridgeDebug.Create("inst-overflow", Category, "res", ""), Is.False);
            Assert.That(VisualBridgeDebugDiagnostics.WarningCount, Is.EqualTo(1));
            Assert.That(VisualBridgeDebug.Create("inst-overflow-2", Category, "res", ""), Is.False);
            Assert.That(VisualBridgeDebugDiagnostics.WarningCount, Is.EqualTo(1));
            Assert.That(transport.Creates.Count, Is.EqualTo(1024));
        }

        [Test]
        public void CreateFailsWhenTheSlotSpaceIsExhausted()
        {
            var transport = InstallTransport();

            bool allSucceeded = true;
            for (int index = 0; index < 65535; index++)
            {
                string instanceId = "inst-" + index.ToString();
                allSucceeded &= VisualBridgeDebug.Create(instanceId, Category, "res", "");
                allSucceeded &= VisualBridgeDebug.Finish(instanceId);
            }

            Assert.That(allSucceeded, Is.True);
            Assert.That(transport.Creates.Count, Is.EqualTo(65535));
            Assert.That((int)transport.Creates[65534].Slot, Is.EqualTo(65535));
            Assert.That(VisualBridgeDebug.Create("inst-65535", Category, "res", ""), Is.False);
            Assert.That(VisualBridgeDebugDiagnostics.WarningCount, Is.EqualTo(1));
        }

        [Test]
        public void UnattachedBridgeReturnsFalseWithoutSideEffects()
        {
            // 未挂接（没有注入传输）时的真实行为：Create/Finish/Start/End 全部 false，PushParam 空实现、不告警。
            // 注意：EditMode 恒定义 UNITY_EDITOR，这里覆盖的是“未挂接”态，不是宏关闭分支（宏关闭证据见回报 risks）。
            Assert.That(VisualBridgeDebugBridge.IsInstalled, Is.False);
            Assert.That(VisualBridgeDebug.isConnected, Is.False);
            // 未注入传输时按编译平台取默认值：Editor 内为 Editor，Player 内为 Player；宏关闭固定 Player。
            Assert.That(VisualBridgeDebug.ConnectType, Is.EqualTo(VisualBridge.Diagnostics.ConnectType.Editor));

            Assert.That(VisualBridgeDebug.Create("inst-1", Category, "res", ""), Is.False);
            Assert.That(VisualBridgeDebug.Finish("inst-1"), Is.False);
            Assert.That(VisualBridgeDebug.Start("inst-1", Category, 10, InterfaceId, "NodeStart"), Is.False);
            Assert.DoesNotThrow(() => VisualBridgeDebug.PushParam("count", 1, 5));
            Assert.DoesNotThrow(() => VisualBridgeDebug.PushParam("name", 2, "x"));
            Assert.That(VisualBridgeDebug.End(), Is.False);
            Assert.DoesNotThrow(() => VisualBridgeDebug.SetFrame(3));
            Assert.DoesNotThrow(() => VisualBridgeDebug.RegisterRequestHandler(Category, InterfaceId, null));

            var request = new VisualBridgeDebugRequest("inst-1", 1, 10, 2u);
            Assert.That(VisualBridgeDebug.StartResult(request), Is.False);
            Assert.That(VisualBridgeDebug.RejectRequest(request, "nope"), Is.False);
            Assert.That(VisualBridgeDebugDiagnostics.WarningCount, Is.EqualTo(0));
        }

        [Test]
        public void PendingDescriptorsFlushInOrderWhenTheConnectionIsEstablished()
        {
            // 已挂接但未连接：Create 只入队；连接建立后按入队顺序 flush 一次，发送后清空。
            var transport = InstallTransport(false);
            Assert.That(VisualBridgeDebug.Create("a", Category, "res-a", "info-a"), Is.True);
            Assert.That(VisualBridgeDebug.Create("b", Category, "res-b", "info-b"), Is.True);
            Assert.That(transport.Creates.Count, Is.EqualTo(0));

            transport.SetConnected(true);
            VisualBridgeDebug.Attach();
            Assert.That(transport.Creates.Count, Is.EqualTo(2));
            Assert.That(transport.Creates[0].InstanceId, Is.EqualTo("a"));
            Assert.That(transport.Creates[0].Category, Is.EqualTo(Category));
            Assert.That(transport.Creates[0].ResName, Is.EqualTo("res-a"));
            Assert.That(transport.Creates[0].DebugInfo, Is.EqualTo("info-a"));
            Assert.That((int)transport.Creates[0].Slot, Is.EqualTo(1));
            Assert.That(transport.Creates[1].InstanceId, Is.EqualTo("b"));
            Assert.That((int)transport.Creates[1].Slot, Is.EqualTo(2));

            VisualBridgeDebug.Attach();
            Assert.That(transport.Creates.Count, Is.EqualTo(2));

            var encoder = new FakeEncoder();
            VisualBridgeDebug.SetEncoder(encoder);
            Assert.That(VisualBridgeDebug.Start("a", Category, 10, InterfaceId, "NodeStart"), Is.True);
            Assert.That(VisualBridgeDebug.End(), Is.True);
        }

        [Test]
        public void FinishCancelsAPendingDescriptorButKeepsTheSlotConsumed()
        {
            var transport = InstallTransport(false);
            Assert.That(VisualBridgeDebug.Create("a", Category, "res-a", "info-a"), Is.True);
            Assert.That(VisualBridgeDebug.Finish("a"), Is.True);

            transport.SetConnected(true);
            VisualBridgeDebug.Attach();
            Assert.That(transport.Creates.Count, Is.EqualTo(0));

            Assert.That(VisualBridgeDebug.Create("b", Category, "res-b", "info-b"), Is.True);
            Assert.That(transport.Creates.Count, Is.EqualTo(1));
            // 槽位连接内绝不复用：被撤销的待发描述也已经消耗过槽位 1。
            Assert.That((int)transport.Creates[0].Slot, Is.EqualTo(2));
        }

        [Test]
        public void PushParamSkipsDefaultValuesBeforeEncoding()
        {
            var transport = InstallTransport();
            var encoder = new FakeEncoder();
            VisualBridgeDebug.SetEncoder(encoder);
            Assert.That(VisualBridgeDebug.Create("inst-1", Category, "res", ""), Is.True);
            Assert.That(VisualBridgeDebug.Start("inst-1", Category, 10, InterfaceId, "NodeStart"), Is.True);

            VisualBridgeDebug.PushParam("b", 1, false);
            VisualBridgeDebug.PushParam("i", 2, 0);
            VisualBridgeDebug.PushParam("l", 3, 0L);
            VisualBridgeDebug.PushParam("ul", 4, 0UL);
            VisualBridgeDebug.PushParam("f", 5, 0f);
            VisualBridgeDebug.PushParam("d", 6, 0d);
            VisualBridgeDebug.PushParam("e", 7, SampleEnum.None);
            VisualBridgeDebug.PushParam("s", 8, (string)null);
            VisualBridgeDebug.PushParam("s2", 9, string.Empty);
            VisualBridgeDebug.PushParam("bytes", 10, (byte[])null);
            VisualBridgeDebug.PushParam("bytes2", 11, Array.Empty<byte>());

            Assert.That(encoder.Parameters.Count, Is.EqualTo(0));

            VisualBridgeDebug.PushParam("b", 1, true);
            VisualBridgeDebug.PushParam("i", 2, -1);
            Assert.That(VisualBridgeDebug.End(), Is.True);

            Assert.That(encoder.Parameters.Count, Is.EqualTo(2));
            Assert.That(encoder.Parameters[0].Name, Is.EqualTo("b"));
            Assert.That((int)encoder.Parameters[0].Tag, Is.EqualTo(1));
            Assert.That((bool)encoder.Parameters[0].Value, Is.True);
            Assert.That(encoder.Parameters[1].Name, Is.EqualTo("i"));
            Assert.That((int)encoder.Parameters[1].Tag, Is.EqualTo(2));
            Assert.That((int)encoder.Parameters[1].Value, Is.EqualTo(-1));
            Assert.That(transport.Events.Count, Is.EqualTo(1));
        }

        [Test]
        public void PushParamOverloadsForwardNonDefaultValuesWithDeclaredTypes()
        {
            var transport = InstallTransport();
            var encoder = new FakeEncoder();
            VisualBridgeDebug.SetEncoder(encoder);
            Assert.That(VisualBridgeDebug.Create("inst-1", Category, "res", ""), Is.True);
            Assert.That(VisualBridgeDebug.Start("inst-1", Category, 10, InterfaceId, "NodeStart"), Is.True);

            VisualBridgeDebug.PushParam("bool", 1, true);
            VisualBridgeDebug.PushParam("int", 2, 42);
            VisualBridgeDebug.PushParam("long", 3, -7L);
            VisualBridgeDebug.PushParam("ulong", 4, 7UL);
            VisualBridgeDebug.PushParam("float", 5, 1.5f);
            VisualBridgeDebug.PushParam("double", 6, 2.5d);
            VisualBridgeDebug.PushParam("enum", 7, SampleEnum.Second);
            VisualBridgeDebug.PushParam("wideEnum", 8, WideEnum.Big);
            VisualBridgeDebug.PushParam("string", 9, "text");
            VisualBridgeDebug.PushParam("bytes", 10, new byte[] { 1, 2, 3 });

            Assert.That(encoder.Parameters.Count, Is.EqualTo(10));
            for (int index = 0; index < encoder.Parameters.Count; index++)
            {
                Assert.That((int)encoder.Parameters[index].Tag, Is.EqualTo(index + 1));
            }

            Assert.That(encoder.Parameters[0].Value is bool, Is.True);
            Assert.That((bool)encoder.Parameters[0].Value, Is.True);
            Assert.That(encoder.Parameters[1].Value is int, Is.True);
            Assert.That((int)encoder.Parameters[1].Value, Is.EqualTo(42));
            Assert.That(encoder.Parameters[2].Value is long, Is.True);
            Assert.That((long)encoder.Parameters[2].Value, Is.EqualTo(-7L));
            Assert.That(encoder.Parameters[3].Value is ulong, Is.True);
            Assert.That((ulong)encoder.Parameters[3].Value, Is.EqualTo(7UL));
            Assert.That(encoder.Parameters[4].Value is float, Is.True);
            Assert.That((float)encoder.Parameters[4].Value, Is.EqualTo(1.5f));
            Assert.That(encoder.Parameters[5].Value is double, Is.True);
            Assert.That((double)encoder.Parameters[5].Value, Is.EqualTo(2.5d));
            Assert.That((SampleEnum)encoder.Parameters[6].Value, Is.EqualTo(SampleEnum.Second));
            Assert.That((WideEnum)encoder.Parameters[7].Value, Is.EqualTo(WideEnum.Big));
            Assert.That((string)encoder.Parameters[8].Value, Is.EqualTo("text"));
            Assert.That((byte[])encoder.Parameters[9].Value, Is.EqualTo(new byte[] { 1, 2, 3 }));
            Assert.That(VisualBridgeDebug.End(), Is.True);
        }

        [Test]
        public void SetFrameOnlyStoresTheValueWithoutProducingMessages()
        {
            var transport = InstallTransport();
            var encoder = new FakeEncoder();
            VisualBridgeDebug.SetEncoder(encoder);
            Assert.That(VisualBridgeDebug.Create("inst-1", Category, "res", ""), Is.True);

            VisualBridgeDebug.SetFrame(42);
            Assert.That(transport.Creates.Count, Is.EqualTo(1));
            Assert.That(transport.Events.Count, Is.EqualTo(0));
            Assert.That(encoder.Begins.Count, Is.EqualTo(0));
            Assert.That(encoder.EndCount, Is.EqualTo(0));

            Assert.That(VisualBridgeDebug.Start("inst-1", Category, 10, InterfaceId, "NodeStart"), Is.True);
            Assert.That(VisualBridgeDebug.End(), Is.True);
            Assert.That(transport.Events.Count, Is.EqualTo(1));
            Assert.That((long)transport.Events[0].Frame, Is.EqualTo(42L));

            // 默认 -1 = 无帧
            VisualBridgeDebug.SetFrame(-1);
            Assert.That(VisualBridgeDebug.Start("inst-1", Category, 11, InterfaceId, "NodeEnd"), Is.True);
            Assert.That(VisualBridgeDebug.End(), Is.True);
            Assert.That((long)transport.Events[1].Frame, Is.EqualTo(-1L));
        }

        [Test]
        public void DetachResetsTheSessionAndRestartsSlotsFromOne()
        {
            var transport = InstallTransport();
            var encoder = new FakeEncoder();
            VisualBridgeDebug.SetEncoder(encoder);

            Assert.That(VisualBridgeDebug.Create("a", Category, "res-a", ""), Is.True);
            Assert.That(VisualBridgeDebug.Create("b", Category, "res-b", ""), Is.True);
            Assert.That((int)transport.Creates[1].Slot, Is.EqualTo(2));

            VisualBridgeDebug.Detach();
            Assert.That(VisualBridgeDebug.isConnected, Is.False);
            Assert.That(VisualBridgeDebug.Start("a", Category, 10, InterfaceId, "NodeStart"), Is.False);
            Assert.That(VisualBridgeDebug.Create("c", Category, "res-c", ""), Is.True);

            VisualBridgeDebug.Attach();
            Assert.That(VisualBridgeDebug.isConnected, Is.True);
            Assert.That(transport.Creates.Count, Is.EqualTo(3));
            Assert.That(transport.Creates[2].InstanceId, Is.EqualTo("c"));
            Assert.That((int)transport.Creates[2].Slot, Is.EqualTo(1));
            Assert.That(VisualBridgeDebug.Start("c", Category, 10, InterfaceId, "NodeStart"), Is.True);
            VisualBridgeDebug.End();
        }

        [Test]
        public void DisconnectIsObservedLazilyAndResetsTheInstanceSet()
        {
            var transport = InstallTransport();
            var encoder = new FakeEncoder();
            VisualBridgeDebug.SetEncoder(encoder);
            Assert.That(VisualBridgeDebug.Create("inst-1", Category, "res", ""), Is.True);

            transport.SetConnected(false);
            Assert.That(VisualBridgeDebug.Start("inst-1", Category, 10, InterfaceId, "NodeStart"), Is.False);
            Assert.That(encoder.Begins.Count, Is.EqualTo(0));
            Assert.That(VisualBridgeDebugSession.DroppedMessages, Is.EqualTo(1L));

            // 下一次冷路径调用观察到断连：旧实例作废、槽位归 1、丢弃计数归零。
            Assert.That(VisualBridgeDebug.Create("inst-2", Category, "res", ""), Is.True);
            Assert.That(VisualBridgeDebugSession.DroppedMessages, Is.EqualTo(0L));
            Assert.That(VisualBridgeDebug.Start("inst-1", Category, 10, InterfaceId, "NodeStart"), Is.False);

            transport.SetConnected(true);
            VisualBridgeDebug.Attach();
            Assert.That(transport.Creates.Count, Is.EqualTo(2));
            Assert.That(transport.Creates[1].InstanceId, Is.EqualTo("inst-2"));
            Assert.That((int)transport.Creates[1].Slot, Is.EqualTo(1));
            Assert.That(VisualBridgeDebug.Start("inst-2", Category, 10, InterfaceId, "NodeStart"), Is.True);
            VisualBridgeDebug.End();
        }

        [Test]
        public void RequestHandlesAreRejectedWithoutConnectionAndForwardedWithOne()
        {
            var request = new VisualBridgeDebugRequest("inst-1", 7, 10, 3u);

            Assert.That(VisualBridgeDebug.StartResult(request), Is.False);
            Assert.That(VisualBridgeDebug.RejectRequest(request, "no handler"), Is.False);

            var transport = InstallTransport();
            var encoder = new FakeEncoder();
            VisualBridgeDebug.SetEncoder(encoder);

            Assert.That(VisualBridgeDebug.StartResult(request), Is.True);
            Assert.That(encoder.Begins.Count, Is.EqualTo(1));
            Assert.That((int)encoder.Begins[0].MethodId, Is.EqualTo(10));
            Assert.That((int)encoder.Begins[0].Slot, Is.EqualTo(7));
            Assert.That(encoder.Begins[0].RequestSeq, Is.EqualTo(3u));
            VisualBridgeDebug.PushParam("value", 1, 5);
            Assert.That(VisualBridgeDebug.End(), Is.True);
            Assert.That(transport.Results.Count, Is.EqualTo(1));
            Assert.That(transport.Results[0].RequestSeq, Is.EqualTo(3u));

            Assert.That(VisualBridgeDebug.RejectRequest(request, "no handler"), Is.True);
            Assert.That(transport.Rejects.Count, Is.EqualTo(1));
            Assert.That(transport.Rejects[0].RequestSeq, Is.EqualTo(3u));
            Assert.That(transport.Rejects[0].Reason, Is.EqualTo("no handler"));
        }

        [Test]
        public void GeneratedFacadePatternStopsImmediatelyAfterAFalseStart()
        {
            // 模拟 D2 生成代码的结构：Start 返回 false 后立即返回，不压参数、不 End。
            var transport = InstallTransport();
            var encoder = new FakeEncoder();
            VisualBridgeDebug.SetEncoder(encoder);

            int accepted = 0;
            for (int index = 0; index < 3; index++)
            {
                if (!VisualBridgeDebug.Start("unknown-" + index.ToString(), Category, 10, InterfaceId, "NodeStart"))
                {
                    continue;
                }

                VisualBridgeDebug.PushParam("index", 1, index);
                VisualBridgeDebug.End();
                accepted++;
            }

            Assert.That(accepted, Is.EqualTo(0));
            Assert.That(encoder.Begins.Count, Is.EqualTo(0));
            Assert.That(encoder.EndCount, Is.EqualTo(0));
            Assert.That(transport.Events.Count, Is.EqualTo(0));
        }

        [Test]
        public void SilentReconnectResetsTheSessionWhenTheConnectionGenerationChanges()
        {
            // 断连从未被观察到（没有 Create/Finish/Attach 落在断开期间）：靠传输层的连接代次识别重连。
            var transport = InstallTransport();
            var encoder = new FakeEncoder();
            VisualBridgeDebug.SetEncoder(encoder);
            Assert.That(VisualBridgeDebug.Create("a", Category, "res-a", ""), Is.True);
            Assert.That(VisualBridgeDebug.Start("a", Category, 10, InterfaceId, "NodeStart"), Is.True);
            Assert.That(VisualBridgeDebug.End(), Is.True);

            transport.SetConnected(false);
            transport.SetConnected(true);
            VisualBridgeDebug.Attach();

            Assert.That(VisualBridgeDebug.Start("a", Category, 10, InterfaceId, "NodeStart"), Is.False);
            Assert.That(VisualBridgeDebug.Create("b", Category, "res-b", ""), Is.True);
            Assert.That(transport.Creates.Count, Is.EqualTo(2));
            Assert.That(transport.Creates[1].InstanceId, Is.EqualTo("b"));
            Assert.That((int)transport.Creates[1].Slot, Is.EqualTo(1));
        }

        [Test]
        public void StartCountsDroppedMessagesWhenTheSessionIsAlreadyDisconnected()
        {
            var transport = InstallTransport(false);
            Assert.That(VisualBridgeDebug.Create("inst-1", Category, "res", ""), Is.True);

            // 已挂接但未连接：Start 直接丢弃并计数，不编码、不入队。
            var encoder = new FakeEncoder();
            VisualBridgeDebug.SetEncoder(encoder);
            Assert.That(VisualBridgeDebug.Start("inst-1", Category, 10, InterfaceId, "NodeStart"), Is.False);
            Assert.That(encoder.Begins.Count, Is.EqualTo(0));
            Assert.That(VisualBridgeDebugSession.DroppedMessages, Is.EqualTo(1L));

            transport.SetConnected(true);
            VisualBridgeDebug.Attach();
            Assert.That(transport.Creates.Count, Is.EqualTo(1));
            Assert.That((int)transport.Creates[0].Slot, Is.EqualTo(1));
        }

        [Test]
        public void EndDropsTheEventWhenTheConnectionGenerationChanged()
        {
            var transport = InstallTransport();
            var encoder = new FakeEncoder();
            VisualBridgeDebug.SetEncoder(encoder);
            Assert.That(VisualBridgeDebug.Create("inst-1", Category, "res", ""), Is.True);
            Assert.That(VisualBridgeDebug.Start("inst-1", Category, 10, InterfaceId, "NodeStart"), Is.True);

            // Start 之后静默重连：槽位属于上一条连接，End 必须丢弃而不是发到新会话。
            transport.SetConnected(false);
            transport.SetConnected(true);
            Assert.That(VisualBridgeDebug.End(), Is.False);
            Assert.That(transport.Events.Count, Is.EqualTo(0));
            Assert.That(VisualBridgeDebugSession.DroppedMessages, Is.EqualTo(1L));
        }

        [Test]
        public void PushParamFromAnotherThreadIsRejectedAndCounted()
        {
            var transport = InstallTransport();
            var encoder = new FakeEncoder();
            VisualBridgeDebug.SetEncoder(encoder);
            Assert.That(VisualBridgeDebug.Create("inst-1", Category, "res", ""), Is.True);
            Assert.That(VisualBridgeDebug.Start("inst-1", Category, 10, InterfaceId, "NodeStart"), Is.True);

            bool endResultFromWorker = true;
            var worker = new Thread(() =>
            {
                VisualBridgeDebug.PushParam("value", 1, 5);
                endResultFromWorker = VisualBridgeDebug.End();
            });
            worker.Start();
            Assert.That(worker.Join(5000), Is.True);

            Assert.That(endResultFromWorker, Is.False);
            Assert.That(VisualBridgeDebugSession.CrossThreadCalls, Is.EqualTo(2L));
            Assert.That(encoder.Parameters.Count, Is.EqualTo(0));
            Assert.That(VisualBridgeDebugDiagnostics.WarningCount, Is.EqualTo(1));

            // 消息仍归 Start 线程所有：主线程继续压参数并 End 不受影响。
            VisualBridgeDebug.PushParam("value", 1, 5);
            Assert.That(VisualBridgeDebug.End(), Is.True);
            Assert.That(encoder.Parameters.Count, Is.EqualTo(1));
            Assert.That(transport.Events.Count, Is.EqualTo(1));
        }

        [Test]
        public void StartDoesNotCountUnknownInstanceWhenDisconnected()
        {
            var transport = InstallTransport(false);
            var encoder = new FakeEncoder();
            VisualBridgeDebug.SetEncoder(encoder);

            // 未知实例（从未 Create）：不计数（附录 B.3.1）。
            Assert.That(VisualBridgeDebug.Start("unknown", Category, 10, InterfaceId, "NodeStart"), Is.False);
            Assert.That(VisualBridgeDebugSession.DroppedMessages, Is.EqualTo(0L));

            // 已 Create 但未连接的已知实例：直接丢弃并计数。
            Assert.That(VisualBridgeDebug.Create("inst-1", Category, "res", ""), Is.True);
            Assert.That(VisualBridgeDebug.Start("inst-1", Category, 10, InterfaceId, "NodeStart"), Is.False);
            Assert.That(VisualBridgeDebugSession.DroppedMessages, Is.EqualTo(1L));
            Assert.That(encoder.Begins.Count, Is.EqualTo(0));
            Assert.That(transport.Creates.Count, Is.EqualTo(0));
        }

        [Test]
        public void NegativeZeroIsNotTreatedAsDefault()
        {
            var transport = InstallTransport();
            var encoder = new FakeEncoder();
            VisualBridgeDebug.SetEncoder(encoder);
            Assert.That(VisualBridgeDebug.Create("inst-1", Category, "res", ""), Is.True);
            Assert.That(VisualBridgeDebug.Start("inst-1", Category, 10, InterfaceId, "NodeStart"), Is.True);

            VisualBridgeDebug.PushParam("f", 1, 0f);
            VisualBridgeDebug.PushParam("d", 2, 0d);
            Assert.That(encoder.Parameters.Count, Is.EqualTo(0));

            // 附录 A.4：float/double 默认值按位判断，-0.0 不是默认值，必须写出（D3 按位编码的前置契约）。
            VisualBridgeDebug.PushParam("f", 1, -0.0f);
            VisualBridgeDebug.PushParam("d", 2, -0.0d);
            Assert.That(VisualBridgeDebug.End(), Is.True);

            Assert.That(encoder.Parameters.Count, Is.EqualTo(2));
            Assert.That(BitConverter.SingleToInt32Bits((float)encoder.Parameters[0].Value) != 0, Is.True);
            Assert.That(BitConverter.DoubleToInt64Bits((double)encoder.Parameters[1].Value) != 0L, Is.True);
            Assert.That(transport.Events.Count, Is.EqualTo(1));
        }

        [Test]
        public void InstallingANewTransportResetsTheSession()
        {
            var first = InstallTransport();
            var encoder = new FakeEncoder();
            VisualBridgeDebug.SetEncoder(encoder);
            Assert.That(VisualBridgeDebug.Create("a", Category, "res-a", ""), Is.True);
            Assert.That(first.Creates.Count, Is.EqualTo(1));

            first.SetConnected(false);
            // 已挂接但未连接时 Create：描述进入待发队列。
            Assert.That(VisualBridgeDebug.Create("b", Category, "res-b", ""), Is.True);
            Assert.That(first.Creates.Count, Is.EqualTo(1));

            // 注入新传输即新会话（附录 B.3.2）：旧实例、槽位与待发描述都不能带进新传输。
            var second = InstallTransport();
            Assert.That(second.Creates.Count, Is.EqualTo(0));
            Assert.That(VisualBridgeDebug.Start("a", Category, 10, InterfaceId, "NodeStart"), Is.False);
            Assert.That(VisualBridgeDebug.Start("b", Category, 10, InterfaceId, "NodeStart"), Is.False);
            Assert.That(VisualBridgeDebug.Create("c", Category, "res-c", ""), Is.True);
            Assert.That(second.Creates.Count, Is.EqualTo(1));
            Assert.That(second.Creates[0].InstanceId, Is.EqualTo("c"));
            Assert.That((int)second.Creates[0].Slot, Is.EqualTo(1));
        }

        [Test]
        public void EncoderIsPinnedForTheWholeMessage()
        {
            var transport = InstallTransport();
            var first = new FakeEncoder();
            var second = new FakeEncoder();
            VisualBridgeDebug.SetEncoder(first);
            Assert.That(VisualBridgeDebug.Create("inst-1", Category, "res", ""), Is.True);
            Assert.That(VisualBridgeDebug.Start("inst-1", Category, 10, InterfaceId, "NodeStart"), Is.True);

            // 消息中途替换编码器：本条消息仍用 Start 时绑定的那个（附录 B.2.1）。
            VisualBridgeDebug.SetEncoder(second);
            VisualBridgeDebug.PushParam("value", 1, 5);
            Assert.That(VisualBridgeDebug.End(), Is.True);
            Assert.That(first.Parameters.Count, Is.EqualTo(1));
            Assert.That(first.EndCount, Is.EqualTo(1));
            Assert.That(second.Parameters.Count, Is.EqualTo(0));
            Assert.That(second.EndCount, Is.EqualTo(0));

            // SetEncoder(null) 之后结束进行中的消息：仍调用已绑定的编码器 End，不留半条消息。
            Assert.That(VisualBridgeDebug.Start("inst-1", Category, 11, InterfaceId, "NodeEnd"), Is.True);
            VisualBridgeDebug.SetEncoder(null);
            VisualBridgeDebug.PushParam("value", 1, 6);
            Assert.That(VisualBridgeDebug.End(), Is.True);
            Assert.That(second.Parameters.Count, Is.EqualTo(1));
            Assert.That(second.EndCount, Is.EqualTo(1));
            Assert.That(transport.Events.Count, Is.EqualTo(2));

            // 没有编码器时下一条消息直接丢弃并计数。
            Assert.That(VisualBridgeDebug.Start("inst-1", Category, 12, InterfaceId, "NodeEnd"), Is.False);
            Assert.That(VisualBridgeDebugSession.DroppedMessages, Is.EqualTo(1L));
        }

        [Test]
        public void SessionResetClosesTheInFlightEncoder()
        {
            InstallTransport();
            var encoder = new FakeEncoder();
            VisualBridgeDebug.SetEncoder(encoder);
            Assert.That(VisualBridgeDebug.Create("inst-1", Category, "res", ""), Is.True);
            Assert.That(VisualBridgeDebug.Start("inst-1", Category, 10, InterfaceId, "NodeStart"), Is.True);
            VisualBridgeDebug.PushParam("value", 1, 5);
            Assert.That(encoder.EndCount, Is.EqualTo(0));

            // 会话在 Start 与 End 之间被重置：仍要收尾编码器，不留半条消息；之后的 End 直接返回 false。
            VisualBridgeDebugBridge.Uninstall();
            Assert.That(encoder.EndCount, Is.EqualTo(1));
            Assert.That(VisualBridgeDebug.End(), Is.False);
            Assert.That(encoder.EndCount, Is.EqualTo(1));
        }

        private static FakeTransport InstallTransport()
        {
            return InstallTransport(true);
        }

        private static FakeTransport InstallTransport(bool connected)
        {
            var transport = new FakeTransport(connected);
            VisualBridgeDebugBridge.Install(transport);
            return transport;
        }

        private enum SampleEnum
        {
            None = 0,
            First = 1,
            Second = 2,
        }

        private enum WideEnum : ulong
        {
            None = 0,
            Big = ulong.MaxValue,
        }

        /// <summary>假传输：记录消息；断开时收到任何发送都视为契约破坏。</summary>
        private sealed class FakeTransport : IVisualBridgeDebugTransport
        {
            private bool _connected;
            private long _generation;

            public FakeTransport(bool connected)
            {
                _connected = connected;
            }

            public bool IsConnected
            {
                get { return _connected; }
            }

            public ConnectType ConnectType
            {
                get { return VisualBridge.Diagnostics.ConnectType.Editor; }
            }

            public long ConnectionGeneration
            {
                get { return _generation; }
            }

            public List<(string InstanceId, string Category, string ResName, string DebugInfo, ushort Slot)> Creates { get; } =
                new List<(string, string, string, string, ushort)>();

            public List<(string InstanceId, ushort Slot)> Finishes { get; } = new List<(string, ushort)>();

            public List<(ushort Slot, ushort MethodId, string Category, string Iface, string Method, long Frame,
                byte[] Payload)> Events { get; } =
                new List<(ushort, ushort, string, string, string, long, byte[])>();

            public List<(uint RequestSeq, byte[] Payload)> Results { get; } = new List<(uint, byte[])>();

            public List<(uint RequestSeq, string Reason)> Rejects { get; } = new List<(uint, string)>();

            public void SetConnected(bool connected)
            {
                _connected = connected;
                if (connected)
                {
                    // 每次重新连接代次 +1，模拟传输层给新连接编号。
                    _generation++;
                }
            }

            public void SendCreate(string instanceId, string category, string resName, string debugInfo,
                ushort instanceSlot)
            {
                EnsureConnected();
                Creates.Add((instanceId, category, resName, debugInfo, instanceSlot));
            }

            public void SendFinish(string instanceId, ushort instanceSlot)
            {
                EnsureConnected();
                Finishes.Add((instanceId, instanceSlot));
            }

            public void SendEvent(ushort instanceSlot, ushort methodId, string category, string iface, string method,
                long frame, ReadOnlyMemory<byte> payload)
            {
                EnsureConnected();
                Events.Add((instanceSlot, methodId, category, iface, method, frame, payload.ToArray()));
            }

            public void SendResult(uint requestSeq, ReadOnlyMemory<byte> payload)
            {
                EnsureConnected();
                Results.Add((requestSeq, payload.ToArray()));
            }

            public void SendReject(uint requestSeq, string reason)
            {
                EnsureConnected();
                Rejects.Add((requestSeq, reason));
            }

            private void EnsureConnected()
            {
                if (!_connected)
                {
                    throw new InvalidOperationException("FakeTransport 已断开，不应收到消息。");
                }
            }
        }

        /// <summary>假编码器：记录 Begin/PushParam/End，用来断言默认值在编码前被跳过。</summary>
        private sealed class FakeEncoder : IDebugMessageEncoder
        {
            public List<(ushort MethodId, ushort Slot, uint RequestSeq)> Begins { get; } =
                new List<(ushort, ushort, uint)>();

            public List<(string Name, ushort Tag, object Value)> Parameters { get; } =
                new List<(string, ushort, object)>();

            public int EndCount { get; private set; }

            public void Begin(ushort methodId, ushort instanceSlot, uint requestSeq)
            {
                Begins.Add((methodId, instanceSlot, requestSeq));
            }

            public void PushParam(string name, ushort tag, object value)
            {
                Parameters.Add((name, tag, value));
            }

            public ReadOnlyMemory<byte> End()
            {
                EndCount++;
                return new byte[] { 0xCA, 0xFE };
            }
        }
    }
}
