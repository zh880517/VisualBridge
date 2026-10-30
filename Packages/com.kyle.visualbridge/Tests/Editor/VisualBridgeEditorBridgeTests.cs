using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityEditor;
using UnityEngine;
using UnityEngine.TestTools;
using VisualBridge.Diagnostics;
using VisualBridge.Diagnostics.Bridge;
using VisualBridge.Runtime;

namespace VisualBridge.Editor.Tests
{
    public sealed class VisualBridgeEditorBridgeTests
    {
        private static readonly string ValidToken = new string('a', 48);
        private static readonly string SessionId = "6f9619ff-8b86-4d01-b42d-00cf4fc964ff#boot-1";

        [Test]
        public void BridgeSchemaAndValidatorShareParityFixture()
        {
            var fixtureAsset = AssetDatabase.LoadAssetAtPath<TextAsset>(
                "Packages/com.kyle.visualbridge/Tests/Fixtures/visualbridge-editor-bridge-cases.json");
            Assert.That(fixtureAsset, Is.Not.Null);
            var root = ParseWithoutDateCoercion(fixtureAsset.text);
            var cases = (JArray)root["cases"];
            Assert.That(cases.Count, Is.GreaterThan(0));
            foreach (var testCase in cases.Cast<JObject>())
            {
                var value = testCase["value"] as JObject;
                Assert.That(value, Is.Not.Null, testCase.Value<string>("label"));
                if (testCase.Value<string>("target") == "discoveryRecord")
                {
                    if (testCase.Value<bool>("valid"))
                    {
                        Assert.DoesNotThrow(
                            () => VisualBridgeEditorBridgeValidator.ValidateDiscoveryRecord(value, "test.json"),
                            testCase.Value<string>("label"));
                    }
                    else
                    {
                        var exception = Assert.Throws<VisualBridgeIntegrationException>(
                            () => VisualBridgeEditorBridgeValidator.ValidateDiscoveryRecord(value, "test.json"),
                            testCase.Value<string>("label"));
                        Assert.That(exception.Code, Is.EqualTo(testCase.Value<string>("loaderCode")), testCase.Value<string>("label"));
                    }
                }
                else
                {
                    if (testCase.Value<bool>("valid"))
                    {
                        Assert.DoesNotThrow(
                            () => VisualBridgeEditorBridgeValidator.ValidateMessage(value),
                            testCase.Value<string>("label"));
                    }
                    else
                    {
                        var exception = Assert.Throws<VisualBridgeIntegrationException>(
                            () => VisualBridgeEditorBridgeValidator.ValidateMessage(value),
                            testCase.Value<string>("label"));
                        Assert.That(exception.Code, Is.EqualTo(testCase.Value<string>("loaderCode")), testCase.Value<string>("label"));
                    }
                }
            }
        }

        [Test]
        public void SerializedRequestsSurviveStrictValidation()
        {
            var hello = VisualBridgeEditorBridgeValidator.CreateHello(
                "editor-1234", ValidToken, "efbd32c726d801eb", new[] { "json", "binary" });
            Assert.DoesNotThrow(() => VisualBridgeEditorBridgeValidator.ValidateMessage(hello.ToJson()));

            var open = VisualBridgeEditorBridgeValidator.CreateOpen("req-1", "Config/Game.gamesettings");
            var reparsed = VisualBridgeEditorBridgeValidator.ValidateMessage(open.ToJson());
            Assert.That(reparsed.DocumentPath, Is.EqualTo("Config/Game.gamesettings"));

            var reveal = VisualBridgeEditorBridgeValidator.CreateReveal("req-2", "game.item:ion-blaster", false);
            Assert.That(VisualBridgeEditorBridgeValidator.ValidateMessage(reveal.ToJson()).ReferenceValue, Is.EqualTo("game.item:ion-blaster"));

            var numeric = VisualBridgeEditorBridgeValidator.CreateReveal("req-3", "42", true);
            Assert.That(VisualBridgeEditorBridgeValidator.ValidateMessage(numeric.ToJson()).ReferenceIsNumber, Is.True);
        }

        [Test]
        public void ClientConnectsHandshakesAndSendsOpenRequest()
        {
            using (var server = BridgeTestServer.Start(Welcome(generation: 7)))
            using (var client = new VisualBridgeEditorBridgeClient(TestWindow(server.Port, generation: 7), "editor-1234", ""))
            {
                var welcome = client.Connect();
                Assert.That(welcome.Generation, Is.EqualTo(7));
                Assert.That(welcome.SessionId, Is.EqualTo(SessionId));
                Assert.That(welcome.Resumed, Is.False);
                Assert.That(client.State, Is.EqualTo(VisualBridgeBridgeConnectionState.Connected));

                var hello = (JObject)JToken.Parse(server.ReceivedHello);
                Assert.That(hello["type"].Value<string>(), Is.EqualTo("hello"));
                Assert.That(hello["protocolVersion"].Value<int>(), Is.EqualTo(4));
                Assert.That(hello["role"].Value<string>(), Is.EqualTo("editor"));
                Assert.That(hello["clientEndpointId"].Value<string>(), Is.EqualTo("editor-1234"));
                Assert.That(hello["token"].Value<string>(), Is.EqualTo(ValidToken));
                Assert.That(hello["contractHash"].Value<string>(), Is.EqualTo(""));
                Assert.That(hello["payloads"].ToObject<string[]>(), Is.EquivalentTo(new[] { "json", "binary" }));
                Assert.That(hello.Property("resumeSessionId"), Is.Null);

                server.QueueResponse("{\"type\":\"response\",\"requestId\":\"req-open-1\",\"status\":\"ok\"}");
                var response = client.SendRequest(VisualBridgeEditorBridgeValidator.CreateOpen("req-open-1", "Config/Game.gamesettings"), 5000);
                Assert.That(response.IsOk, Is.True);

                var requests = server.GetReceivedRequests();
                Assert.That(requests.Length, Is.EqualTo(1));
                var received = (JObject)JToken.Parse(requests[0]);
                Assert.That(received["type"].Value<string>(), Is.EqualTo("open"));
                Assert.That(received["documentPath"].Value<string>(), Is.EqualTo("Config/Game.gamesettings"));
                Assert.That(received["requestId"].Value<string>(), Is.EqualTo("req-open-1"));
            }
        }

        [Test]
        public void ClientConsumesKeepAliveFramesOnTheConnectionLayer()
        {
            // G3b：附录 A.9 的保活帧必须在 VisualBridgeEditorBridgeValidator 解析之前消化。
            // 假服务端用真实 socket 在握手后发 ping：连接不得断、必须回 pong、之后业务仍然正常。
            using (var server = BridgeTestServer.Start(Welcome(generation: 1)))
            using (var client = new VisualBridgeEditorBridgeClient(TestWindow(server.Port), "editor-1234", ""))
            {
                Assert.DoesNotThrow(() => client.Connect());
                var pingSentAt = DateTime.UtcNow;

                Assert.That(server.Push("{\"type\":\"ping\"}"), Is.True);
                Assert.That(
                    WaitForReceivedLine(server, "\"type\":\"pong\"", 5000, () => client.Pump()),
                    Is.EqualTo("{\"type\":\"pong\"}"),
                    "The client must answer a ping with a pong frame.");
                Assert.That(client.State, Is.EqualTo(VisualBridgeBridgeConnectionState.Connected),
                    "A keepalive ping must never drop the connection.");
                Assert.That(client.LastInboundUtc, Is.GreaterThanOrEqualTo(pingSentAt),
                    "Consuming the keepalive ping must register inbound activity after the frame was sent.");

                var pong = server.GetReceivedFrames().Last(frame => frame.Line == "{\"type\":\"pong\"}");
                Assert.That(pong.Channel, Is.EqualTo(VisualBridgeChannel.Editor), "The pong must travel on channel 0.");
                Assert.That(pong.PayloadKind, Is.EqualTo(VisualBridgePayloadKind.Json), "The pong must be a JSON payload.");

                // pong 同样不得进入业务分发（不抛违例、不产生任何业务效果）；Pump 必须把它计入处理帧数。
                var pongSentAt = DateTime.UtcNow;
                Assert.That(server.Push("{\"type\":\"pong\"}"), Is.True);
                Assert.That(PumpUntilHandled(client, 1), Is.GreaterThanOrEqualTo(1),
                    "Pump must count the keepalive pong it consumes in its handled-frame count.");
                Assert.That(client.LastInboundUtc, Is.GreaterThanOrEqualTo(pongSentAt),
                    "Consuming the keepalive pong must register inbound activity after the frame was sent.");

                // 保活之后业务消息仍正常：同一连接上的 open 请求得到配对应答。
                server.QueueResponse("{\"type\":\"response\",\"requestId\":\"req-after-ping\",\"status\":\"ok\"}");
                var response = client.SendRequest(
                    VisualBridgeEditorBridgeValidator.CreateOpen("req-after-ping", "Config/Game.gamesettings"),
                    5000);
                Assert.That(response.IsOk, Is.True);
                Assert.That(client.State, Is.EqualTo(VisualBridgeBridgeConnectionState.Connected));
            }
        }

