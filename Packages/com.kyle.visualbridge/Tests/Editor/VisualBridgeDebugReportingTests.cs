using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using VisualBridge.Diagnostics;
using VisualBridge.Diagnostics.Bridge;
using VisualBridge.Runtime;

namespace VisualBridge.Editor.Tests
{
    /// <summary>
    /// F7：调试上报开关（附录 A.2 的通道 0 控制消息 <c>debugSetEnabled</c> / <c>debugEnabled</c>）。
    /// 覆盖四件事：
    /// <list type="bullet">
    /// <item><description>契约：schema 声明两条消息、字段 <c>enabled</c> 必填布尔，C# 校验器镜像同一判据；</description></item>
    /// <item><description>会话状态：开关值进 <see cref="VisualBridgeSessionState"/>，跨 Domain Reload 保留；</description></item>
    /// <item><description><b>闸门</b>：关闭后只抑制调试流四条消息（debug / debugCreate / debugFinish / debugFrame），
    /// 抑制不计数、不告警；<c>response</c> / <c>reject</c> / <c>dropped</c> 照常送出；</description></item>
    /// <item><description><b>重开</b>：关闭期间失败的 flush 必须保留待发项，已连接时的重开路径强制补发。</description></item>
    /// </list>
    /// </summary>
    public sealed class VisualBridgeDebugReportingTests
    {
        private const string Category = "graph";
        private const string InterfaceId = "IGraphDebuger";
        private const string MethodName = "NodeStart";
        private const ushort MethodId = 10;
        private const string InstanceId = "hero";

        /// <summary>与 E6 相同的 request 信封（A.5 键序）：本类用它证明"关闭期请求不执行业务 handler"。</summary>
        private const string RequestJsonFixture = "{\"type\":\"request\",\"requestId\":\"req-12\","
            + "\"action\":\"debugQuery\",\"category\":\"graph\",\"instance\":\"hero\","
            + "\"iface\":\"IGraphDebuger\",\"method\":\"IsVisible\",\"methodId\":10,"
            + "\"args\":[{\"tag\":1,\"name\":\"nodeId\",\"type\":\"int\",\"value\":3}]}";

        private int handlerRuns;

        [SetUp]
        public void SetUp()
        {
            handlerRuns = 0;
            VisualBridgeDebugBridge.Uninstall();
            VisualBridgeDebug.RegisterRequestHandler(Category, InterfaceId, null);
            VisualBridgeDebug.SetEncoder(null);
            VisualBridgeDebug.SetFrame(-1);
            VisualBridgeDebugReporting.Reset();
            VisualBridgeDebugDiagnostics.Reset();
        }

        [TearDown]
        public void TearDown()
        {
            VisualBridgeDebugBridge.Uninstall();
            VisualBridgeDebug.RegisterRequestHandler(Category, InterfaceId, null);
            VisualBridgeDebug.SetEncoder(null);
            VisualBridgeDebug.SetFrame(-1);
            VisualBridgeDebugReporting.Reset();
            VisualBridgeDebugDiagnostics.Reset();
        }

        // ---------- 契约：schema 与校验器 ----------

        [Test]
        public void SchemaDeclaresBothChannelZeroSwitchMessages()
        {
            var path = Path.GetFullPath(Path.Combine(
                VisualBridgeEditorBridgeService.UnityProjectRoot(),
                "..",
                "Protocol",
                "Schema",
                "visualbridge-editor-bridge.schema.json"));
            Assert.That(File.Exists(path), Is.True, "The protocol schema is the single source of the switch contract: " + path);

            var schema = JObject.Parse(File.ReadAllText(path));
            var definitions = (JObject)schema["$defs"];
            Assert.That(definitions, Is.Not.Null);

            // 两条消息都必须出现在根 oneOf 里，否则宿主解析时仍按未知消息判死。
            var references = new HashSet<string>();
            foreach (var entry in (JArray)schema["oneOf"])
            {
                references.Add(entry["$ref"].Value<string>());
            }

            Assert.That(references, Does.Contain("#/$defs/debugSetEnabledMessage"));
            Assert.That(references, Does.Contain("#/$defs/debugEnabledMessage"));

            foreach (var pair in new[]
                     {
                         ("debugSetEnabledMessage", "debugSetEnabled"),
                         ("debugEnabledMessage", "debugEnabled"),
                     })
            {
                var definition = (JObject)definitions[pair.Item1];
                Assert.That(definition, Is.Not.Null, pair.Item1 + " must be declared.");
                Assert.That(definition["additionalProperties"].Value<bool>(), Is.False, pair.Item1);
                Assert.That(
                    ((JArray)definition["required"]).ToObject<string[]>(),
                    Is.EquivalentTo(new[] { "type", "enabled" }),
                    pair.Item1 + " must require both type and enabled (enabled is never optional).");
                Assert.That(definition["properties"]["type"]["const"].Value<string>(), Is.EqualTo(pair.Item2), pair.Item1);
                Assert.That(definition["properties"]["enabled"]["type"].Value<string>(), Is.EqualTo("boolean"), pair.Item1);
            }
        }