        [Test]
        public void EditorLegDoesNotSendKeepAlivePingsWhileIdleAndStaysConnected()
        {
            // 任务书 §已知限制 1：Editor 腿是否主动发 ping 必须实测。Editor 腿是请求/响应客户端，
            // 没有 Runtime 腿写线程的 10 s 保活，空闲 11 s 不会主动发 ping；连接仍由后续请求证明存活。
            using (var server = BridgeTestServer.Start(Welcome(generation: 1)))
            using (var client = new VisualBridgeEditorBridgeClient(TestWindow(server.Port), "editor-1234", ""))
            {
                Assert.DoesNotThrow(() => client.Connect());
                var idleUntil = DateTime.UtcNow.AddSeconds(11.5);
                while (DateTime.UtcNow < idleUntil)
                {
                    Assert.DoesNotThrow(() => client.Pump());
                    Thread.Sleep(10);
                }

                Assert.That(client.State, Is.EqualTo(VisualBridgeBridgeConnectionState.Connected),
                    "The connection must stay alive for more than the 10 s keepalive interval.");
                Assert.That(server.GetReceivedFrames().Any(frame => frame.Line == "{\"type\":\"ping\"}"), Is.False,
                    "Editor 腿只消化对端 ping，自己不发：空闲 11 s 后线上不应出现 ping。");

                server.QueueResponse("{\"type\":\"response\",\"requestId\":\"req-after-idle\",\"status\":\"ok\"}");
                var response = client.SendRequest(
                    VisualBridgeEditorBridgeValidator.CreateOpen("req-after-idle", "Config/Game.gamesettings"),
                    5000);
                Assert.That(response.IsOk, Is.True, "Business messages must still work after a long idle period.");
            }
        }

        [Test]
        public void ClientStillRejectsUnknownMessageTypesAfterKeepAliveSupport()
        {
            // 不放宽严格性（F7）：只有 ping/pong 是连接层特例，其它未知类型仍必须报 unknownMessageType。
            using (var server = BridgeTestServer.Start(Welcome(generation: 1)))
            using (var client = new VisualBridgeEditorBridgeClient(TestWindow(server.Port), "editor-1234", ""))
            {
                Assert.DoesNotThrow(() => client.Connect());
                Assert.That(server.Push("{\"type\":\"teleport\"}"), Is.True);

                // 数据到达主线程有抖动：单次 Pump 可能恰好看到 DataAvailable=false（评审指出的潜在 flake）。
                // 按 deadline 反复 Pump 直到异常出现；超时给出可读的失败信息，而不是靠一次 Sleep 碰运气。
                var deadline = DateTime.UtcNow.AddSeconds(2);
                VisualBridgeIntegrationException failure = null;
                while (failure == null && DateTime.UtcNow < deadline)
                {
                    try
                    {
                        client.Pump();
                    }
                    catch (VisualBridgeIntegrationException exception)
                    {
                        failure = exception;
                    }

                    if (failure == null)
                    {
                        Thread.Sleep(10);
                    }
                }

                Assert.That(failure, Is.Not.Null,
                    "Expected bridge.unknownMessageType within 2000 ms of pushing 'teleport', but Pump never threw.");
                Assert.That(failure.Code, Is.EqualTo("bridge.unknownMessageType"));
                Assert.That(failure.Message, Does.Contain("'teleport'"));
            }
        }

        [Test]
        public void ServiceDropsTheConnectionAfterAnUnknownMessageType()
        {
            // 与上一条同源的断链证据：未知类型经服务层节拍必须归一成断连，而不是被保活分支吞掉。
            // 断链原因必须钉死到 bridge.unknownMessageType：若只断言 IsConnected=False，
            // 任何异常（例如校验器不再抛错后冒出的 NullReferenceException）都会让用例假绿（评审实证）。
            VisualBridgeSessionState.Clear();
            VisualBridgeDebugReporting.Reset();
            var service = VisualBridgeEditorBridgeService.Instance;
            try
            {
                using (var server = BridgeTestServer.Start(Welcome(generation: 1)))
                {
                    service.Disconnect();
                    service.Connect(TestWindow(server.Port, 1));
                    Assert.That(service.IsConnected, Is.True);

                    LogAssert.Expect(
                        LogType.Warning,
                        new Regex(
                            @"\[bridge\] dropping the connection after a control message failure: "
                            + @"bridge\.unknownMessageType .*Unknown message type 'teleport'\."));

                    Assert.That(server.Push("{\"type\":\"teleport\"}"), Is.True);

                    var deadline = DateTime.UtcNow.AddSeconds(5);
                    while (service.IsConnected && DateTime.UtcNow < deadline)
                    {
                        Assert.DoesNotThrow(() => service.Pump());
                        Thread.Sleep(10);
                    }

                    Assert.That(service.IsConnected, Is.False,
                        "A non-keepalive unknown message type must still drop the connection.");
                }
            }
            finally
            {
                service.Disconnect();
                VisualBridgeSessionState.Clear();
                VisualBridgeDebugReporting.Reset();
            }
        }

        [Test]
        public void ClientSendsResumeSessionAndAcceptsResumedWelcome()
        {
            using (var server = BridgeTestServer.Start(Welcome(generation: 1, resumed: true)))
            using (var client = new VisualBridgeEditorBridgeClient(
                TestWindow(server.Port), "editor-1234", "efbd32c726d801eb", SessionId))
            {
                var welcome = client.Connect();
                Assert.That(welcome.Resumed, Is.True);
                Assert.That(client.Resumed, Is.True);
                Assert.That(client.SessionId, Is.EqualTo(SessionId));

                var hello = (JObject)JToken.Parse(server.ReceivedHello);
                Assert.That(hello["contractHash"].Value<string>(), Is.EqualTo("efbd32c726d801eb"));
                Assert.That(hello["resumeSessionId"].Value<string>(), Is.EqualTo(SessionId));
            }
        }

        [Test]
        public void ClientRejectsInvalidTokenErrorFromServer()
        {
            using (var server = BridgeTestServer.Start("{\"type\":\"error\",\"code\":\"runtime.invalidToken\",\"detail\":\"rejected\"}"))
            using (var client = new VisualBridgeEditorBridgeClient(TestWindow(server.Port), "editor-1234", ""))
            {
                var exception = Assert.Throws<VisualBridgeIntegrationException>(() => client.Connect());
                Assert.That(exception.Code, Is.EqualTo("runtime.invalidToken"));
                Assert.That(client.State, Is.EqualTo(VisualBridgeBridgeConnectionState.Disconnected));
            }
        }

        [Test]
        public void ClientRejectsProtocolVersionMismatchErrorFromServer()
        {
            using (var server = BridgeTestServer.Start("{\"type\":\"error\",\"code\":\"runtime.unsupportedProtocolVersion\"}"))
            using (var client = new VisualBridgeEditorBridgeClient(TestWindow(server.Port), "editor-1234", ""))
            {
                var exception = Assert.Throws<VisualBridgeIntegrationException>(() => client.Connect());
                Assert.That(exception.Code, Is.EqualTo("runtime.unsupportedProtocolVersion"));
            }
        }

        [Test]
        public void ClientRejectsWelcomeWithStaleServerGeneration()
        {
            using (var server = BridgeTestServer.Start(Welcome(generation: 1)))
            using (var client = new VisualBridgeEditorBridgeClient(TestWindow(server.Port, generation: 2), "editor-1234", ""))
            {
                var exception = Assert.Throws<VisualBridgeIntegrationException>(() => client.Connect());
                Assert.That(exception.Code, Is.EqualTo("bridge.staleGeneration"));
            }
        }

        [Test]
        public void ClientKeepsConnectionWhenServerContractHashDiffers()
        {
            using (var server = BridgeTestServer.Start(Welcome(generation: 1, contractHash: "aaaaaaaaaaaaaaaa", payloads: "[\"json\"]")))
            using (var client = new VisualBridgeEditorBridgeClient(TestWindow(server.Port, generation: 1), "editor-1234", "efbd32c726d801eb"))
            {
                Assert.DoesNotThrow(() => client.Connect());
                Assert.That(client.ServerContractHash, Is.EqualTo("aaaaaaaaaaaaaaaa"));
                Assert.That(client.ServerPayloads, Is.EquivalentTo(new[] { "json" }));
                Assert.That(client.State, Is.EqualTo(VisualBridgeBridgeConnectionState.Connected));
            }
        }