        [Test]
        public void ValidatorAcceptsBothSwitchMessagesAndEchoesTheFlag()
        {
            var off = VisualBridgeEditorBridgeValidator.ValidateMessage(new JObject
            {
                ["type"] = "debugSetEnabled",
                ["enabled"] = false,
            });
            Assert.That(off.Type, Is.EqualTo(VisualBridgeBridgeMessageType.DebugSetEnabled));
            Assert.That(off.Enabled, Is.False);

            var on = VisualBridgeEditorBridgeValidator.ValidateMessage(new JObject
            {
                ["type"] = "debugEnabled",
                ["enabled"] = true,
            });
            Assert.That(on.Type, Is.EqualTo(VisualBridgeBridgeMessageType.DebugEnabled));
            Assert.That(on.Enabled, Is.True);

            // 序列化输出必须能通过与 wire 输入相同的严格校验（A.2 的回报帧）。
            Assert.That(
                VisualBridgeEditorBridgeValidator.CreateDebugEnabled(false).ToLine(),
                Is.EqualTo("{\"type\":\"debugEnabled\",\"enabled\":false}"));
            Assert.That(
                VisualBridgeEditorBridgeValidator.CreateDebugSetEnabled(true).ToLine(),
                Is.EqualTo("{\"type\":\"debugSetEnabled\",\"enabled\":true}"));
        }

        [Test]
        public void MalformedDebugSetEnabledIsRejectedAsInvalidMessage()
        {
            // 类型错：与既有布尔字段同一判据（bridge.invalidMessage），不新增错误码。
            // null 用 JObject 的显式成员赋值表达（JValue.CreateNull() 走索引器的隐式转换会歧义）。
            foreach (var value in new[] { "false", "true", "0" })
            {
                var payload = new JObject { ["type"] = "debugSetEnabled" };
                payload["enabled"] = new JValue(value);
                var exception = Assert.Throws<VisualBridgeIntegrationException>(
                    () => VisualBridgeEditorBridgeValidator.ValidateMessage(payload),
                    "enabled=" + value);
                Assert.That(exception.Code, Is.EqualTo("bridge.invalidMessage"), "enabled=" + value);
                Assert.That(exception.JsonPath, Does.StartWith("$.enabled"));
            }

            foreach (var value in new[] { 0, 1, 2 })
            {
                var payload = new JObject { ["type"] = "debugSetEnabled" };
                payload["enabled"] = new JValue(value);
                var exception = Assert.Throws<VisualBridgeIntegrationException>(
                    () => VisualBridgeEditorBridgeValidator.ValidateMessage(payload),
                    "enabled=" + value);
                Assert.That(exception.Code, Is.EqualTo("bridge.invalidMessage"), "enabled=" + value);
                Assert.That(exception.JsonPath, Does.StartWith("$.enabled"));
            }

            // JSON null 不是布尔值。
            var nullPayload = new JObject { ["type"] = "debugSetEnabled" };
            nullPayload["enabled"] = JValue.CreateNull();
            var nullException = Assert.Throws<VisualBridgeIntegrationException>(
                () => VisualBridgeEditorBridgeValidator.ValidateMessage(nullPayload));
            Assert.That(nullException.Code, Is.EqualTo("bridge.invalidMessage"));
            Assert.That(nullException.JsonPath, Does.StartWith("$.enabled"));

            // 缺字段（完全省略）走既有 schema 的 required 语义：bridge.missingProperty，
            // 绝不能被当成默认值 true/false 静默接受。
            var missing = Assert.Throws<VisualBridgeIntegrationException>(
                () => VisualBridgeEditorBridgeValidator.ValidateMessage(new JObject { ["type"] = "debugSetEnabled" }));
            Assert.That(missing.Code, Is.EqualTo("bridge.missingProperty"));
            Assert.That(missing.JsonPath, Is.EqualTo("$.enabled"));

            // 多余字段按未知属性拒绝（schema 的 additionalProperties:false）。
            var extra = Assert.Throws<VisualBridgeIntegrationException>(
                () => VisualBridgeEditorBridgeValidator.ValidateMessage(new JObject
                {
                    ["type"] = "debugSetEnabled",
                    ["enabled"] = true,
                    ["reason"] = "panel",
                }));
            Assert.That(extra.Code, Is.EqualTo("bridge.unknownProperty"));

            // 畸形消息不改变闸门：校验器只判形状，副作用在采纳路径上。
            Assert.That(VisualBridgeDebugReporting.Enabled, Is.True);
        }