        [Test]
        public void ClientAppliesDebugSetEnabledAndBroadcastsTheAppliedValue()
        {
            // F7：附录 A.2 的通道 0 开关命令。服务端在空闲时主动推，客户端由主线程节拍收下并回报。
            VisualBridgeSessionState.Clear();
            VisualBridgeDebugReporting.Reset();
            try
            {
                using (var server = BridgeTestServer.Start(Welcome(generation: 1)))
                using (var client = new VisualBridgeEditorBridgeClient(TestWindow(server.Port), "editor-1234", ""))
                {
                    Assert.DoesNotThrow(() => client.Connect());
                    Assert.That(VisualBridgeDebugReporting.Enabled, Is.True, "Reporting defaults to on.");

                    Assert.That(server.Push("{\"type\":\"debugSetEnabled\",\"enabled\":false}"), Is.True);
                    Assert.That(PumpUntilHandled(client, 1), Is.GreaterThan(0), "Pump must pick up the pushed command.");

                    Assert.That(VisualBridgeDebugReporting.Enabled, Is.False, "The gate must close as soon as the command is applied.");
                    Assert.That(VisualBridgeSessionState.Load().DebugEnabled, Is.False,
                        "The applied value must be persisted in SessionState (附录 A.2/A.3).");
                    Assert.That(client.State, Is.EqualTo(VisualBridgeBridgeConnectionState.Connected));

                    var off = WaitForReceivedLine(server, "\"type\":\"debugEnabled\"");
                    Assert.That(off, Is.EqualTo("{\"type\":\"debugEnabled\",\"enabled\":false}"),
                        "Unity must echo the applied value as the debugEnabled broadcast.");

                    // 再打开：广播 true，闸门恢复。
                    Assert.That(server.Push("{\"type\":\"debugSetEnabled\",\"enabled\":true}"), Is.True);
                    Assert.That(PumpUntilHandled(client, 1), Is.GreaterThan(0));
                    Assert.That(VisualBridgeDebugReporting.Enabled, Is.True);
                    Assert.That(VisualBridgeSessionState.Load().DebugEnabled, Is.True);
                    Assert.That(WaitForReceivedLine(server, "\"enabled\":true"),
                        Is.EqualTo("{\"type\":\"debugEnabled\",\"enabled\":true}"));
                }
            }
            finally
            {
                VisualBridgeSessionState.Clear();
                VisualBridgeDebugReporting.Reset();
            }
        }

        [Test]
        public void ClientTreatsMalformedDebugSetEnabledAsAProtocolViolation()
        {
            // F7 复审裁决的语义变更声明：
            //   旧语义 = 畸形开关消息"宽容跳过"，只计 RejectedControlMessages，连接保留；
            //   新语义 = 与其它畸形控制消息一致，严格报错并断开（两侧都严格，不再有特例）。
            // 客户端只负责把违例抛出来；断开由服务层节拍统一执行（见下一个用例）。
            VisualBridgeSessionState.Clear();
            VisualBridgeDebugReporting.Reset();
            try
            {
                using (var server = BridgeTestServer.Start(Welcome(generation: 1)))
                using (var client = new VisualBridgeEditorBridgeClient(TestWindow(server.Port), "editor-1234", ""))
                {
                    Assert.DoesNotThrow(() => client.Connect());

                    Assert.That(server.Push("{\"type\":\"debugSetEnabled\"}"), Is.True);
                    var missing = Assert.Throws<VisualBridgeIntegrationException>(() => client.Pump());
                    Assert.That(missing.Code, Is.EqualTo("bridge.missingProperty"));
                    Assert.That(VisualBridgeDebugReporting.Enabled, Is.True,
                        "A malformed command must not flip the switch even though it now fails the connection.");
                }
            }
            finally
            {
                VisualBridgeSessionState.Clear();
                VisualBridgeDebugReporting.Reset();
            }
        }

        [Test]
        public void ClientRejectsServerDebugEnabledBroadcastAsAProtocolViolation()
        {
            // debugEnabled 是 Unity → 宿主 的广播（附录 A.2）：监听端发来即方向错配。
            // 这里不保留"静默忽略"的例外，与其它越权类型一致按协议违例处理（F7 第 2 轮裁决）。
            VisualBridgeSessionState.Clear();
            VisualBridgeDebugReporting.Reset();
            try
            {
                using (var server = BridgeTestServer.Start(Welcome(generation: 1)))
                using (var client = new VisualBridgeEditorBridgeClient(TestWindow(server.Port), "editor-1234", ""))
                {
                    Assert.DoesNotThrow(() => client.Connect());
                    Assert.That(server.Push("{\"type\":\"debugEnabled\",\"enabled\":true}"), Is.True);
                    var violation = Assert.Throws<VisualBridgeIntegrationException>(() => client.Pump());
                    Assert.That(violation.Code, Is.EqualTo("bridge.protocolViolation"));
                    Assert.That(VisualBridgeDebugReporting.Enabled, Is.True,
                        "A misdirected broadcast must not flip the switch.");
                }
            }
            finally
            {
                VisualBridgeSessionState.Clear();
                VisualBridgeDebugReporting.Reset();
            }
        }

        [Test]
        public void ServiceDropsTheConnectionAfterAMalformedControlMessage()
        {
            VisualBridgeSessionState.Clear();
            VisualBridgeDebugReporting.Reset();
            var service = VisualBridgeEditorBridgeService.Instance;
            try
            {
                using (var server = BridgeTestServer.Start(Welcome(generation: 1)))
                {
                    service.Disconnect();
                    service.Connect(TestWindow(server.Port, 1));
                    Assert.That(service.IsConnected, Is.True);

                    Assert.That(server.Push("{\"type\":\"debugSetEnabled\",\"enabled\":\"false\"}"), Is.True);

                    // 服务层的节拍必须把违例归一成断连（异常不冒到 EditorApplication.update）。
                    var deadline = DateTime.UtcNow.AddSeconds(5);
                    while (service.IsConnected && DateTime.UtcNow < deadline)
                    {
                        Assert.DoesNotThrow(() => service.Pump());
                        Thread.Sleep(10);
                    }

                    Assert.That(service.IsConnected, Is.False,
                        "A malformed control message must drop the connection instead of being skipped.");
                    Assert.That(VisualBridgeDebugReporting.Enabled, Is.True);
                }
            }
            finally
            {
                service.Disconnect();
                VisualBridgeSessionState.Clear();
                VisualBridgeDebugReporting.Reset();
            }
        }

        [Test]
        public void ServiceConnectAlignsTheReportingGateWithWelcomeDebugEnabled()
        {
            // 附录 A.3：welcome.debugEnabled 是服务端权威值。Domain Reload 后静态闸门回到默认 true，
            // 重连必须按握手值重新对齐，否则面板刚关掉的上报会被悄悄打开。
            VisualBridgeSessionState.Clear();
            VisualBridgeDebugReporting.Reset();
            try
            {
                using (var server = BridgeTestServer.Start(Welcome(generation: 1, debugEnabled: false)))
                {
                    var service = VisualBridgeEditorBridgeService.Instance;
                    service.Disconnect();
                    service.Connect(TestWindow(server.Port, generation: 1));
                    Assert.That(VisualBridgeDebugReporting.Enabled, Is.False,
                        "The handshake value must win over the locally defaulted switch.");
                    Assert.That(service.Session.DebugEnabled, Is.False);
                }
            }
            finally
            {
                VisualBridgeEditorBridgeService.Instance.Disconnect();
                VisualBridgeSessionState.Clear();
                VisualBridgeDebugReporting.Reset();
            }
        }

        [Test]
        public void ReEnablingThroughTheClientFlushesPendingCreatesOnAnAlreadyConnectedLink()
        {
            // P2-1：ApplyDebugSetEnabled 的 Attach 分支过去只被"人工 Attach"覆盖（IsInstalled 恒 false），
            // 这条用例走 Install + 真传输 + 假连接，钉住"客户端采纳开关 → 已连接时强制补发待发项"。
            VisualBridgeSessionState.Clear();
            VisualBridgeDebugReporting.Reset();
            var wire = new DebugFakeWire();
            var transport = new VisualBridgeDebugTransport(ConnectType.Editor, droppedReportIntervalMs: 0);
            var service = VisualBridgeEditorBridgeService.Instance;
            try
            {
                VisualBridgeDebugReporting.SetEnabled(false);
                VisualBridgeDebug.SetFrame(7);
                VisualBridgeDebug.SetEncoder(new VisualBridgeDebugJsonEncoder());
                VisualBridgeDebugBridge.Install(transport); // 先 Install，此时未绑定连接
                Assert.That(VisualBridgeDebug.Create("hero", "graph", "R", string.Empty), Is.True,
                    "未连接时 Create 只是入待发队列。");

                // 生产顺序：link-open 发生在闸门关闭时，这次 flush 必然失败（旧实现会清空待发项）。
                transport.Bind(wire);
                VisualBridgeDebugBridge.Attach();
                Assert.That(wire.Controls.Count, Is.EqualTo(0), "关闭期间一条都不许写线上。");

                using (var server = BridgeTestServer.Start(Welcome(generation: 1, debugEnabled: false)))
                using (var client = new VisualBridgeEditorBridgeClient(TestWindow(server.Port), "editor-1234", ""))
                {
                    Assert.DoesNotThrow(() => client.Connect());

                    Assert.That(server.Push("{\"type\":\"debugSetEnabled\",\"enabled\":true}"), Is.True);
                    Assert.That(PumpUntilHandled(client, 1), Is.GreaterThan(0));
                    Assert.That(VisualBridgeDebugReporting.Enabled, Is.True);

                    Assert.That(CountDebugControls(wire, "\"type\":\"debugCreate\""), Is.EqualTo(1),
                        "The client's Attach must retry the create that failed to flush while reporting was off.");
                    Assert.That(WaitForReceivedLine(server, "\"type\":\"debugEnabled\""),
                        Is.EqualTo("{\"type\":\"debugEnabled\",\"enabled\":true}"));
                }
            }
            finally
            {
                VisualBridgeDebugBridge.Uninstall();
                VisualBridgeDebug.SetEncoder(null);
                VisualBridgeDebug.SetFrame(-1);
                service.Disconnect();
                VisualBridgeSessionState.Clear();
                VisualBridgeDebugReporting.Reset();
            }
        }

        [Test]
        public void AutoConnectPumpsIdleControlMessagesOnEveryEditorFrame()
        {
            // P2-2：静态构造里 `EditorApplication.update += PumpBridgeControlMessages` 这行删掉后
            // 之前仍全绿——因为它只被 MainThread 上的隐式帧驱动。这里从真实的委托链里取出
            // 那个回调并手动跑一帧：删掉该行就会拿不到委托，命令也就不会被消费。
            VisualBridgeSessionState.Clear();
            VisualBridgeDebugReporting.Reset();
            var service = VisualBridgeEditorBridgeService.Instance;
            try
            {
                using (var server = BridgeTestServer.Start(Welcome(generation: 1)))
                {
                    service.Disconnect();
                    service.Connect(TestWindow(server.Port, 1));
                    Assert.That(service.IsConnected, Is.True);

                    var updateField = typeof(EditorApplication).GetField(
                        "update", BindingFlags.Public | BindingFlags.Static);
                    Assert.That(updateField, Is.Not.Null,
                        "EditorApplication.update is expected to stay a public static delegate field.");
                    var callbacks = updateField.GetValue(null) as Delegate;
                    var pump = callbacks?.GetInvocationList().FirstOrDefault(entry =>
                        entry.Method.Name == "PumpBridgeControlMessages"
                        && entry.Method.DeclaringType == typeof(VisualBridgeEditorBridgeAutoConnect));
                    Assert.That(pump, Is.Not.Null,
                        "AutoConnect must subscribe PumpBridgeControlMessages to EditorApplication.update.");

                    Assert.That(server.Push("{\"type\":\"debugSetEnabled\",\"enabled\":false}"), Is.True);

                    // 手动跑一帧：等价于编辑器空闲时的 EditorApplication.update。
                    var frame = (EditorApplication.CallbackFunction)pump;
                    var deadline = DateTime.UtcNow.AddSeconds(5);
                    while (VisualBridgeDebugReporting.Enabled && DateTime.UtcNow < deadline)
                    {
                        frame();
                        Thread.Sleep(10);
                    }

                    Assert.That(VisualBridgeDebugReporting.Enabled, Is.False,
                        "An idle-frame switch command must be consumed by the registered per-frame pump.");
                    Assert.That(WaitForReceivedLine(server, "\"type\":\"debugEnabled\""),
                        Is.EqualTo("{\"type\":\"debugEnabled\",\"enabled\":false}"));
                }
            }
            finally
            {
                service.Disconnect();
                VisualBridgeSessionState.Clear();
                VisualBridgeDebugReporting.Reset();
            }
        }

        private static int PumpUntilHandled(VisualBridgeEditorBridgeClient client, int expected, int timeoutMs = 5000)
        {
            var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
            var handled = 0;
            while (DateTime.UtcNow < deadline)
            {
                handled += client.Pump();
                if (handled >= expected)
                {
                    return handled;
                }

                Thread.Sleep(10);
            }

            return handled;
        }

        private static int CountDebugControls(DebugFakeWire wire, string fragment)
        {
            var count = 0;
            foreach (var payload in wire.Controls)
            {
                if (Encoding.UTF8.GetString(payload).Contains(fragment))
                {
                    count++;
                }
            }

            return count;
        }

        private static string WaitForReceivedLine(
            BridgeTestServer server,
            string expectedFragment,
            int timeoutMs = 5000,
            Action pump = null)
        {
            var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
            while (DateTime.UtcNow < deadline)
            {
                pump?.Invoke();
                foreach (var line in server.GetReceivedRequests())
                {
                    if (line != null && line.Contains(expectedFragment))
                    {
                        return line;
                    }
                }

                Thread.Sleep(10);
            }

            Assert.Fail("The client never sent a line containing '" + expectedFragment + "'.");
            return null;
        }

        [Test]
        public void ClientFailsPendingRequestWhenServerSendsInvalidJson()
        {
            using (var server = BridgeTestServer.Start(Welcome(generation: 1), thenSend: "{not json"))
            using (var client = new VisualBridgeEditorBridgeClient(TestWindow(server.Port), "editor-1234", ""))
            {
                Assert.DoesNotThrow(() => client.Connect());
                var exception = Assert.Throws<VisualBridgeIntegrationException>(() =>
                    client.SendRequest(VisualBridgeEditorBridgeValidator.CreateOpen("req-json-1", "Config/Game.gamesettings"), 5000));
                Assert.That(exception.Code, Is.EqualTo("bridge.invalidJson"));
            }
        }

        [Test]
        public void ClientRejectsResponseToUnknownRequest()
        {
            using (var server = BridgeTestServer.Start(Welcome(generation: 1)))
            using (var client = new VisualBridgeEditorBridgeClient(TestWindow(server.Port), "editor-1234", ""))
            {
                Assert.DoesNotThrow(() => client.Connect());
                server.QueueResponse("{\"type\":\"response\",\"requestId\":\"req-not-mine\",\"status\":\"ok\"}");
                var exception = Assert.Throws<VisualBridgeIntegrationException>(() =>
                    client.SendRequest(VisualBridgeEditorBridgeValidator.CreateOpen("req-unknown-1", "Config/Game.gamesettings"), 5000));
                Assert.That(exception.Code, Is.EqualTo("bridge.invalidMessage"));
            }
        }

        [Test]
        public void ClientReportsServerCloseAsDisconnected()
        {
            using (var server = BridgeTestServer.Start(Welcome(generation: 1)))
            using (var client = new VisualBridgeEditorBridgeClient(TestWindow(server.Port), "editor-1234", ""))
            {
                Assert.DoesNotThrow(() => client.Connect());
                server.CloseConnection();
                var exception = Assert.Throws<VisualBridgeIntegrationException>(() =>
                    client.SendRequest(VisualBridgeEditorBridgeValidator.CreateOpen("req-close-1", "Config/Game.gamesettings"), 5000));
                Assert.That(exception.Code, Is.EqualTo("bridge.disconnected"));
            }
        }

        [Test]
        public void OpenRequestRejectsEveryUnnormalizedDocumentPath()
        {
            var invalidPaths = new[]
            {
                "",
                "/Config/Game.gamesettings",
                "C:/Config/Game.gamesettings",
                "Config\\Game.gamesettings",
                "Config/../Game.gamesettings",
                "Config//Game.gamesettings",
                "Config/Game.gamesettings/",
                new string('a', 1025),
            };

            foreach (var documentPath in invalidPaths)
            {
                var value = new JObject
                {
                    ["type"] = "open",
                    ["requestId"] = "req-open-invalid",
                    ["documentPath"] = documentPath,
                };
                var exception = Assert.Throws<VisualBridgeIntegrationException>(
                    () => VisualBridgeEditorBridgeValidator.ValidateMessage(value),
                    $"documentPath '{documentPath}' must be rejected.");
                Assert.That(exception.Code, Is.EqualTo("bridge.invalidMessage"), $"documentPath '{documentPath}'");
                Assert.That(exception.JsonPath, Does.StartWith("$.documentPath"), $"documentPath '{documentPath}'");
            }

            // 合法路径：规范化、项目相对、正斜杠。
            Assert.DoesNotThrow(() => VisualBridgeEditorBridgeValidator.ValidateMessage(new JObject
            {
                ["type"] = "open",
                ["requestId"] = "req-open-valid",
                ["documentPath"] = "Config/Game.gamesettings",
            }));
        }