        // ---------- 会话状态 ----------

        [Test]
        public void SessionStateKeepsTheSwitchValueAcrossADomainReload()
        {
            VisualBridgeSessionState.Clear();
            try
            {
                VisualBridgeSessionState.Empty
                    .WithDebugEnabled(false)
                    .Save();
                Assert.That(VisualBridgeSessionState.Load().DebugEnabled, Is.False,
                    "关闭状态必须跨 Domain Reload 保留，否则重连前 Unity 会重新开始上报。");

                VisualBridgeSessionState.Load().WithDebugEnabled(true).Save();
                Assert.That(VisualBridgeSessionState.Load().DebugEnabled, Is.True);
            }
            finally
            {
                VisualBridgeSessionState.Clear();
            }
        }

        // ---------- 闸门：关闭后不产生任何调试流消息 ----------

        [Test]
        public void DisabledReportingProducesNoDebugStreamMessages()
        {
            var wire = new FakeWire();
            var transport = new VisualBridgeDebugTransport(ConnectType.Editor, droppedReportIntervalMs: 0);
            transport.Bind(wire);
            VisualBridgeDebug.SetFrame(7);
            VisualBridgeDebugBridge.Install(transport);
            VisualBridgeDebug.SetEncoder(new VisualBridgeDebugJsonEncoder());

            // 先 Attach（连接建立）：当前帧会发一次，作为"闸门打开时可以上报"的对照。
            VisualBridgeDebug.Attach();
            Assert.That(wire.Controls.Count, Is.EqualTo(1), "Attach must flush the current frame while reporting is on.");
            wire.Controls.Clear();

            VisualBridgeDebugReporting.SetEnabled(false);

            // 1) 实例描述：Create 必须失败（传输层没发出 ⇒ 会话按既有语义回滚本地发布）。
            Assert.That(VisualBridgeDebug.Create(InstanceId, Category, "R", string.Empty), Is.False,
                "Create must not report while the switch is off.");

            // 2) 数据消息：Start 直接早退，编码器都不该被占用。
            Assert.That(VisualBridgeDebug.Start(InstanceId, Category, MethodId, InterfaceId, MethodName), Is.False);
            VisualBridgeDebug.PushParam("hp", 1, 5);
            Assert.That(VisualBridgeDebug.End(), Is.False);

            // 3) 调试流控制消息：debugFrame 同样被闸住。
            Assert.That(transport.SendControl(VisualBridgeDebugControlMessages.CreateFrame(9)), Is.False);

            // 4) 规格 ③：只有 debug / debugCreate / debugFinish / debugFrame 四条被拦；
            //    response / reject 不是调试流，必须照常送出（否则宿主只能等超时，而业务已经跑过）。
            Assert.That(transport.SendQueryError(1u, "runtime.queryBusy", "queue full"), Is.True,
                "A channel-1 response must not be gated: it is how the host learns the query failed.");
            Assert.That(transport.SendReject(2u, "nope"), Is.True);

            // 5) dropped 也不受开关影响：它按周期上报（节流窗口内是延迟，不是丢失）。
            Assert.That(transport.TryAdmitEvent(99, null, Category, MethodId), Is.False);
            transport.FlushDropped();

            Assert.That(CountControls(wire, "{\"type\":\"debugCreate\""), Is.EqualTo(0));
            Assert.That(CountControls(wire, "{\"type\":\"debugFinish\""), Is.EqualTo(0));
            Assert.That(CountControls(wire, "{\"type\":\"debugFrame\""), Is.EqualTo(0));
            Assert.That(CountControls(wire, "{\"type\":\"response\""), Is.EqualTo(2),
                "Failure responses are not part of the debug stream and must leave the transport.");
            Assert.That(CountControls(wire, "{\"type\":\"dropped\""), Is.EqualTo(1),
                "dropped must keep its periodic reporting while reporting is off.");
            Assert.That(wire.Datas.Count, Is.EqualTo(0), "No data message may leave the transport while reporting is off.");
        }

        // ---------- P1-1：关闭期的 request 立即拒绝，且不执行业务 handler ----------

        [Test]
        public void DisabledReportingRejectsQueriesBeforeEnqueueAndStillReportsDropped()
        {
            var wire = new FakeWire();
            var transport = new VisualBridgeDebugTransport(ConnectType.Editor, droppedReportIntervalMs: 0);
            transport.Bind(wire);
            VisualBridgeDebug.SetFrame(7);
            VisualBridgeDebugBridge.Install(transport);
            VisualBridgeDebug.SetEncoder(new VisualBridgeDebugJsonEncoder());
            VisualBridgeDebug.RegisterRequestHandler(Category, InterfaceId,
                new VisualBridgeDebugRequestDispatcher(DispatchCounted),
                new VisualBridgeDebugRequestParameterDecoder(DecodeNodeId));
            VisualBridgeDebug.Attach();
            Assert.That(VisualBridgeDebug.Create(InstanceId, Category, "R", string.Empty), Is.True);
            wire.Controls.Clear();

            VisualBridgeDebugReporting.SetEnabled(false);

            wire.RaiseFrameReceived(VisualBridgePayloadKind.Json, Encoding.UTF8.GetBytes(RequestJsonFixture));

            // (1) 立即拿到 runtime.debugNotEnabled，不让宿主等 4 s 超时（更不该只吞掉应答）。
            var response = FindLastControl(wire, "{\"type\":\"response\"");
            Assert.That(response, Is.Not.Null, "A query arriving while reporting is off must be answered immediately.");
            StringAssert.Contains("\"requestId\":\"req-12\"", response);
            StringAssert.Contains("\"ok\":false", response);
            StringAssert.Contains("\"code\":\"runtime.debugNotEnabled\"", response);

            // (2) 请求没有进队列：pump 无活可干，业务 handler 一次都没跑。
            Assert.That(VisualBridgeDebugQueryRuntime.Pump(), Is.EqualTo(0), "The rejected request must not be enqueued.");
            Assert.That(handlerRuns, Is.EqualTo(0), "The business handler must not run for a rejected query.");
            Assert.That(wire.Datas.Count, Is.EqualTo(0));

            // (3) 开关只关调试流，不关 dropped 的周期上报。
            Assert.That(transport.TryAdmitEvent(99, null, Category, MethodId), Is.False);
            transport.FlushDropped();
            var dropped = FindLastControl(wire, "{\"type\":\"dropped\"");
            Assert.That(dropped, Is.Not.Null, "dropped is delayed by throttling, never lost and never gated.");
            StringAssert.Contains("\"unknownSlot\":1", dropped);
        }

        // ---------- P1-2：抑制 ≠ 丢弃 ----------

        [Test]
        public void SwitchOffSuppressionIsNotCountedAsDroppedAndDoesNotWarn()
        {
            var wire = new FakeWire();
            var transport = new VisualBridgeDebugTransport(ConnectType.Editor, droppedReportIntervalMs: 0);
            transport.Bind(wire);
            VisualBridgeDebug.SetFrame(7);
            VisualBridgeDebugBridge.Install(transport);
            VisualBridgeDebug.SetEncoder(new VisualBridgeDebugJsonEncoder());
            VisualBridgeDebug.Attach();
            Assert.That(VisualBridgeDebug.Create(InstanceId, Category, "R", string.Empty), Is.True);
            wire.Controls.Clear();
            wire.Datas.Clear();

            VisualBridgeDebugReporting.SetEnabled(false);
            VisualBridgeDebugDiagnostics.Reset();

            // 高频事件是这条用例的重点：旧实现每一条都计一次 dropped 并打一条 warning。
            for (int index = 0; index < 100; index++)
            {
                if (!VisualBridgeDebug.Start(InstanceId, Category, MethodId, InterfaceId, MethodName))
                {
                    continue;
                }

                VisualBridgeDebug.PushParam("hp", 1, index);
                VisualBridgeDebug.End();
            }

            Assert.That(VisualBridgeDebugDiagnostics.WarningCount, Is.EqualTo(0),
                "Switch-off suppression must be silent. Warnings: "
                + string.Join(" | ", VisualBridgeDebugDiagnostics.GetWarnings()));
            Assert.That(transport.GetDroppedSnapshot().EncodeFailed, Is.EqualTo(0),
                "A.5's encodeFailed covers encode failure / disconnection / generation change, never the switch.");
            Assert.That(transport.GetDroppedSnapshot().Oversize, Is.EqualTo(0));
            Assert.That(wire.Datas.Count, Is.EqualTo(0));
            Assert.That(transport.GetDroppedSnapshot().UnknownSlot, Is.EqualTo(0));
        }