        [Test]
        public void RevealRequestRejectsUnsupportedReferenceValues()
        {
            // 附录 A.5：数字 reference 必须不越安全整数（2^53-1），与 TS 的 Number.isSafeInteger 对齐。
            var invalidReferences = new object[]
            {
                "", true, new JObject(), new JArray(), 1.5, null,
                9007199254740992L, -9007199254740992L, long.MaxValue, long.MinValue,
            };

            foreach (var reference in invalidReferences)
            {
                var value = new JObject
                {
                    ["type"] = "reveal",
                    ["requestId"] = "req-reveal-invalid",
                    ["reference"] = reference == null ? JValue.CreateNull() : JToken.FromObject(reference),
                };
                var exception = Assert.Throws<VisualBridgeIntegrationException>(
                    () => VisualBridgeEditorBridgeValidator.ValidateMessage(value),
                    $"reference '{reference ?? "<null>"}' must be rejected.");
                Assert.That(exception.Code, Is.EqualTo("bridge.invalidMessage"), $"reference '{reference ?? "<null>"}'");
                Assert.That(exception.JsonPath, Does.StartWith("$.reference"));
            }

            // 定位目标只接受非空字符串与整数（附录 A.5 的 referenceValue）。
            Assert.DoesNotThrow(() => VisualBridgeEditorBridgeValidator.ValidateMessage(new JObject
            {
                ["type"] = "reveal",
                ["requestId"] = "req-reveal-text",
                ["reference"] = "sample.unity.game.settings.default",
            }));
            var numeric = VisualBridgeEditorBridgeValidator.ValidateMessage(new JObject
            {
                ["type"] = "reveal",
                ["requestId"] = "req-reveal-number",
                ["reference"] = 101,
            });
            Assert.That(numeric.ReferenceIsNumber, Is.True);
            Assert.That(numeric.ReferenceValue, Is.EqualTo("101"));

            // 安全整数边界本身合法：2^53-1 必须通过，证明拒绝的是越界而不是所有大整数。
            var boundary = VisualBridgeEditorBridgeValidator.ValidateMessage(new JObject
            {
                ["type"] = "reveal",
                ["requestId"] = "req-reveal-boundary",
                ["reference"] = 9007199254740991L,
            });
            Assert.That(boundary.ReferenceIsNumber, Is.True);
            Assert.That(boundary.ReferenceValue, Is.EqualTo("9007199254740991"));
        }

        [Test]
        public void EditorResponseCarriesBothOutcomesAndOnlyRegisteredErrorCodes()
        {
            var ok = VisualBridgeEditorBridgeValidator.ValidateMessage(new JObject
            {
                ["type"] = "response",
                ["requestId"] = "req-ok",
                ["status"] = "ok",
            });
            Assert.That(ok.Type, Is.EqualTo(VisualBridgeBridgeMessageType.Response));
            Assert.That(ok.IsOk, Is.True);
            Assert.That(ok.RequestId, Is.EqualTo("req-ok"));

            // 资源不存在与"资源存在但无法定位/歧义"都是已登记的可读错误码。
            foreach (var code in new[] { "bridge.documentUnresolved", "bridge.documentAmbiguous" })
            {
                var failure = VisualBridgeEditorBridgeValidator.ValidateMessage(new JObject
                {
                    ["type"] = "response",
                    ["requestId"] = "req-error",
                    ["status"] = "error",
                    ["error"] = code,
                });
                Assert.That(failure.IsOk, Is.False);
                Assert.That(failure.ErrorCode, Is.EqualTo(code));
                // 应答必须能原样上线（序列化后再通过一次严格校验）。
                Assert.That(failure.ToJson()["status"].Value<string>(), Is.EqualTo("error"));
            }

            Assert.Throws<VisualBridgeIntegrationException>(() => VisualBridgeEditorBridgeValidator.ValidateMessage(new JObject
            {
                ["type"] = "response",
                ["requestId"] = "req-error",
                ["status"] = "error",
                ["error"] = "bridge.unregistered",
            }));
            Assert.Throws<VisualBridgeIntegrationException>(() => VisualBridgeEditorBridgeValidator.ValidateMessage(new JObject
            {
                ["type"] = "response",
                ["requestId"] = "req-error",
                ["status"] = "error",
            }));
            Assert.Throws<VisualBridgeIntegrationException>(() => VisualBridgeEditorBridgeValidator.ValidateMessage(new JObject
            {
                ["type"] = "response",
                ["requestId"] = "req-error",
                ["status"] = "maybe",
            }));
            Assert.Throws<VisualBridgeIntegrationException>(() => VisualBridgeEditorBridgeValidator.ValidateMessage(new JObject
            {
                ["type"] = "response",
                ["status"] = "ok",
            }));

            // 附录 A.5：ok 分支不携带 error（schema 的 ok 分支 additionalProperties:false）。
            foreach (var errorValue in new JToken[] { "bridge.documentUnresolved", JValue.CreateNull() })
            {
                var exception = Assert.Throws<VisualBridgeIntegrationException>(
                    () => VisualBridgeEditorBridgeValidator.ValidateMessage(new JObject
                    {
                        ["type"] = "response",
                        ["requestId"] = "req-ok",
                        ["status"] = "ok",
                        ["error"] = errorValue,
                    }));
                Assert.That(exception.Code, Is.EqualTo("bridge.unknownProperty"));
                Assert.That(exception.JsonPath, Is.EqualTo("$.error"));
            }
        }

        [Test]
        public void ClientSurfacesServerRequestErrorInsteadOfWaitingForTheTimeout()
        {
            using (var server = BridgeTestServer.Start(Welcome(generation: 1)))
            using (var client = new VisualBridgeEditorBridgeClient(TestWindow(server.Port, generation: 1), "editor-1234", ""))
            {
                Assert.DoesNotThrow(() => client.Connect());
                server.QueueResponse("{\"type\":\"response\",\"requestId\":\"req-missing-1\",\"status\":\"error\",\"error\":\"bridge.documentUnresolved\"}");

                var stopwatch = Stopwatch.StartNew();
                var response = client.SendRequest(
                    VisualBridgeEditorBridgeValidator.CreateOpen("req-missing-1", "Config/DoesNotExist.gamesettings"),
                    5000);
                stopwatch.Stop();

                Assert.That(response.IsOk, Is.False, "A missing document must come back as an error response.");
                Assert.That(response.ErrorCode, Is.EqualTo("bridge.documentUnresolved"), "The error code must stay readable.");
                Assert.That(stopwatch.ElapsedMilliseconds, Is.LessThan(2000), "The error must not degrade into a silent timeout.");
                Assert.That(client.State, Is.EqualTo(VisualBridgeBridgeConnectionState.Connected), "A request-level error must not drop the connection.");
            }
        }

        [Test]
        public void ClientIgnoresDebugChannelFramesWhileWaitingForTheEditorResponse()
        {
            using (var server = BridgeTestServer.Start(Welcome(generation: 1)))
            using (var client = new VisualBridgeEditorBridgeClient(TestWindow(server.Port, generation: 1), "editor-1234", ""))
            {
                Assert.DoesNotThrow(() => client.Connect());
                // 同一 requestId 在通道 1 上是调试查询的应答（附录 A.2/A.5）：
                // 通道位不同就不属于编辑器请求空间，客户端不得把它当作本次请求的应答。
                server.QueueDebugFrame("{\"type\":\"response\",\"requestId\":\"req-shared-1\",\"status\":\"ok\"}");
                server.QueueResponse("{\"type\":\"response\",\"requestId\":\"req-shared-1\",\"status\":\"error\",\"error\":\"bridge.documentUnresolved\"}");

                var response = client.SendRequest(
                    VisualBridgeEditorBridgeValidator.CreateOpen("req-shared-1", "Config/Game.gamesettings"),
                    5000);

                Assert.That(response.ErrorCode, Is.EqualTo("bridge.documentUnresolved"),
                    "The editor response must come from channel 0, never from a channel 1 debug response.");
                Assert.That(server.GetReceivedRequests().Length, Is.EqualTo(1));
            }
        }

        [Test]
        public void SessionStateRestoresTheSameSessionIdAfterADomainReload()
        {
            VisualBridgeSessionState.Clear();
            try
            {
                var persisted = VisualBridgeSessionState.Empty
                    .WithConnection(SessionId, "D:/Temp/visualbridge-bridge/window.json", true);
                persisted.Save();

                // Domain Reload 后托管字段全部丢失，只剩 SessionState。
                var restored = VisualBridgeSessionState.Load();
                Assert.That(restored.SessionId, Is.EqualTo(SessionId));
                Assert.That(restored.RecordPath, Is.EqualTo("D:/Temp/visualbridge-bridge/window.json"));
                Assert.That(restored.DebugEnabled, Is.True);
                Assert.That(restored.HasSession, Is.True);

                VisualBridgeSessionState.Clear();
                Assert.That(VisualBridgeSessionState.Load().HasSession, Is.False);
                Assert.That(VisualBridgeSessionState.Load().SessionId, Is.Empty);
            }
            finally
            {
                VisualBridgeSessionState.Clear();
            }
        }

        [Test]
        public void SessionStateMigratesThePreUnificationResumeKey()
        {
            VisualBridgeSessionState.Clear();
            try
            {
                SessionState.SetString("VisualBridge.EditorBridge.ResumeSessionId", SessionId);
                Assert.That(VisualBridgeSessionState.Load().SessionId, Is.EqualTo(SessionId),
                    "An editor that reloads during the upgrade must keep its session.");

                VisualBridgeSessionState.Load().Save();
                Assert.That(SessionState.GetString("VisualBridge.EditorBridge.ResumeSessionId", string.Empty), Is.Empty,
                    "Saving must not leave a second session identity source behind.");
            }
            finally
            {
                VisualBridgeSessionState.Clear();
            }
        }

        [Test]
        public void ServiceResumesTheRememberedSessionOnReconnect()
        {
            VisualBridgeSessionState.Clear();
            using (var firstServer = BridgeTestServer.Start(Welcome(generation: 1)))
            using (var secondServer = BridgeTestServer.Start(Welcome(generation: 2, resumed: true)))
            {
                try
                {
                    var service = VisualBridgeEditorBridgeService.Instance;
                    service.Disconnect();

                    var firstWindow = TestWindow(firstServer.Port, generation: 1);
                    service.Connect(firstWindow);
                    Assert.That(service.Session.SessionId, Is.EqualTo(SessionId),
                        "The connected session identity must be persisted for the next connect.");

                    var firstHello = (JObject)JToken.Parse(firstServer.ReceivedHello);
                    Assert.That(firstHello.Property("resumeSessionId"), Is.Null, "A fresh editor session must not resume.");

                    service.Disconnect();
                    // 模拟 Domain Reload：只有 SessionState 里的会话身份存活。
                    Assert.That(VisualBridgeSessionState.Load().SessionId, Is.EqualTo(SessionId));

                    var secondWindow = TestWindow(secondServer.Port, generation: 2);
                    var client = service.Connect(secondWindow);
                    Assert.That(client.Resumed, Is.True);

                    var secondHello = (JObject)JToken.Parse(secondServer.ReceivedHello);
                    Assert.That(secondHello["resumeSessionId"].Value<string>(), Is.EqualTo(SessionId),
                        "A reconnect must resume the same sessionId.");
                    Assert.That(service.Session.DebugEnabled, Is.True);
                }
                finally
                {
                    VisualBridgeEditorBridgeService.Instance.Disconnect();
                    VisualBridgeSessionState.Clear();
                }
            }
        }

        [Test]
        public void AutoConnectPolicyBacksOffThreeTimesThenGivesUp()
        {
            // 策略只负责决策；"清空会话"发生在连接器的 GiveUp 分支（VisualBridgeEditorBridgeAutoConnect.TryOnce），
            // 因此这里断言 GiveUp 本身，以及清空后（hasSession=false）连接器不再重试。
            var none = VisualBridgeAutoConnectPolicy.Decide(hasSession: true, isConnected: false, liveWindowCount: 0, failedAttempts: 0);
            Assert.That(none.Action, Is.EqualTo(VisualBridgeAutoConnectAction.Retry));
            Assert.That(none.DelayMilliseconds, Is.EqualTo(1000), "First retry waits 1 s.");

            var second = VisualBridgeAutoConnectPolicy.Decide(hasSession: true, isConnected: false, liveWindowCount: 0, failedAttempts: 1);
            Assert.That(second.DelayMilliseconds, Is.EqualTo(2000), "Second retry waits 2 s.");

            var third = VisualBridgeAutoConnectPolicy.Decide(hasSession: true, isConnected: false, liveWindowCount: 0, failedAttempts: 2);
            Assert.That(third.DelayMilliseconds, Is.EqualTo(4000), "Third retry waits 4 s.");

            var exhausted = VisualBridgeAutoConnectPolicy.Decide(hasSession: true, isConnected: false, liveWindowCount: 0, failedAttempts: 3);
            Assert.That(exhausted.Action, Is.EqualTo(VisualBridgeAutoConnectAction.GiveUp),
                "After 1 s / 2 s / 4 s the switch gives up instead of retrying forever.");

            Assert.That(
                VisualBridgeAutoConnectPolicy.Decide(hasSession: false, isConnected: false, liveWindowCount: 1, failedAttempts: 0).Action,
                Is.EqualTo(VisualBridgeAutoConnectAction.Skip),
                "Once the connector cleared the session, there is nothing left to retry.");

            var live = VisualBridgeAutoConnectPolicy.Decide(hasSession: true, isConnected: false, liveWindowCount: 1, failedAttempts: 0);
            Assert.That(live.Action, Is.EqualTo(VisualBridgeAutoConnectAction.Connect));

            Assert.That(
                VisualBridgeAutoConnectPolicy.Decide(hasSession: false, isConnected: false, liveWindowCount: 1, failedAttempts: 0).Action,
                Is.EqualTo(VisualBridgeAutoConnectAction.Skip), "No session means nothing to resume.");
            Assert.That(
                VisualBridgeAutoConnectPolicy.Decide(hasSession: true, isConnected: true, liveWindowCount: 1, failedAttempts: 0).Action,
                Is.EqualTo(VisualBridgeAutoConnectAction.Skip), "An established connection is never replaced.");
        }

        [Test]
        public void AutoConnectDialsTheRememberedWindowAndCarriesResumeSessionId()
        {
            // P0（评审清单）：reload 后的续接必须由 SessionState 恢复，而不是重新生成 bootId/sessionId。
            VisualBridgeSessionState.Clear();
            var directory = CreateDiscoveryDirectory();
            var previousOverride = VisualBridgeEditorBridgeAutoConnect.DiscoveryDirectoryOverride;
            var previousFlag = Environment.GetEnvironmentVariable("VISUALBRIDGE_BRIDGE_AUTOCONNECT");
            using (var server = BridgeTestServer.Start(Welcome(generation: 2, resumed: true)))
            {
                try
                {
                    var recordPath = WriteRecord(
                        directory,
                        "live.json",
                        pid: Process.GetCurrentProcess().Id,
                        projectRoot: GetAuthoringRoot(),
                        tcpPort: server.Port,
                        generation: 2);
                    VisualBridgeEditorBridgeAutoConnect.DiscoveryDirectoryOverride = directory;
                    VisualBridgeSessionState.Empty.WithConnection(SessionId, recordPath, connectedDebugEnabled: false).Save();
                    Environment.SetEnvironmentVariable("VISUALBRIDGE_BRIDGE_AUTOCONNECT", "1");

                    VisualBridgeEditorBridgeAutoConnect.Start("test");

                    var service = VisualBridgeEditorBridgeService.Instance;
                    Assert.That(service.IsConnected, Is.True, "Auto-connect must dial the remembered window after a reload.");
                    var hello = (JObject)JToken.Parse(server.ReceivedHello);
                    Assert.That(hello["resumeSessionId"]?.Value<string>(), Is.EqualTo(SessionId),
                        "The reconnecting hello must carry the SessionState sessionId (never a freshly generated one).");
                    Assert.That(service.Client.Resumed, Is.True);
                    Assert.That(VisualBridgeEditorBridgeAutoConnect.IsReconnecting, Is.False,
                        "A successful reconnect stops the backoff loop.");
                }
                finally
                {
                    VisualBridgeEditorBridgeAutoConnect.Stop();
                    VisualBridgeEditorBridgeService.Instance.Disconnect();
                    VisualBridgeSessionState.Clear();
                    Environment.SetEnvironmentVariable("VISUALBRIDGE_BRIDGE_AUTOCONNECT", previousFlag);
                    VisualBridgeEditorBridgeAutoConnect.DiscoveryDirectoryOverride = previousOverride;
                    Directory.Delete(directory, true);
                }
            }
        }