        // ---------- P1-4：关闭态 link-open 的失败 flush 不能清空待发队列 ----------

        [Test]
        public void ReopeningFlushesPendingCreatesOnAnAlreadyConnectedLink()
        {
            // 生产顺序：Create 时未连接（入待发队列）→ 连接建立（link-open）但闸门仍关（flush 必然失败）
            // → 开闸 → Attach。旧实现会在失败的 flush 后清空队列，而 Attach 又因"已连接且同代次"早退，
            // 结果会话快照有实例、传输层没有槽位 ⇒ 之后每条事件都计 unknownSlot，永久失联到重连。
            var wire = new FakeWire();
            var transport = new VisualBridgeDebugTransport(ConnectType.Editor, droppedReportIntervalMs: 0);
            VisualBridgeDebug.SetFrame(7);
            VisualBridgeDebugBridge.Install(transport); // 先 Install，此时未绑定连接
            VisualBridgeDebug.SetEncoder(new VisualBridgeDebugJsonEncoder());
            VisualBridgeDebugReporting.SetEnabled(false);

            Assert.That(VisualBridgeDebug.Create(InstanceId, Category, "R", string.Empty), Is.True,
                "未连接时 Create 只是入待发队列，与开关无关。");

            transport.Bind(wire);
            VisualBridgeDebug.Attach(); // link-open：这次 flush 一定发不出去（闸门关闭）
            Assert.That(wire.Controls.Count, Is.EqualTo(0), "关闭期间一条都不许写线上。");

            VisualBridgeDebugReporting.SetEnabled(true);
            VisualBridgeDebug.Attach(); // 已连接时的重开：必须强制再 flush 一次

            Assert.That(CountControls(wire, "{\"type\":\"debugCreate\""), Is.EqualTo(1),
                "The create that failed to flush while the switch was off must be retried on reopen.");
            StringAssert.Contains("\"instanceSlot\":1", FindLastControl(wire, "{\"type\":\"debugCreate\""));

            // 槽位确实建立了：之后的事件不再按未知槽位丢弃。
            Assert.That(VisualBridgeDebug.Start(InstanceId, Category, MethodId, InterfaceId, MethodName), Is.True,
                "The instance must remain routable after the reopen flush.");
            VisualBridgeDebug.PushParam("hp", 1, 5);
            Assert.That(VisualBridgeDebug.End(), Is.True);
            Assert.That(transport.GetDroppedSnapshot().UnknownSlot, Is.EqualTo(0),
                "A create flushed after reopen must register its slot on the transport.");
        }


        // ---------- P1-A：关闭期的 Finish 必须原样保留槽位（抑制 ≠ 结束） ----------

        [Test]
        public void FinishingWhileOffKeepsTheSlotSoTheInstanceStaysRoutable()
        {
            // 关闭期对已建实例调 Finish：会话层回滚了本地移除，但传输层的槽位过去在闸门前就被删掉了
            // （SendFinish 先 slots.Remove 再发送）⇒ 重开后该实例的每条事件都计 unknownSlot，直到重连。
            var wire = new FakeWire();
            var transport = new VisualBridgeDebugTransport(ConnectType.Editor, droppedReportIntervalMs: 0);
            transport.Bind(wire);
            VisualBridgeDebug.SetFrame(7);
            VisualBridgeDebugBridge.Install(transport);
            VisualBridgeDebug.SetEncoder(new VisualBridgeDebugJsonEncoder());
            VisualBridgeDebug.Attach();
            Assert.That(VisualBridgeDebug.Create(InstanceId, Category, "R", string.Empty), Is.True);
            wire.Controls.Clear();

            VisualBridgeDebugReporting.SetEnabled(false);
            Assert.That(VisualBridgeDebug.Finish(InstanceId), Is.False, "关闭期的 Finish 是抑制，不是成功结束。");
            Assert.That(CountControls(wire, "{\"type\":\"debugFinish\""), Is.EqualTo(0));

            VisualBridgeDebugReporting.SetEnabled(true);

            // 重开后同一实例必须仍可路由；旧实现里槽位已被提前删除，这里 Start 会直接失败。
            Assert.That(VisualBridgeDebug.Start(InstanceId, Category, MethodId, InterfaceId, MethodName), Is.True,
                "A suppressed Finish must not invalidate the transport slot.");
            VisualBridgeDebug.PushParam("hp", 1, 5);
            Assert.That(VisualBridgeDebug.End(), Is.True);
            Assert.That(transport.GetDroppedSnapshot().UnknownSlot, Is.EqualTo(0),
                "Events after a suppressed Finish must not be counted as unknownSlot.");
            Assert.That(wire.Datas.Count, Is.EqualTo(1));

            // 成功的 Finish 之后同 id 再 Create 是新实例（不是重复），必须重新补发描述并分配新槽位。
            Assert.That(VisualBridgeDebug.Finish(InstanceId), Is.True);
            Assert.That(CountControls(wire, "{\"type\":\"debugFinish\""), Is.EqualTo(1));
            Assert.That(VisualBridgeDebug.Create(InstanceId, Category, "R", string.Empty), Is.True,
                "Re-creating a finished instance must not be treated as a duplicate.");
            Assert.That(CountControls(wire, "{\"type\":\"debugCreate\""), Is.EqualTo(1));
            StringAssert.Contains("\"instanceSlot\":2", FindLastControl(wire, "{\"type\":\"debugCreate\""));
        }

        // ---------- P2-5：关闭期的失败 Create 不得消耗槽位号 ----------

        [Test]
        public void SuppressedCreatesDoNotConsumeSlotNumbers()
        {
            // 连接着但开关关闭：Create 走"发布 → 发送被抑制 → 回滚"。槽位号也必须退回，
            // 否则 65535 次关闭期 Create 会把 ushort 槽位耗尽，重开后新实例全部发不出去。
            var wire = new FakeWire();
            var transport = new VisualBridgeDebugTransport(ConnectType.Editor, droppedReportIntervalMs: 0);
            transport.Bind(wire);
            VisualBridgeDebug.SetFrame(7);
            VisualBridgeDebugBridge.Install(transport);
            VisualBridgeDebug.SetEncoder(new VisualBridgeDebugJsonEncoder());
            VisualBridgeDebug.Attach();
            wire.Controls.Clear();

            VisualBridgeDebugReporting.SetEnabled(false);
            Assert.That(VisualBridgeDebug.Create("hero", Category, "R", string.Empty), Is.False);
            Assert.That(VisualBridgeDebug.Create("npc", Category, "R", string.Empty), Is.False);
            Assert.That(wire.Controls.Count, Is.EqualTo(0));

            VisualBridgeDebugReporting.SetEnabled(true);
            Assert.That(VisualBridgeDebug.Create(InstanceId, Category, "R", string.Empty), Is.True);
            StringAssert.Contains("\"instanceSlot\":1", FindLastControl(wire, "{\"type\":\"debugCreate\""),
                "A create that failed while reporting was off must not consume a slot number.");
        }

        // ---------- P2-3：查询结果不是调试流，关闭期也必须送达 ----------

        [Test]
        public void QueryResultStillArrivesWhenTheSwitchTurnsOffInFlight()
        {
            // 宿主发起的查询在途时面板关掉开关：debugResult 是这条查询的应答（A.5 的 response 语义），
            // 被闸住会让宿主只能等 4 s 超时——正是 P1-1 要消灭的伤害。
            var wire = new FakeWire();
            var transport = new VisualBridgeDebugTransport(ConnectType.Editor, droppedReportIntervalMs: 0);
            transport.Bind(wire);
            VisualBridgeDebug.SetFrame(7);
            VisualBridgeDebugBridge.Install(transport);
            VisualBridgeDebug.SetEncoder(new VisualBridgeDebugJsonEncoder());
            VisualBridgeDebug.RegisterRequestHandler(Category, InterfaceId,
                new VisualBridgeDebugRequestDispatcher(DispatchVisible), new VisualBridgeDebugRequestParameterDecoder(DecodeNodeId));
            VisualBridgeDebug.Attach();
            Assert.That(VisualBridgeDebug.Create(InstanceId, Category, "R", string.Empty), Is.True);
            wire.Controls.Clear();
            wire.Datas.Clear();

            wire.RaiseFrameReceived(VisualBridgePayloadKind.Json, Encoding.UTF8.GetBytes(RequestJsonFixture));
            VisualBridgeDebugReporting.SetEnabled(false);

            Assert.That(VisualBridgeDebugQueryRuntime.Pump(), Is.EqualTo(1), "The in-flight query must still use the handler.");
            Assert.That(wire.Datas.Count, Is.EqualTo(1),
                "debugResult answers a host-issued query; switching reporting off must not swallow it.");
            StringAssert.Contains("\"type\":\"debugResult\"", Text(wire.Datas[0]));
        }