        [Test]
        public void SessionStateExpiresTheReconnectGraceAndRoundTripsLastSeen()
        {
            // 假时钟：14.9 s / 15.1 s 边界只移动 now，不真等 15 秒。
            VisualBridgeSessionState.Clear();
            var connectedAt = new DateTime(2026, 10, 27, 12, 0, 0, DateTimeKind.Utc);
            try
            {
                Assert.That(VisualBridgeSessionState.ReconnectGraceMs, Is.EqualTo(15000));
                var state = VisualBridgeSessionState.Empty
                    .WithConnection(SessionId, "/tmp/window.json", connectedDebugEnabled: true, utcNow: connectedAt);
                state.Save();

                var restored = VisualBridgeSessionState.Load();
                Assert.That(restored.HasSession, Is.True);
                Assert.That(restored.LastSeenUtc, Is.EqualTo(connectedAt), "lastSeenUtc must round-trip as ISO 8601.");

                Assert.That(restored.IsReconnectGraceExpired(connectedAt.AddMilliseconds(14900)), Is.False,
                    "14.9 s is inside the 15 s reconnect grace.");
                Assert.That(restored.IsReconnectGraceExpired(connectedAt.AddMilliseconds(15100)), Is.True,
                    "15.1 s is past the 15 s reconnect grace.");
            }
            finally
            {
                VisualBridgeSessionState.Clear();
            }
        }

        [Test]
        public void EditorBridgeWindowReportsConnectingResumedAndNewSessionStates()
        {
            Assert.That(
                VisualBridgeEditorBridgeWindow.DescribeStatus(reconnecting: true, failedAttempts: 0, connected: false, resumed: false),
                Is.EqualTo("Connecting to VS Code… (attempt 1)"));
            Assert.That(
                VisualBridgeEditorBridgeWindow.DescribeStatus(reconnecting: false, failedAttempts: 0, connected: true, resumed: true),
                Is.EqualTo("Reconnected (session resumed)."));
            Assert.That(
                VisualBridgeEditorBridgeWindow.DescribeStatus(reconnecting: false, failedAttempts: 0, connected: true, resumed: false),
                Is.EqualTo("Connected (new session)."));
        }

        [Test]
        public void DiscoveryFiltersStaleHeartbeatAndDeadPidRecords()
        {
            if (Environment.OSVersion.Platform != PlatformID.Win32NT)
            {
                Assert.Ignore("Dead-pid coverage spawns cmd.exe and is Windows-specific.");
            }

            var directory = CreateDiscoveryDirectory();
            try
            {
                WriteRecord(directory, "live.json", pid: Process.GetCurrentProcess().Id);
                WriteRecord(directory, "stale.json", pid: Process.GetCurrentProcess().Id, heartbeatAge: TimeSpan.FromMinutes(5));
                WriteRecord(directory, "dead.json", pid: SpawnExitedProcessId());

                var windows = VisualBridgeEditorBridgeDiscovery.EnumerateWindows(null, directory);
                Assert.That(windows.Count, Is.EqualTo(1));
                Assert.That(windows[0].WindowId, Is.EqualTo("1b3121ab-2646-4e0f-a789-e970d4fbca8f"));

                var staleException = Assert.Throws<VisualBridgeIntegrationException>(
                    () => VisualBridgeEditorBridgeDiscovery.LoadRecord(Path.Combine(directory, "stale.json")));
                Assert.That(staleException.Code, Is.EqualTo("bridge.staleRecord"));

                var deadException = Assert.Throws<VisualBridgeIntegrationException>(
                    () => VisualBridgeEditorBridgeDiscovery.LoadRecord(Path.Combine(directory, "dead.json")));
                Assert.That(deadException.Code, Is.EqualTo("bridge.staleRecord"));
            }
            finally
            {
                Directory.Delete(directory, true);
            }
        }

        [Test]
        public void ServiceReportsNoEndpointWhenEveryDiscoveryRecordIsStale()
        {
            var directory = CreateDiscoveryDirectory();
            try
            {
                WriteRecord(directory, "stale.json", pid: Process.GetCurrentProcess().Id, heartbeatAge: TimeSpan.FromMinutes(5));
                var exception = Assert.Throws<VisualBridgeIntegrationException>(() =>
                    VisualBridgeEditorBridgeService.Instance.OpenDocumentWithRetry(
                        "Config/Game.gamesettings",
                        VisualBridgeEditorBridgeService.UnityProjectRoot(),
                        totalTimeoutMs: 50,
                        discoveryDirectory: directory));
                Assert.That(exception.Code, Is.EqualTo("runtime.noEndpoint"));
            }
            finally
            {
                Directory.Delete(directory, true);
            }
        }

        [Test]
        public void ServiceRequiresExplicitSelectionWhenMultipleWindowsMatch()
        {
            var directory = CreateDiscoveryDirectory();
            try
            {
                var authoringRoot = GetAuthoringRoot();
                WriteRecord(directory, "a.json", pid: Process.GetCurrentProcess().Id, projectRoot: authoringRoot, windowId: "1b3121ab-2646-4e0f-a789-e970d4fbca8f");
                WriteRecord(directory, "b.json", pid: Process.GetCurrentProcess().Id, projectRoot: authoringRoot, windowId: "6f9619ff-8b86-4d01-b42d-00cf4fc964ff");

                var windows = VisualBridgeEditorBridgeService.Instance.FindWindows(VisualBridgeEditorBridgeService.UnityProjectRoot(), directory);
                Assert.That(windows.Count, Is.EqualTo(2));

                var exception = Assert.Throws<VisualBridgeIntegrationException>(() =>
                    VisualBridgeEditorBridgeService.Instance.OpenDocumentWithRetry(
                        "Config/Game.gamesettings",
                        VisualBridgeEditorBridgeService.UnityProjectRoot(),
                        1500,
                        null,
                        directory));
                Assert.That(exception.Code, Is.EqualTo("bridge.windowAmbiguous"));
            }
            finally
            {
                Directory.Delete(directory, true);
            }
        }

        [Test]
        public void ServiceRoutesOnlyWindowsServingTheAuthoringProject()
        {
            var directory = CreateDiscoveryDirectory();
            try
            {
                var authoringRoot = GetAuthoringRoot();
                WriteRecord(directory, "match.json", pid: Process.GetCurrentProcess().Id, projectRoot: authoringRoot);
                WriteRecord(directory, "other.json", pid: Process.GetCurrentProcess().Id, projectRoot: "D:/Somewhere/Else");

                var windows = VisualBridgeEditorBridgeService.Instance.FindWindows(VisualBridgeEditorBridgeService.UnityProjectRoot(), directory);
                Assert.That(windows.Count, Is.EqualTo(1));
                Assert.That(windows[0].ProjectRoots[0], Is.EqualTo(VisualBridgeEditorBridgeDiscovery.NormalizePath(authoringRoot)));
            }
            finally
            {
                Directory.Delete(directory, true);
            }
        }

        private static JObject ParseWithoutDateCoercion(string text)
        {
            using (var stringReader = new StringReader(text))
            using (var reader = new Newtonsoft.Json.JsonTextReader(stringReader))
            {
                reader.DateParseHandling = Newtonsoft.Json.DateParseHandling.None;
                reader.FloatParseHandling = Newtonsoft.Json.FloatParseHandling.Decimal;
                return JObject.Load(reader);
            }
        }

        private static string GetAuthoringRoot()
        {
            var profile = VisualBridgeIntegrationProfileLoader.Load(VisualBridgeEditorBridgeService.UnityProjectRoot());
            return Path.GetDirectoryName(profile.AuthoringProjectPath);
        }

        private static VisualBridgeBridgeWindow TestWindow(int tcpPort, int generation = 1)
        {
            return new VisualBridgeBridgeWindow
            {
                WindowId = "6f9619ff-8b86-4d01-b42d-00cf4fc964ff",
                ProtocolVersion = 4,
                Role = "vscode",
                ProjectRoots = new[] { "D:/Authoring" },
                TcpPort = tcpPort,
                Token = ValidToken,
                Pid = Process.GetCurrentProcess().Id,
                Generation = generation,
                RecordPath = null,
            };
        }

        private static string Welcome(
            int generation = 1,
            string contractHash = "",
            string payloads = "[\"json\",\"binary\"]",
            bool resumed = false,
            bool debugEnabled = true)
        {
            return "{\"type\":\"welcome\",\"protocolVersion\":4,\"endpointId\":\"6f9619ff-8b86-4d01-b42d-00cf4fc964ff\","
                + "\"sessionId\":\"" + SessionId + "\",\"resumed\":" + (resumed ? "true" : "false") + ",\"connectType\":\"editor\","
                + "\"generation\":" + generation + ",\"bootId\":\"boot-1\",\"contractHash\":\"" + contractHash + "\","
                + "\"payloads\":" + payloads + ",\"debugEnabled\":" + (debugEnabled ? "true" : "false")
                + ",\"startedAt\":\"2026-10-26T12:00:00.000Z\"}";
        }