        [Test]
        public void ReenablingReportingResumesTheDebugStream()
        {
            var wire = new FakeWire();
            var transport = new VisualBridgeDebugTransport(ConnectType.Editor, droppedReportIntervalMs: 0);
            transport.Bind(wire);
            VisualBridgeDebug.SetFrame(7);
            VisualBridgeDebugBridge.Install(transport);
            VisualBridgeDebug.SetEncoder(new VisualBridgeDebugJsonEncoder());
            VisualBridgeDebug.Attach();
            wire.Controls.Clear();

            VisualBridgeDebugReporting.SetEnabled(false);
            Assert.That(VisualBridgeDebug.Create(InstanceId, Category, "R", string.Empty), Is.False);
            Assert.That(wire.Controls.Count, Is.EqualTo(0));

            // 重新打开：A.5 的"连接建立"挂接语义（幂等，不重发帧），之后 Create 与事件立即恢复。
            VisualBridgeDebugReporting.SetEnabled(true);
            VisualBridgeDebugBridge.Attach();

            Assert.That(VisualBridgeDebug.Create(InstanceId, Category, "R", string.Empty), Is.True,
                "A re-enabled switch must accept the instance description again.");
            Assert.That(wire.Controls.Count, Is.EqualTo(1));
            StringAssert.Contains("\"type\":\"debugCreate\"", Text(wire.Controls[0]));

            Assert.That(VisualBridgeDebug.Start(InstanceId, Category, MethodId, InterfaceId, MethodName), Is.True);
            VisualBridgeDebug.PushParam("hp", 1, 5);
            Assert.That(VisualBridgeDebug.End(), Is.True);
            Assert.That(wire.Datas.Count, Is.EqualTo(1), "Data messages must flow again once reporting is back on.");
        }

        [Test]
        public void ReenablingFlushesTheCreatesPublishedWhileReportingWasOff()
        {
            // (d) 的另一种情形：关闭期间还没有连接，描述进待发队列；重新打开时补的那次 Attach
            // 必须兑现 A.5「连接建立时先 flush 待发项」，而不是把待发项一起丢掉。
            var wire = new FakeWire();
            var transport = new VisualBridgeDebugTransport(ConnectType.Editor, droppedReportIntervalMs: 0);
            VisualBridgeDebug.SetFrame(7);
            VisualBridgeDebugBridge.Install(transport); // 先 Install，此时未绑定连接
            VisualBridgeDebug.SetEncoder(new VisualBridgeDebugJsonEncoder());

            VisualBridgeDebugReporting.SetEnabled(false);
            Assert.That(VisualBridgeDebug.Create(InstanceId, Category, "R", string.Empty), Is.True,
                "未连接时 Create 只是入待发队列，与开关无关。");
            Assert.That(wire.Controls.Count, Is.EqualTo(0), "关闭期间一条都不许写线上。");

            transport.Bind(wire);
            VisualBridgeDebugReporting.SetEnabled(true);
            VisualBridgeDebugBridge.Attach();

            Assert.That(wire.Controls.Count, Is.EqualTo(2),
                "重新打开后的挂接必须同时 flush 当前帧与关闭期间排队的描述。");
            StringAssert.Contains("\"type\":\"debugFrame\"", Text(wire.Controls[0]));
            StringAssert.Contains("\"type\":\"debugCreate\"", Text(wire.Controls[1]));
            StringAssert.Contains("\"instanceSlot\":1", Text(wire.Controls[1]),
                "待发描述必须带首次分配的槽位，不能因为一次开关就被丢掉或重排。");
        }

        [Test]
        public void AlreadyCreatedInstancesKeepReportingAcrossAFlip()
        {
            // 关闭/打开不 reset 会话（不伪造断连），因此槽位不会重排：关闭前创建、打开后仍能上报。
            var wire = new FakeWire();
            var transport = new VisualBridgeDebugTransport(ConnectType.Editor, droppedReportIntervalMs: 0);
            transport.Bind(wire);
            VisualBridgeDebug.SetFrame(7);
            VisualBridgeDebugBridge.Install(transport);
            VisualBridgeDebug.SetEncoder(new VisualBridgeDebugJsonEncoder());
            VisualBridgeDebug.Attach();

            Assert.That(VisualBridgeDebug.Create(InstanceId, Category, "R", string.Empty), Is.True);
            wire.Controls.Clear();
            wire.Datas.Clear();

            VisualBridgeDebugReporting.SetEnabled(false);
            Assert.That(VisualBridgeDebug.Start(InstanceId, Category, MethodId, InterfaceId, MethodName), Is.False,
                "A suppressed message must be refused at the production point, before it is encoded.");
            VisualBridgeDebug.PushParam("hp", 1, 5);
            Assert.That(VisualBridgeDebug.End(), Is.False, "Nothing was started, so there is nothing to end.");
            Assert.That(wire.Datas.Count, Is.EqualTo(0));
            Assert.That(transport.GetDroppedSnapshot().EncodeFailed, Is.EqualTo(0),
                "Suppressing a message is not a drop (A.5's encodeFailed does not cover the switch).");

            VisualBridgeDebugReporting.SetEnabled(true);
            Assert.That(VisualBridgeDebug.Start(InstanceId, Category, MethodId, InterfaceId, MethodName), Is.True);
            VisualBridgeDebug.PushParam("hp", 1, 6);
            Assert.That(VisualBridgeDebug.End(), Is.True);
            Assert.That(wire.Datas.Count, Is.EqualTo(1));
            Assert.That(transport.GetDroppedSnapshot().UnknownSlot, Is.EqualTo(0),
                "A flip must not renumber slots while the peer still holds the old mapping.");
        }

        private bool DispatchCounted(ushort methodId, string instanceId, ushort instanceSlot, uint requestSeq,
            object[] parameters)
        {
            handlerRuns++;
            return true;
        }

        private static bool DispatchVisible(ushort methodId, string instanceId, ushort instanceSlot, uint requestSeq,
            object[] parameters)
        {
            if (methodId != MethodId || parameters == null || parameters.Length != 1)
            {
                return false;
            }

            var request = new VisualBridgeDebugRequest(instanceId, instanceSlot, methodId, requestSeq,
                Category, InterfaceId, "IsVisible");
            if (!VisualBridgeDebug.StartResult(request))
            {
                return false;
            }

            VisualBridgeDebug.PushParam("visible", 1, (int)parameters[0] > 0);
            return VisualBridgeDebug.End();
        }

        private static bool DecodeNodeId(ushort methodId, out string[] names, out ushort[] tags, out Type[] types)
        {
            if (methodId != MethodId)
            {
                names = null;
                tags = null;
                types = null;
                return false;
            }

            names = new[] { "nodeId" };
            tags = new[] { (ushort)1 };
            types = new[] { typeof(int) };
            return true;
        }

        private static string Text(byte[] payload)
        {
            return Encoding.UTF8.GetString(payload);
        }

        private static int CountControls(FakeWire wire, string prefix)
        {
            int count = 0;
            foreach (var payload in wire.Controls)
            {
                if (Text(payload).StartsWith(prefix, StringComparison.Ordinal))
                {
                    count++;
                }
            }

            return count;
        }

        private static string FindLastControl(FakeWire wire, string prefix)
        {
            for (int index = wire.Controls.Count - 1; index >= 0; index--)
            {
                var text = Text(wire.Controls[index]);
                if (text.StartsWith(prefix, StringComparison.Ordinal))
                {
                    return text;
                }
            }

            return null;
        }

        /// <summary>记录控制/数据消息的假连接，可手工触发入站帧（P1-1 的 query 拒绝需要它）。</summary>
        private sealed class FakeWire : IVisualBridgeDebugWire
        {
            public bool IsOpen => true;

            public long Generation => 1L;

            public long OverflowDroppedMessages => 0L;

            public List<byte[]> Controls { get; } = new List<byte[]>();

            public List<byte[]> Datas { get; } = new List<byte[]>();

            public event Action<VisualBridgePayloadKind, byte[]> FrameReceived;

            public event Action Closed;

            public event Action Tick;

            public bool SendControl(byte[] payload, VisualBridgeDebugPayloadFormat format)
            {
                Controls.Add(payload);
                return true;
            }

            public bool SendDebug(byte[] payload, VisualBridgeDebugPayloadFormat format)
            {
                Datas.Add(payload);
                return true;
            }

            public void RaiseFrameReceived(VisualBridgePayloadKind payloadKind, byte[] payload)
            {
                FrameReceived?.Invoke(payloadKind, payload);
            }

            public void RaiseTick()
            {
                Tick?.Invoke();
            }

            public void RaiseClosed()
            {
                Closed?.Invoke();
            }
        }
    }
}