        private static string CreateDiscoveryDirectory()
        {
            var directory = Path.Combine(Path.GetTempPath(), "visualbridge-bridge-tests-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(directory);
            return directory;
        }

        private static string WriteRecord(string directory, string fileName, int pid, TimeSpan? heartbeatAge = null, string projectRoot = "D:/Authoring", string windowId = "1b3121ab-2646-4e0f-a789-e970d4fbca8f", int tcpPort = 8226, int generation = 1)
        {
            var path = Path.Combine(directory, fileName);
            File.WriteAllText(path, "{\"formatVersion\":2,\"protocolVersion\":4,\"role\":\"vscode\",\"tcpPort\":" + tcpPort + ",\"token\":\""
                + ValidToken + "\",\"pid\":" + pid + ",\"generation\":" + generation + ",\"windowId\":\"" + windowId
                + "\",\"projectRoots\":[\"" + projectRoot.Replace('\\', '/') + "\"]}");
            if (heartbeatAge.HasValue)
            {
                File.SetLastWriteTimeUtc(path, DateTime.UtcNow - heartbeatAge.Value);
            }

            return path;
        }

        private static int SpawnExitedProcessId()
        {
            var startInfo = new ProcessStartInfo("cmd.exe", "/c exit")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            var process = Process.Start(startInfo);
            process.WaitForExit();
            return process.Id;
        }

        /// <summary>
        /// 监听 127.0.0.1 随机端口的最小服务端 TCP 对等体：用统一协议的 6 字节帧
        /// 应答 hello 握手、记录收到的每个请求，并在每个请求后回放排队的响应帧。
        /// 编辑器通道只使用控制通道（JSON）。
        /// </summary>
        private sealed class BridgeTestServer : IDisposable
        {
            private readonly TcpListener listener;
            private readonly Thread thread;
            private readonly string replyToHello;
            private readonly string thenSend;
            private readonly object gate = new object();
            private readonly object sendGate = new object();
            private readonly Queue<string> pending = new Queue<string>();
            private readonly Queue<string> pendingDebug = new Queue<string>();
            private readonly System.Collections.Concurrent.ConcurrentQueue<string> received = new System.Collections.Concurrent.ConcurrentQueue<string>();
            private readonly System.Collections.Concurrent.ConcurrentQueue<(string Line, VisualBridge.Runtime.VisualBridgeChannel Channel, VisualBridge.Runtime.VisualBridgePayloadKind PayloadKind)> receivedFrames =
                new System.Collections.Concurrent.ConcurrentQueue<(string Line, VisualBridge.Runtime.VisualBridgeChannel Channel, VisualBridge.Runtime.VisualBridgePayloadKind PayloadKind)>();
            private readonly VisualBridge.Runtime.VisualBridgeFrameReader frameReader =
                new VisualBridge.Runtime.VisualBridgeFrameReader();
            private TcpClient client;
            private NetworkStream stream;
            private string helloLine;

            private BridgeTestServer(string replyToHello, string thenSend)
            {
                this.replyToHello = replyToHello;
                this.thenSend = thenSend;
                listener = new TcpListener(IPAddress.Loopback, 0);
                listener.Start();
                thread = new Thread(Run) { IsBackground = true };
                thread.Start();
            }

            public static BridgeTestServer Start(string replyToHello, string thenSend = null)
            {
                return new BridgeTestServer(replyToHello, thenSend);
            }

            public int Port => ((IPEndPoint)listener.LocalEndpoint).Port;

            /// <summary>握手 hello 的原始 JSON（在应答 welcome 之前记录）。</summary>
            public string ReceivedHello => helloLine;

            public string[] GetReceivedRequests()
            {
                return received.ToArray();
            }

            /// <summary>收到的每一帧（含被请求队列忽略的通道），用于断言 pong 的通道与载荷种类。</summary>
            public (string Line, VisualBridge.Runtime.VisualBridgeChannel Channel, VisualBridge.Runtime.VisualBridgePayloadKind PayloadKind)[] GetReceivedFrames()
            {
                return receivedFrames.ToArray();
            }

            public void QueueResponse(string line)
            {
                lock (gate)
                {
                    pending.Enqueue(line);
                }
            }

            /// <summary>在下一个请求的应答之前插入一条通道 1 帧（模拟调试数据面）。</summary>
            public void QueueDebugFrame(string line)
            {
                lock (gate)
                {
                    pendingDebug.Enqueue(line);
                }
            }

            public void CloseConnection()
            {
                TcpClient connected;
                lock (gate)
                {
                    connected = client;
                }

                connected?.Close();
            }

            /// <summary>
            /// 不等请求、立刻推一条通道 0 消息给客户端（模拟服务端空闲时主动发 <c>debugSetEnabled</c>）。
            /// 返回是否写成功。
            /// </summary>
            public bool Push(string line, int waitForStreamMs = 2000)
            {
                var deadline = DateTime.UtcNow.AddMilliseconds(waitForStreamMs);
                while (stream == null && DateTime.UtcNow < deadline)
                {
                    Thread.Sleep(5);
                }

                lock (sendGate)
                {
                    if (stream == null)
                    {
                        return false;
                    }

                    Send(line);
                    return true;
                }
            }

            private void Run()
            {
                try
                {
                    client = listener.AcceptTcpClient();
                    stream = client.GetStream();
                    // 先消费 hello 握手再应答 welcome，与服务端协议行为一致。
                    helloLine = Receive();
                    Send(replyToHello);
                    if (thenSend != null)
                    {
                        Send(thenSend);
                    }

                    while (client.Connected)
                    {
                        var line = Receive();
                        if (line == null)
                        {
                            break;
                        }

                        received.Enqueue(line);
                        lock (gate)
                        {
                            // 先回放通道 1 的调试帧，再回放通道 0 的编辑器应答：
                            // 客户端必须只认后者（附录 A.2/A.5 的 requestId 空间隔离）。
                            while (pendingDebug.Count > 0)
                            {
                                Send(pendingDebug.Dequeue(), VisualBridge.Runtime.VisualBridgeChannel.Debug);
                            }

                            while (pending.Count > 0)
                            {
                                Send(pending.Dequeue());
                            }
                        }
                    }
                }
                catch (IOException)
                {
                    // 客户端已断开。
                }
                catch (SocketException)
                {
                    // 客户端已断开。
                }
                catch (ObjectDisposedException)
                {
                    // 服务端已释放。
                }
            }

            private void Send(
                string line,
                VisualBridge.Runtime.VisualBridgeChannel channel = VisualBridge.Runtime.VisualBridgeChannel.Editor)
            {
                var frame = VisualBridge.Runtime.VisualBridgeFraming.EncodeFrame(
                    channel,
                    VisualBridge.Runtime.VisualBridgePayloadKind.Json,
                    Encoding.UTF8.GetBytes(line));
                lock (sendGate)
                {
                    stream.Write(frame, 0, frame.Length);
                    stream.Flush();
                }
            }

            private string Receive()
            {
                var buffer = new byte[4096];
                while (true)
                {
                    while (frameReader.TryReadFrame(out var frame))
                    {
                        var line = Encoding.UTF8.GetString(frame.Payload);
                        receivedFrames.Enqueue((line, frame.Channel, frame.PayloadKind));
                        if (frame.Channel != VisualBridge.Runtime.VisualBridgeChannel.Editor)
                        {
                            continue;
                        }

                        return line;
                    }

                    var read = stream.Read(buffer, 0, buffer.Length);
                    if (read == 0)
                    {
                        frameReader.DiscardPending();
                        return null;
                    }

                    frameReader.Append(buffer, 0, read);
                }
            }

            public void Dispose()
            {
                try
                {
                    client?.Close();
                }
                catch (SocketException)
                {
                    // 已关闭。
                }

                listener.Stop();
                thread.Join(1000);
            }
        }

        /// <summary>P2-1 用的调试连接：只记录出站控制消息（不触发入站事件）。</summary>
        private sealed class DebugFakeWire : IVisualBridgeDebugWire
        {
            public bool IsOpen => true;

            public long Generation => 1L;

            public long OverflowDroppedMessages => 0L;

            public List<byte[]> Controls { get; } = new List<byte[]>();

            public event Action<VisualBridgePayloadKind, byte[]> FrameReceived
            {
                add { }
                remove { }
            }

            public event Action Closed
            {
                add { }
                remove { }
            }

            public event Action Tick
            {
                add { }
                remove { }
            }

            public bool SendControl(byte[] payload, VisualBridgeDebugPayloadFormat format)
            {
                Controls.Add(payload);
                return true;
            }

            public bool SendDebug(byte[] payload, VisualBridgeDebugPayloadFormat format)
            {
                return true;
            }
        }
    }
}
