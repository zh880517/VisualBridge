using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityEditor;
using UnityEngine;
using VisualBridge.Diagnostics;
using VisualBridge.Diagnostics.Bridge;

namespace VisualBridge.Editor.Tests
{
    public sealed class VisualBridgeRuntimeBridgeTests
    {
        private static readonly string ValidToken = new string('a', 48);
        private static readonly string OtherToken = new string('b', 48);
        private static readonly string ClientInstanceId = "1b3121ab-2646-4e0f-a789-e970d4fbca8f";
        private static readonly string ClientInstanceIdB = "3d5343cd-4868-402b-ab0b-92f6cdec9012";
        private static readonly System.Text.RegularExpressions.Regex Sha256Pattern =
            new System.Text.RegularExpressions.Regex("^[a-f0-9]{64}$");

        [Test]
        public void RuntimeSchemaAndValidatorShareParityFixture()
        {
            var fixtureAsset = AssetDatabase.LoadAssetAtPath<TextAsset>(
                "Packages/com.kyle.visualbridge/Tests/Fixtures/visualbridge-runtime-bridge-cases.json");
            Assert.That(fixtureAsset, Is.Not.Null);
            var root = ParseWithoutDateCoercion(fixtureAsset.text);
            var cases = (JArray)root["cases"];
            // 40 = E5/F2 既有 38 条 + 2 条反向守卫（旧能力值、旧事件名 ⇒ 都必须被拒绝）。
            // 两条守卫都显式保留字面量；零命中验收对 fixture 路径做精确豁免，命中清单必须入报告。
            Assert.That(cases.Count, Is.EqualTo(40));
            foreach (var testCase in cases.Cast<JObject>())
            {
                var value = testCase["value"] as JObject;
                var label = testCase.Value<string>("label");
                Assert.That(value, Is.Not.Null, label);
                var line = value.ToString(Newtonsoft.Json.Formatting.None);
                if (testCase.Value<string>("target") == "discoveryRecord")
                {
                    if (testCase.Value<bool>("valid"))
                    {
                        Assert.DoesNotThrow(
                            () => VisualBridge.Runtime.VisualBridgeRuntimeBridgeValidator.ParseDiscoveryRecord(line), label);
                    }
                    else
                    {
                        var exception = Assert.Throws<VisualBridge.Runtime.VisualBridgeRuntimeBridgeException>(
                            () => VisualBridge.Runtime.VisualBridgeRuntimeBridgeValidator.ParseDiscoveryRecord(line), label);
                        Assert.That(exception.Code, Is.EqualTo(testCase.Value<string>("loaderCode")), label);
                    }
                }
                else
                {
                    if (testCase.Value<bool>("valid"))
                    {
                        Assert.DoesNotThrow(
                            () => VisualBridge.Runtime.VisualBridgeRuntimeBridgeValidator.ParseMessage(line), label);
                    }
                    else
                    {
                        var exception = Assert.Throws<VisualBridge.Runtime.VisualBridgeRuntimeBridgeException>(
                            () => VisualBridge.Runtime.VisualBridgeRuntimeBridgeValidator.ParseMessage(line), label);
                        Assert.That(exception.Code, Is.EqualTo(testCase.Value<string>("loaderCode")), label);
                    }
                }
            }
        }

        [Test]
        public void RuntimeServerHandshakesAndServesFilteredSnapshot()
        {
            var artifactsRoot = CreateTempArtifactsRoot();
            try
            {
                using (var server = StartServer(artifactsRoot, "editor-41001", generation: 3))
                using (var client = RuntimeBridgeTestClient.Connect(server.TcpPort))
                {
                    client.Send(HelloLine(ValidToken));
                    var welcome = client.ReadMessage();
                    Assert.That(welcome.Type, Is.EqualTo(VisualBridge.Runtime.VisualBridgeRuntimeBridgeMessageType.Welcome));
                    Assert.That(welcome.EndpointId, Is.EqualTo("editor-41001"));
                    Assert.That(welcome.ConnectType, Is.EqualTo("editor-player"));
                    Assert.That(welcome.Generation, Is.EqualTo(3));
                    Assert.That(welcome.ProtocolVersion, Is.EqualTo(4));
                    // 会话身份：sessionId = endpointId#bootId，首次握手不算续接。
                    Assert.That(welcome.SessionId, Is.EqualTo(server.SessionId));
                    Assert.That(welcome.BootId, Is.EqualTo(server.BootId));
                    Assert.That(welcome.Resumed, Is.False);
                    Assert.That(welcome.ContractHash, Is.Empty);
                    Assert.That(welcome.Payloads, Is.EquivalentTo(new[] { "json" }));
                    Assert.That(welcome.StartedAt, Is.Not.Null.And.Not.Empty);

                    client.Send(RequestLine("req-1", null));
                    var response = client.ReadMessage();
                    Assert.That(response.Type, Is.EqualTo(VisualBridge.Runtime.VisualBridgeRuntimeBridgeMessageType.Response));
                    Assert.That(response.IsOk, Is.True);
                    Assert.That(response.RequestId, Is.EqualTo("req-1"));
                    Assert.That(response.Documents.Count, Is.EqualTo(2));
                    var structured = response.Documents.Single(d => d.DocumentTypeId == "sample.test.settings");
                    Assert.That(structured.DocumentId, Is.EqualTo("sample.test.settings.default"));
                    Assert.That(structured.Kind, Is.EqualTo("visualbridge.structured.compiled"));
                    Assert.That((string)structured.Data["formatVersion"], Is.Not.Null);
                    var entity = response.Documents.Single(d => d.DocumentTypeId == "sample.test.hero");
                    Assert.That(entity.Kind, Is.EqualTo("visualbridge.entity.compiled"));

                    client.Send(RequestLine("req-2", new[] { "sample.test.hero" }));
                    var filtered = client.ReadMessage();
                    Assert.That(filtered.IsOk, Is.True);
                    Assert.That(filtered.Documents.Count, Is.EqualTo(1));
                    Assert.That(filtered.Documents[0].DocumentTypeId, Is.EqualTo("sample.test.hero"));
                }
            }
            finally
            {
                Directory.Delete(artifactsRoot, true);
            }
        }

        /// <summary>
        /// E10 P0 的会话级验收（**真实装配**）：A 握手 → 临时连接 B 压栈 → B 关闭。
        /// 走 <see cref="VisualBridgeRuntimeBridgeHost.InstallDebugTransport"/> 与 server 的
        /// <c>DebugLinkOpened</c>，因此「wire 适配器先订阅 link.Closed、宿主后读 IsConnected」这个
        /// 载重前提被真实覆盖：把宿主改回「无条件 Detach」，本用例必红。
        /// </summary>
        [Test]
        public void ClosingATemporaryRuntimeLinkKeepsTheSessionAttachedAndTheRestoredLinkReceivesFrames()
        {
            var artifactsRoot = CreateTempArtifactsRoot();
            try
            {
                using (var server = StartServer(artifactsRoot, "editor-41011", generation: 7))
                {
                    VisualBridgeRuntimeBridgeHost.InstallDebugTransport(server);
                    var transport = VisualBridgeRuntimeBridgeHost.InstalledDebugTransport;
                    Assert.That(transport, Is.Not.Null, "InstallDebugTransport must publish the transport it installed.");

                    using (var first = RuntimeBridgeTestClient.Connect(server.TcpPort))
                    {
                        first.Send(HelloLine(ValidToken));
                        Assert.That(first.ReadMessage().Type,
                            Is.EqualTo(VisualBridge.Runtime.VisualBridgeRuntimeBridgeMessageType.Welcome));
                        Assert.That(WaitUntil(() => VisualBridgeDebugSession.IsAttachedAndConnected, TimeSpan.FromSeconds(5)),
                            Is.True, "the first link did not attach the debug session.");
                        Assert.That(VisualBridgeDebug.Create("host-restore-a", "graph", "R", string.Empty), Is.True);
                        Assert.That(
                            first.TryReadChannelJson(
                                VisualBridge.Runtime.VisualBridgeChannel.Debug,
                                TimeSpan.FromSeconds(5),
                                "host-restore-a"),
                            Is.Not.Null, "the first link must be the active wire and receive ch1 messages.");

                        using (var temporary = RuntimeBridgeTestClient.Connect(server.TcpPort))
                        {
                            temporary.Send(HelloLine(ValidToken, ClientInstanceIdB));
                            Assert.That(temporary.ReadMessage().Type,
                                Is.EqualTo(VisualBridge.Runtime.VisualBridgeRuntimeBridgeMessageType.Welcome));
                            // 正控：ch1 只走活动 wire。B 收到新的 debugCreate 才说明它确实压栈成了活动连接，
                            // 而不是只完成了一次握手。
                            Assert.That(VisualBridgeDebug.Create("host-restore-b", "graph", "R", string.Empty), Is.True);
                            Assert.That(
                                temporary.TryReadChannelJson(
                                    VisualBridge.Runtime.VisualBridgeChannel.Debug,
                                    TimeSpan.FromSeconds(5),
                                    "host-restore-b"),
                                Is.Not.Null, "the temporary link never became the active wire (no ch1 traffic).");
                        }

                        // 临时连接已关闭：不靠固定睡眠，轮询可观察状态——在 A 上 Create 一个探针实例，
                        // 只有 A 已经是活动 wire 时才能从 A 的 ch1 读回；读回即"出栈恢复"已完成。
                        // B 的 socket 关闭到传输层出栈之间，IsConnected 仍看得到 A（F9 §1 的"任一绑定存活"），
                        // 所以这段轮询主要是等"出栈恢复"完成，而不是等连接态翻面。
                        string restored = null;
                        var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(10);
                        int probe = 0;
                        while (restored == null && DateTime.UtcNow < deadline)
                        {
                            if (!VisualBridgeDebugSession.IsAttachedAndConnected)
                            {
                                Thread.Sleep(20);
                                continue;
                            }

                            probe++;
                            var probeId = "host-restore-a2-" + probe;
                            VisualBridgeDebug.Create(probeId, "graph", "R", string.Empty);
                            restored = first.TryReadChannelJson(
                                VisualBridge.Runtime.VisualBridgeChannel.Debug,
                                TimeSpan.FromMilliseconds(250),
                                probeId);
                        }

                        Assert.That(VisualBridgeDebugSession.IsAttachedAndConnected, Is.True,
                            $"临时连接断开后会话被 Detach：弹回的 A 收不到帧，面板会「已连接却无帧」。"
                            + $"（probes={probe}, transportConnected={transport.IsConnected}, "
                            + $"generation={transport.ConnectionGeneration}, restored={restored != null}）");
                        Assert.That(restored, Is.Not.Null, "恢复后的 A 必须重新收到新消息。");
                        Assert.That(transport.IsConnected, Is.True, "the restored link must still be connected.");
                    }
                }
            }
            finally
            {
                VisualBridgeRuntimeBridgeHost.RemoveDebugTransport();
                VisualBridgeDebug.SetEncoder(null);
                Directory.Delete(artifactsRoot, true);
            }
        }

        /// <summary>
        /// 旧传输层迟到的 <c>link.Closed</c> 不得 Detach 当前会话（E10）：身份校验是"防误伤新会话"的
        /// 唯一防线，必须有直接用例——用一个**未安装**的 transport 调结算函数，会话必须保持挂接。
        /// **本用例不覆盖原子性**：它只是在单线程里顺序调用，把 <c>OnDebugLinkClosed</c> 里的
        /// <c>lock (debugTransportGate)</c> 删掉仍然通过——TOCTOU 窗口是"身份比较"与"Detach"之间的两条指令，
        /// 单线程测试无法可靠插入第三方线程，EditMode 里也没有可控的挂起点（这里不引入测试专用断点钩子：
        /// 钩子跑在同一线程上，锁可重入，等于把并发伪装成串行，反而给出假证据）。替代证据是结构性约束：
        /// 身份比较与 Detach 同在一把私有锁内，安装/卸载也取同一把锁，锁序固定 debugTransportGate → 会话 Gate，
        /// 且安装/卸载在锁外调用 debug bridge（不会反向持锁）——由代码评审与 <c>debugTransportGate</c> 的
        /// 所有使用点共同背书（不写具体处数：它随重构变化，写死会过期）。
        /// 判别力边界：本用例也**不能**区分"删掉 <c>IsConnected</c> 守卫"（former transport 连身份都不匹配），
        /// 那半个矩阵由 <see cref="ClosingTheInstalledTransportWithNoLiveLinkDetachesTheSession"/>（必须 Detach）
        /// 与 <see cref="ClosingATemporaryRuntimeLinkKeepsTheSessionAttachedAndTheRestoredLinkReceivesFrames"/>
        /// （必须不 Detach）覆盖。
        /// </summary>
        [Test]
        public void ClosingALinkOfAFormerTransportDoesNotDetachTheCurrentSession()
        {
            var artifactsRoot = CreateTempArtifactsRoot();
            try
            {
                using (var server = StartServer(artifactsRoot, "editor-41013", generation: 2))
                {
                    VisualBridgeRuntimeBridgeHost.InstallDebugTransport(server);
                    using (var link = RuntimeBridgeTestClient.Connect(server.TcpPort))
                    {
                        link.Send(HelloLine(ValidToken));
                        Assert.That(link.ReadMessage().Type,
                            Is.EqualTo(VisualBridge.Runtime.VisualBridgeRuntimeBridgeMessageType.Welcome));
                        Assert.That(WaitUntil(() => VisualBridgeDebugSession.IsAttachedAndConnected, TimeSpan.FromSeconds(5)),
                            Is.True, "the current link did not attach the debug session.");

                        // 另一个 transport（不是当前装配的那个）：栈里没有连接 ⇒ IsConnected == false，
                        // 与"server 重启后旧连接迟到关闭"的形状一致。
                        using (var former = new VisualBridgeDebugTransport(
                                   VisualBridge.Diagnostics.ConnectType.EditorPlayer))
                        {
                            Assert.That(former.IsConnected, Is.False);
                            VisualBridgeRuntimeBridgeHost.OnDebugLinkClosed(former);
                        }

                        Assert.That(VisualBridgeDebugSession.IsAttachedAndConnected, Is.True,
                            "别的传输层关闭不能 Detach 当前会话（否则面板会「已连接却无帧」）");

                        // 正控：当前会话仍然可用——Create 能从当前连接读回。
                        Assert.That(VisualBridgeDebug.Create("former-transport-probe", "graph", "R", string.Empty),
                            Is.True);
                        Assert.That(
                            link.TryReadChannelJson(
                                VisualBridge.Runtime.VisualBridgeChannel.Debug,
                                TimeSpan.FromSeconds(5),
                                "former-transport-probe"),
                            Is.Not.Null, "the current session must still deliver ch1 messages after the stale close.");
                    }
                }
            }
            finally
            {
                VisualBridgeRuntimeBridgeHost.RemoveDebugTransport();
                VisualBridgeDebug.SetEncoder(null);
                Directory.Delete(artifactsRoot, true);
            }
        }

        /// <summary>
        /// F9 §2：安装期的发布窗口。`DebugLinkOpened` 一旦注册，随时可能有一条连接"开→关"；
        /// 此刻当前传输必须**已经发布**，否则 <see cref="VisualBridgeRuntimeBridgeHost.OnDebugLinkClosed"/>
        /// 会把这次关闭当成陈旧传输忽略。
        /// 本用例只断言与生产相关的不变量，不模拟关闭（关闭→Detach 由
        /// <see cref="ClosingTheInstalledTransportWithNoLiveLinkDetachesTheSession"/> 在真实安装路径上覆盖）：
        /// ① 探针位置的字段已发布。探针在 `+=` **之后**、`Install` 之前，因此证据的边界只是
        ///    "**注册完成后、`Install` 之前**字段已发布"：HEAD 的回归顺序是 注册 → Install → 发布，
        ///    探针在这里读到 null ⇒ 红。
        ///    若把发布挪到 `+=` 与探针之间，本用例仍会绿——**但那种顺序不构成缺陷**：`Install` 之前
        ///    不会有 link 到达（握手要等 Play 会话真正建立），且此时会话还没拿到 transport
        ///    （`s_transport` 为 null，handler 里的 `Attach()` 是空操作、`OnDebugLinkClosed` 也无从触发）；
        ///    所以这里不再收紧，改名到与证据一致的粒度。
        /// ② <c>InstallDebugTransport</c> 返回之后会话必须真的挂接：这是"生产路径确实装了会话"的判别点。
        ///    探针**不能**替生产做这件事——旧写法在探针里调 Install，删掉生产那次 Install 用例仍全绿。
        /// 另：`probeRan` 断言防"探针被静默摘除"——删掉探针调用时 ① 会随断言一起消失，本用例必须变红。
        /// 本用例依赖隔离的静态会话态（前置 `IsAttached` 为 false）：若将来并行跑 EditMode，需要先确认这一点。
        /// </summary>
        [Test]
        public void TheInstallPublishingWindowPublishesTheTransportBeforeInstallingTheSession()
        {
            var artifactsRoot = CreateTempArtifactsRoot();
            try
            {
                using (var server = StartServer(artifactsRoot, "editor-41015", generation: 4))
                {
                    var probeRan = false;
                    VisualBridgeRuntimeBridgeHost.InstallDebugTransport(server, transport =>
                    {
                        probeRan = true;
                        // 窗口位置：DebugLinkOpened 已注册、Install 还没走到。HEAD 顺序下这里是 null。
                        Assert.That(VisualBridgeRuntimeBridgeHost.InstalledDebugTransport, Is.SameAs(transport),
                            "注册 DebugLinkOpened 之后当前传输必须已经发布（F9 §2）");
                    });

                    Assert.That(probeRan, Is.True,
                        "安装探针必须被调用（F9 §2）：删掉探针调用会让字段发布断言静默消失");
                    // 兜底：探针的 SameAs 通过后这条恒真，不构成独立判别，只是防"字段从未发布"。
                    Assert.That(VisualBridgeRuntimeBridgeHost.InstalledDebugTransport, Is.Not.Null);
                    // 探针不 Install（它只观察发布顺序）：这条断言证明生产路径自己把会话装上了。
                    Assert.That(VisualBridgeDebugSession.IsAttached, Is.True,
                        "InstallDebugTransport 返回后会话必须已挂接（生产路径真的 Install 了会话）");
                }
            }
            finally
            {
                VisualBridgeRuntimeBridgeHost.RemoveDebugTransport();
                VisualBridgeDebug.SetEncoder(null);
                Directory.Delete(artifactsRoot, true);
            }
        }

        /// <summary>
        /// F9 §3：**当前**已安装的 transport、<c>IsConnected == false</c> ⇒ 必须 Detach。
        /// 原用例（former transport）被身份校验短路，区分不了"删掉 IsConnected 守卫"；本用例补第二个守卫的
        /// 另一半判别力：当前 transport 但栈里没有存活连接时必须结算成断连（A.9），不能被"曾经连过"拖住。
        /// 红态（把守卫写成 <c>if (!transport.IsConnected) return;</c>，即"还有存活连接"判断反了）：
        /// 这次关闭被忽略，IsAttached 仍为 true。
        /// </summary>
        [Test]
        public void ClosingTheInstalledTransportWithNoLiveLinkDetachesTheSession()
        {
            var artifactsRoot = CreateTempArtifactsRoot();
            try
            {
                using (var server = StartServer(artifactsRoot, "editor-41016", generation: 2))
                {
                    VisualBridgeRuntimeBridgeHost.InstallDebugTransport(server);
                    var transport = VisualBridgeRuntimeBridgeHost.InstalledDebugTransport;
                    Assert.That(transport, Is.Not.Null);
                    Assert.That(transport.IsConnected, Is.False, "前置：没有任何连接 ⇒ 传输层未连接");

                    // 形状："连接建立过（会话已挂接），传输层里已经没有存活连接，关闭结算还没到"。
                    VisualBridgeDebugBridge.Attach();
                    Assert.That(VisualBridgeDebugSession.IsAttached, Is.True);
                    Assert.That(VisualBridgeDebugSession.IsAttachedAndConnected, Is.False,
                        "已挂接但无连接：这正是原用例覆盖不到的形态");

                    VisualBridgeRuntimeBridgeHost.OnDebugLinkClosed(transport);

                    Assert.That(VisualBridgeDebugSession.IsAttached, Is.False,
                        "当前 transport 且无存活连接 ⇒ 必须 Detach（A.9）");
                }
            }
            finally
            {
                VisualBridgeRuntimeBridgeHost.RemoveDebugTransport();
                VisualBridgeDebug.SetEncoder(null);
                Directory.Delete(artifactsRoot, true);
            }
        }

        /// <summary>
        /// A.9 的会话级验收：最后一条连接关闭 ⇒ 传输层断连 + 会话 Detach 并重置（槽位/代次作废）。
        /// transport 层只断言了 <c>IsConnected</c>/代次；这里补会话状态这一层。
        /// </summary>
        [Test]
        public void ClosingTheOnlyRuntimeLinkDetachesAndResetsTheSession()
        {
            var artifactsRoot = CreateTempArtifactsRoot();
            try
            {
                using (var server = StartServer(artifactsRoot, "editor-41012", generation: 3))
                {
                    VisualBridgeRuntimeBridgeHost.InstallDebugTransport(server);
                    var transport = VisualBridgeRuntimeBridgeHost.InstalledDebugTransport;
                    Assert.That(transport, Is.Not.Null);

                    using (var only = RuntimeBridgeTestClient.Connect(server.TcpPort))
                    {
                        only.Send(HelloLine(ValidToken));
                        Assert.That(only.ReadMessage().Type,
                            Is.EqualTo(VisualBridge.Runtime.VisualBridgeRuntimeBridgeMessageType.Welcome));
                        Assert.That(WaitUntil(() => VisualBridgeDebugSession.IsAttachedAndConnected, TimeSpan.FromSeconds(5)),
                            Is.True, "the only link did not attach the debug session.");
                        Assert.That(VisualBridgeDebug.Create("host-close-a", "graph", "R", string.Empty), Is.True);
                        Assert.That(
                            only.TryReadChannelJson(
                                VisualBridge.Runtime.VisualBridgeChannel.Debug,
                                TimeSpan.FromSeconds(5),
                                "host-close-a"),
                            Is.Not.Null, "the only link must be the active wire.");
                    }

                    // 等「连接观察 + 出栈重置」都落定：IsOpen 会在 Closed 回调之前就变 false，
                    // 只等 IsConnected 会读到栈里还没弹掉的 wire（代次仍是旧值）。
                    Assert.That(
                        WaitUntil(
                            () => !transport.IsConnected && transport.ConnectionGeneration == 0L,
                            TimeSpan.FromSeconds(10)),
                        Is.True,
                        "the transport did not observe the last link closing and reset (generation 0).");
                    Assert.That(WaitUntil(() => !VisualBridgeDebugSession.IsAttachedAndConnected, TimeSpan.FromSeconds(10)),
                        Is.True, "the last link closing must Detach the session (A.9).");
                    Assert.That(transport.TryAdmitEvent(1, "host-close-a", "graph", methodId: 10), Is.False,
                        "the slot table must be empty after the session reset.");
                }
            }
            finally
            {
                VisualBridgeRuntimeBridgeHost.RemoveDebugTransport();
                VisualBridgeDebug.SetEncoder(null);
                Directory.Delete(artifactsRoot, true);
            }
        }

        [Test]
        public void RuntimeServerAnswersUnknownActionWithResponseError()
        {
            var artifactsRoot = CreateTempArtifactsRoot();
            try
            {
                using (var server = StartServer(artifactsRoot, "editor-41002"))
                using (var client = RuntimeBridgeTestClient.Connect(server.TcpPort))
                {
                    client.Send(HelloLine(ValidToken));
                    Assert.That(client.ReadMessage().Type, Is.EqualTo(VisualBridge.Runtime.VisualBridgeRuntimeBridgeMessageType.Welcome));

                    // 未知 action 是请求级错误：response error，连接保持。
                    client.Send("{\"type\":\"request\",\"requestId\":\"req-bad\",\"action\":\"setBreakpoint\"}");
                    var error = client.ReadMessage();
                    Assert.That(error.Type, Is.EqualTo(VisualBridge.Runtime.VisualBridgeRuntimeBridgeMessageType.Response));
                    Assert.That(error.IsOk, Is.False);
                    Assert.That(error.RequestId, Is.EqualTo("req-bad"));
                    Assert.That(error.ErrorCode, Is.EqualTo("runtime.unknownRequest"));

                    client.Send(RequestLine("req-after", null));
                    var followUp = client.ReadMessage();
                    Assert.That(followUp.IsOk, Is.True);
                }
            }
            finally
            {
                Directory.Delete(artifactsRoot, true);
            }
        }

        [Test]
        public void RuntimeServerRejectsInvalidTokenAndDisconnects()
        {
            var artifactsRoot = CreateTempArtifactsRoot();
            try
            {
                using (var server = StartServer(artifactsRoot, "editor-41003"))
                using (var client = RuntimeBridgeTestClient.Connect(server.TcpPort))
                {
                    client.Send(HelloLine(OtherToken));
                    var error = client.ReadMessage();
                    Assert.That(error.Type, Is.EqualTo(VisualBridge.Runtime.VisualBridgeRuntimeBridgeMessageType.Error));
                    Assert.That(error.ErrorCode, Is.EqualTo("runtime.invalidToken"));
                    Assert.That(client.IsDisconnected(), Is.True);
                }
            }
            finally
            {
                Directory.Delete(artifactsRoot, true);
            }
        }

        [Test]
        public void RuntimeServerResumesOnlyMatchingSessionId()
        {
            var artifactsRoot = CreateTempArtifactsRoot();
            try
            {
                using (var server = StartServer(artifactsRoot, "editor-41010"))
                using (var client = RuntimeBridgeTestClient.Connect(server.TcpPort))
                {
                    // 同一会话身份再来一次：必须判 resumed，且 sessionId/bootId 不变。
                    client.Send(HelloLine(ValidToken, null, server.SessionId));
                    var resumed = client.ReadMessage();
                    Assert.That(resumed.Type, Is.EqualTo(VisualBridge.Runtime.VisualBridgeRuntimeBridgeMessageType.Welcome));
                    Assert.That(resumed.Resumed, Is.True);
                    Assert.That(resumed.SessionId, Is.EqualTo(server.SessionId));
                    Assert.That(resumed.BootId, Is.EqualTo(server.BootId));
                }

                using (var server = StartServer(artifactsRoot, "editor-41011"))
                using (var client = RuntimeBridgeTestClient.Connect(server.TcpPort))
                {
                    // 伪造的 resumeSessionId 不得被当成续接（否则会复用陌生会话）。
                    client.Send(HelloLine(ValidToken, null, "player-1#bogus"));
                    var welcome = client.ReadMessage();
                    Assert.That(welcome.Type, Is.EqualTo(VisualBridge.Runtime.VisualBridgeRuntimeBridgeMessageType.Welcome));
                    Assert.That(welcome.Resumed, Is.False);
                    Assert.That(welcome.SessionId, Is.EqualTo(server.SessionId));
                }
            }
            finally
            {
                Directory.Delete(artifactsRoot, true);
            }
        }

        [Test]
        public void RuntimeServerExpiresTheReconnectGraceAndRotatesTheSession()
        {
            // 假时钟：14.9 s / 15.1 s 边界不真等 15 秒，注入 Func<DateTime> 即可。
            var artifactsRoot = CreateTempArtifactsRoot();
            var now = new DateTime(2026, 10, 27, 12, 0, 0, DateTimeKind.Utc);
            try
            {
                // 14.9 s：仍在宽限内 → resumed=true，sessionId/bootId 不变。
                using (var server = new VisualBridge.Runtime.VisualBridgeRuntimeBridgeServer(
                    "editor-43001", "editor-play", 0, ValidToken, artifactsRoot, 1, null, false, 0, 0, null, () => now))
                {
                    var sessionBefore = server.SessionId;
                    var bootBefore = server.BootId;
                    ConnectAndWaitForDisconnect(server, ValidToken);
                    now += TimeSpan.FromMilliseconds(14900);

                    using (var client = RuntimeBridgeTestClient.Connect(server.TcpPort))
                    {
                        client.Send(HelloLine(ValidToken, null, sessionBefore));
                        var welcome = client.ReadMessage();
                        Assert.That(welcome.Type, Is.EqualTo(VisualBridge.Runtime.VisualBridgeRuntimeBridgeMessageType.Welcome));
                        Assert.That(welcome.Resumed, Is.True, "14.9 s is inside the 15 s reconnect grace.");
                        Assert.That(welcome.SessionId, Is.EqualTo(sessionBefore), "The sessionId must not change inside the grace.");
                        Assert.That(welcome.BootId, Is.EqualTo(bootBefore));
                        Assert.That(server.SessionId, Is.EqualTo(sessionBefore));
                    }
                }

                // 15.1 s：超过宽限 → resumed=false，且换发新的 sessionId（新旧不等）。
                now = new DateTime(2026, 10, 27, 12, 0, 0, DateTimeKind.Utc);
                using (var server = new VisualBridge.Runtime.VisualBridgeRuntimeBridgeServer(
                    "editor-43002", "editor-play", 0, ValidToken, artifactsRoot, 1, null, false, 0, 0, null, () => now))
                {
                    var sessionBefore = server.SessionId;
                    ConnectAndWaitForDisconnect(server, ValidToken);
                    now += TimeSpan.FromMilliseconds(15100);

                    using (var client = RuntimeBridgeTestClient.Connect(server.TcpPort))
                    {
                        client.Send(HelloLine(ValidToken, null, sessionBefore));
                        var welcome = client.ReadMessage();
                        Assert.That(welcome.Type, Is.EqualTo(VisualBridge.Runtime.VisualBridgeRuntimeBridgeMessageType.Welcome));
                        Assert.That(welcome.Resumed, Is.False, "15.1 s is past the 15 s reconnect grace.");
                        Assert.That(welcome.SessionId, Is.Not.EqualTo(sessionBefore), "An expired grace must issue a new sessionId.");
                        Assert.That(welcome.SessionId, Is.EqualTo(server.SessionId));
                    }
                }
            }
            finally
            {
                Directory.Delete(artifactsRoot, true);
            }
        }

        /// <summary>连一条、握手、断开，并等到服务端真的观察到断开（宽限起点就绪）。</summary>
        private static void ConnectAndWaitForDisconnect(
            VisualBridge.Runtime.VisualBridgeRuntimeBridgeServer server, string token)
        {
            using (var client = RuntimeBridgeTestClient.Connect(server.TcpPort))
            {
                client.Send(HelloLine(token));
                Assert.That(client.ReadMessage().Type, Is.EqualTo(VisualBridge.Runtime.VisualBridgeRuntimeBridgeMessageType.Welcome));
            }

            var deadline = DateTime.UtcNow.AddSeconds(5);
            while (DateTime.UtcNow < deadline
                && (server.HandshakenConnectionCount != 0 || !server.LastDisconnectedAtUtc.HasValue))
            {
                Thread.Sleep(10);
            }

            Assert.That(server.HandshakenConnectionCount, Is.EqualTo(0), "The server must see the disconnect.");
            Assert.That(server.LastDisconnectedAtUtc, Is.Not.Null, "The grace must start from the observed disconnect.");
        }

        [Test]
        public void RuntimeServerReturnsAnExplicitErrorForAnOversizedResponse()
        {
            var artifactsRoot = CreateTempArtifactsRoot();
            try
            {
                // 一份超过 MaxMessageBytes（1 MB）的合法产物：响应装不下时不得静默丢弃，
                // 否则客户端会一直等到请求超时（F6）。
                WriteArtifact(
                    artifactsRoot,
                    "manifest.json",
                    "documents/p1/sample.test.big/sample.test.big.default.vbcompiled.json",
                    "visualbridge.structured.compiled",
                    "sample.test.big",
                    "sample.test.big.default",
                    "Config/big.gamesettings",
                    new string('4', 64),
                    new string('x', 1_200_000));

                using (var server = StartServer(artifactsRoot, "editor-43003"))
                using (var client = RuntimeBridgeTestClient.Connect(server.TcpPort))
                {
                    client.Send(HelloLine(ValidToken));
                    Assert.That(client.ReadMessage().Type, Is.EqualTo(VisualBridge.Runtime.VisualBridgeRuntimeBridgeMessageType.Welcome));

                    client.Send(RequestLine("req-big", null));
                    var response = client.ReadMessage();
                    Assert.That(response.IsOk, Is.False, "An oversized response must be answered with an explicit error.");
                    Assert.That(response.ErrorCode, Is.EqualTo("runtime.internalError"));
                    Assert.That(response.ErrorDetail, Does.Contain("MaxMessageBytes"));

                    // 错误是请求级的：连接必须还能继续服务下一条请求（不是靠超时才发现断了）。
                    client.Send(LeaseRequestLine("req-lease-after", "acquireLease"));
                    var lease = client.ReadMessage();
                    Assert.That(lease.IsOk, Is.True, "The connection must stay usable after an oversized response error.");
                }
            }
            finally
            {
                Directory.Delete(artifactsRoot, true);
            }
        }

        [Test]
        public void RuntimeServerPlayerAcceptsHelloWithoutToken()
        {
            var artifactsRoot = CreateTempArtifactsRoot();
            try
            {
                // Player 无认证（附录 E.3）：记录 token 为空，hello 不带 token 也必须接受。
                using (var server = new VisualBridge.Runtime.VisualBridgeRuntimeBridgeServer(
                    "player-41012", "player", 0, null, artifactsRoot, 1))
                using (var client = RuntimeBridgeTestClient.Connect(server.TcpPort))
                {
                    client.Send(HelloLine(null));
                    var welcome = client.ReadMessage();
                    Assert.That(welcome.Type, Is.EqualTo(VisualBridge.Runtime.VisualBridgeRuntimeBridgeMessageType.Welcome));
                    Assert.That(welcome.ConnectType, Is.EqualTo("player"));
                    Assert.That(welcome.EndpointId, Is.EqualTo("player-41012"));
                }
            }
            finally
            {
                Directory.Delete(artifactsRoot, true);
            }
        }

        [Test]
        public void PlayerBootstrapStartsAnUnauthenticatedListenerAndInstallsThePump()
        {
            // 只能证明"Player 引导这条代码路径"在进程内可运行：真正的 Player 构建 E2E
            // 不在本任务验证范围内（报告里如实说明）。
            var artifactsRoot = CreateTempArtifactsRoot();
            var listeners = ReservePortBlock(1, out var firstPort);
            var previousRange = Environment.GetEnvironmentVariable(
                VisualBridgeRuntimeBridgePlayerBootstrap.PortRangeEnvironmentVariable);
            var previousAutoListen = Environment.GetEnvironmentVariable(
                VisualBridgeRuntimeBridgePlayerBootstrap.AutoListenEnvironmentVariable);
            try
            {
                listeners[0].Stop();
                Environment.SetEnvironmentVariable(
                    VisualBridgeRuntimeBridgePlayerBootstrap.PortRangeEnvironmentVariable, $"{firstPort}-{firstPort}");
                Environment.SetEnvironmentVariable(
                    VisualBridgeRuntimeBridgePlayerBootstrap.AutoListenEnvironmentVariable, "1");

                VisualBridgeRuntimeBridgePlayerBootstrap.ResolvePortRange(out var rangeStart, out var rangeEnd);
                Assert.That(rangeStart, Is.EqualTo(firstPort));
                Assert.That(rangeEnd, Is.EqualTo(firstPort));
                Assert.That(VisualBridgeRuntimeBridgePlayerBootstrap.AutoListenInPlayer, Is.True);

                Assert.That(
                    VisualBridgeRuntimeBridgePlayerBootstrap.TryStart(0, out var detail, artifactsRoot),
                    Is.True,
                    detail);
                var server = VisualBridgeRuntimeBridgePlayerBootstrap.CurrentServer;
                Assert.That(server, Is.Not.Null);
                Assert.That(server.InstanceId, Does.StartWith(VisualBridgeRuntimeBridgePlayerBootstrap.InstancePrefix));
                Assert.That(server.Token, Is.Empty, "The player leg is unauthenticated (Appendix E.3).");
                Assert.That(server.SessionId, Does.StartWith(server.InstanceId + "#"));
                Assert.That(server.TcpPort, Is.EqualTo(firstPort));
                Assert.That(VisualBridgeDebugQueryPump.IsPlayerLoopInstalled, Is.True,
                    "The player bootstrap must install the debug query pump.");

                // 无 token 的 hello 必须被接受，connectType 为 player。
                using (var client = RuntimeBridgeTestClient.Connect(server.TcpPort))
                {
                    client.Send(HelloLine(null));
                    var welcome = client.ReadMessage();
                    Assert.That(welcome.Type, Is.EqualTo(VisualBridge.Runtime.VisualBridgeRuntimeBridgeMessageType.Welcome));
                    Assert.That(welcome.ConnectType, Is.EqualTo("player"));
                }
            }
            finally
            {
                VisualBridgeRuntimeBridgePlayerBootstrap.Stop();
                Environment.SetEnvironmentVariable(
                    VisualBridgeRuntimeBridgePlayerBootstrap.PortRangeEnvironmentVariable, previousRange);
                Environment.SetEnvironmentVariable(
                    VisualBridgeRuntimeBridgePlayerBootstrap.AutoListenEnvironmentVariable, previousAutoListen);
                foreach (var listener in listeners)
                {
                    listener.Stop();
                }

                Directory.Delete(artifactsRoot, true);
            }
        }

        [Test]
        public void PlayerBootstrapHonoursTheAutoListenSwitchAndRejectsInvalidPortRanges()
        {
            var previousRange = Environment.GetEnvironmentVariable(
                VisualBridgeRuntimeBridgePlayerBootstrap.PortRangeEnvironmentVariable);
            var previousAutoListen = Environment.GetEnvironmentVariable(
                VisualBridgeRuntimeBridgePlayerBootstrap.AutoListenEnvironmentVariable);
            try
            {
                Environment.SetEnvironmentVariable(
                    VisualBridgeRuntimeBridgePlayerBootstrap.AutoListenEnvironmentVariable, "0");
                Assert.That(VisualBridgeRuntimeBridgePlayerBootstrap.AutoListenInPlayer, Is.False,
                    "VISUALBRIDGE_RUNTIME_AUTO_LISTEN=0 must disable the player listener.");

                Environment.SetEnvironmentVariable(
                    VisualBridgeRuntimeBridgePlayerBootstrap.AutoListenEnvironmentVariable, null);
                Assert.That(VisualBridgeRuntimeBridgePlayerBootstrap.AutoListenInPlayer, Is.True,
                    "AutoListenInPlayer defaults to on (Appendix A.8).");

                Environment.SetEnvironmentVariable(
                    VisualBridgeRuntimeBridgePlayerBootstrap.PortRangeEnvironmentVariable, "not-a-range");
                VisualBridgeRuntimeBridgePlayerBootstrap.ResolvePortRange(out var rangeStart, out var rangeEnd);
                Assert.That(rangeStart, Is.EqualTo(VisualBridgeRuntimeBridgePlayerBootstrap.DefaultPortRangeStart));
                Assert.That(rangeEnd, Is.EqualTo(VisualBridgeRuntimeBridgePlayerBootstrap.DefaultPortRangeEnd));
            }
            finally
            {
                Environment.SetEnvironmentVariable(
                    VisualBridgeRuntimeBridgePlayerBootstrap.PortRangeEnvironmentVariable, previousRange);
                Environment.SetEnvironmentVariable(
                    VisualBridgeRuntimeBridgePlayerBootstrap.AutoListenEnvironmentVariable, previousAutoListen);
            }
        }

        [Test]
        public void RuntimeServerPicksFirstFreePortInRange()
        {
            var artifactsRoot = CreateTempArtifactsRoot();
            var listeners = ReservePortBlock(3, out var firstPort);
            try
            {
                // 故意空出中间一个端口：范围扫描必须按序选它，而不是跳到随机端口。
                listeners[1].Stop();
                using (var server = new VisualBridge.Runtime.VisualBridgeRuntimeBridgeServer(
                    "player-41013", "player", 0, null, artifactsRoot, 1, null, false, firstPort, firstPort + 2))
                {
                    Assert.That(server.TcpPort, Is.EqualTo(firstPort + 1));
                    Assert.That(server.ListenAddress, Is.EqualTo(IPAddress.Loopback));
                }
            }
            finally
            {
                foreach (var listener in listeners)
                {
                    listener.Stop();
                }

                Directory.Delete(artifactsRoot, true);
            }
        }

        [Test]
        public void RuntimeServerFailsWhenPortRangeIsExhausted()
        {
            var artifactsRoot = CreateTempArtifactsRoot();
            var listeners = ReservePortBlock(2, out var firstPort);
            try
            {
                var exception = Assert.Throws<InvalidOperationException>(() =>
                {
                    // 整段被占用：必须显式失败并停止，而不是无限重试或悄悄换端口。
                    using (new VisualBridge.Runtime.VisualBridgeRuntimeBridgeServer(
                        "player-41014", "player", 0, null, artifactsRoot, 1, null, false, firstPort, firstPort + 1))
                    {
                    }
                });
                Assert.That(exception.Message, Does.Contain("No free runtime bridge port"));
            }
            finally
            {
                foreach (var listener in listeners)
                {
                    listener.Stop();
                }

                Directory.Delete(artifactsRoot, true);
            }
        }

        [Test]
        public void RuntimeServerBindsAllInterfacesForPlayerMode()
        {
            var artifactsRoot = CreateTempArtifactsRoot();
            var listeners = ReservePortBlock(1, out var firstPort);
            try
            {
                listeners[0].Stop();
                using (var server = new VisualBridge.Runtime.VisualBridgeRuntimeBridgeServer(
                    "player-41015", "player", 0, null, artifactsRoot, 1, null, true, firstPort, firstPort + 1))
                {
                    // Player：BindAllInterfaces（附录 A.8）——监听 0.0.0.0 而不是回环。
                    Assert.That(server.ListenAddress, Is.EqualTo(IPAddress.Any));
                    Assert.That(server.TcpPort, Is.EqualTo(firstPort));
                }
            }
            finally
            {
                foreach (var listener in listeners)
                {
                    listener.Stop();
                }

                Directory.Delete(artifactsRoot, true);
            }
        }

        /// <summary>占用一段连续回环端口；返回的监听器由调用方决定哪些保留、哪些释放。</summary>
        private static List<TcpListener> ReservePortBlock(int count, out int firstPort)
        {
            for (var candidate = 31000; candidate < 33000; candidate++)
            {
                var listeners = new List<TcpListener>(count);
                try
                {
                    for (var offset = 0; offset < count; offset++)
                    {
                        var listener = new TcpListener(IPAddress.Loopback, candidate + offset);
                        listener.Start();
                        listeners.Add(listener);
                    }

                    firstPort = candidate;
                    return listeners;
                }
                catch (SocketException)
                {
                    foreach (var listener in listeners)
                    {
                        listener.Stop();
                    }
                }
            }

            throw new InvalidOperationException("No free contiguous loopback port block found.");
        }

        [Test]
        public void RuntimeServerRejectsInvalidJsonLine()
        {
            var artifactsRoot = CreateTempArtifactsRoot();
            try
            {
                using (var server = StartServer(artifactsRoot, "editor-41004"))
                using (var client = RuntimeBridgeTestClient.Connect(server.TcpPort))
                {
                    client.Send("{not json");
                    var error = client.ReadMessage();
                    Assert.That(error.ErrorCode, Is.EqualTo("runtime.invalidJson"));
                    Assert.That(client.IsDisconnected(), Is.True);
                }
            }
            finally
            {
                Directory.Delete(artifactsRoot, true);
            }
        }

        [Test]
        public void RuntimeServerRejectsNonHelloFirstMessage()
        {
            var artifactsRoot = CreateTempArtifactsRoot();
            try
            {
                using (var server = StartServer(artifactsRoot, "editor-41005"))
                using (var client = RuntimeBridgeTestClient.Connect(server.TcpPort))
                {
                    client.Send(RequestLine("req-first", null));
                    var error = client.ReadMessage();
                    Assert.That(error.ErrorCode, Is.EqualTo("runtime.unknownMessageType"));
                    Assert.That(client.IsDisconnected(), Is.True);
                }
            }
            finally
            {
                Directory.Delete(artifactsRoot, true);
            }
        }

        [Test]
        public void RuntimeServerRejectsProtocolVersionMismatch()
        {
            var artifactsRoot = CreateTempArtifactsRoot();
            try
            {
                using (var server = StartServer(artifactsRoot, "editor-41006"))
                using (var client = RuntimeBridgeTestClient.Connect(server.TcpPort))
                {
                    client.Send(
                        "{\"type\":\"hello\",\"protocolVersion\":2,\"role\":\"vscode\",\"clientEndpointId\":\""
                        + ClientInstanceId + "\",\"contractHash\":\"\",\"payloads\":[\"json\"],\"token\":\""
                        + ValidToken + "\"}");
                    var error = client.ReadMessage();
                    Assert.That(error.ErrorCode, Is.EqualTo("runtime.protocolVersionMismatch"));
                    Assert.That(client.IsDisconnected(), Is.True);
                }
            }
            finally
            {
                Directory.Delete(artifactsRoot, true);
            }
        }

        [Test]
        public void RuntimeServerRejectsASecondPlayerClientAndKeepsTheFirst()
        {
            // Player 腿监听 0.0.0.0 且无认证（附录 E.3）：同一时刻只接纳一条连接，
            // 第二条回 runtime.alreadyConnected 后断开，第一条必须原样保留。
            var artifactsRoot = CreateTempArtifactsRoot();
            try
            {
                using (var server = new VisualBridge.Runtime.VisualBridgeRuntimeBridgeServer(
                    "player-41007", "player", 0, null, artifactsRoot, 1))
                using (var first = RuntimeBridgeTestClient.Connect(server.TcpPort))
                {
                    first.Send(HelloLine(null, ClientInstanceId));
                    var welcome = first.ReadMessage();
                    Assert.That(welcome.Type, Is.EqualTo(VisualBridge.Runtime.VisualBridgeRuntimeBridgeMessageType.Welcome));
                    Assert.That(welcome.SessionId, Is.EqualTo(server.SessionId));

                    using (var second = RuntimeBridgeTestClient.Connect(server.TcpPort))
                    {
                        second.Send(HelloLine(null, ClientInstanceIdB));
                        var rejected = second.ReadMessage();
                        Assert.That(rejected.Type, Is.EqualTo(VisualBridge.Runtime.VisualBridgeRuntimeBridgeMessageType.Error));
                        Assert.That(rejected.ErrorCode, Is.EqualTo("runtime.alreadyConnected"));
                        Assert.That(second.IsDisconnected(), Is.True, "The rejected connection must be closed.");
                        Assert.That(server.HandshakenConnectionCount, Is.EqualTo(1), "The first connection must be kept.");
                    }

                    // 第一条仍可用：发一次 getSnapshot 证明（不是"两条都活着"的旧语义）。
                    first.Send(RequestLine("req-after-reject", null));
                    var snapshot = first.ReadMessage();
                    Assert.That(snapshot.IsOk, Is.True);
                    Assert.That(snapshot.Documents.Count, Is.EqualTo(2));
                }
            }
            finally
            {
                Directory.Delete(artifactsRoot, true);
            }
        }

        [Test]
        public void RuntimeServerRejectsLeaseRequestWithDocumentTypeIds()
        {
            // Schema allOf 约束：documentTypeIds 仅 getSnapshot 允许携带。
            var exception = Assert.Throws<VisualBridge.Runtime.VisualBridgeRuntimeBridgeException>(
                () => VisualBridge.Runtime.VisualBridgeRuntimeBridgeValidator.ParseMessage(
                    "{\"type\":\"request\",\"requestId\":\"req-lf\",\"action\":\"acquireLease\",\"documentTypeIds\":[\"sample.test.hero\"]}"));
            Assert.That(exception.Code, Is.EqualTo("runtime.invalidMessage"));

            var artifactsRoot = CreateTempArtifactsRoot();
            try
            {
                using (var server = StartServer(artifactsRoot, "editor-41009"))
                using (var client = RuntimeBridgeTestClient.Connect(server.TcpPort))
                {
                    client.Send(HelloLine(ValidToken));
                    Assert.That(client.ReadMessage().Type, Is.EqualTo(VisualBridge.Runtime.VisualBridgeRuntimeBridgeMessageType.Welcome));

                    // 校验失败是连接级错误：回发 invalidMessage 后断开。
                    client.Send("{\"type\":\"request\",\"requestId\":\"req-lf2\",\"action\":\"getDocumentSources\",\"documentTypeIds\":[\"sample.test.hero\"]}");
                    var error = client.ReadMessage();
                    Assert.That(error.Type, Is.EqualTo(VisualBridge.Runtime.VisualBridgeRuntimeBridgeMessageType.Error));
                    Assert.That(error.ErrorCode, Is.EqualTo("runtime.invalidMessage"));
                    Assert.That(client.IsDisconnected(), Is.True);
                }
            }
            finally
            {
                Directory.Delete(artifactsRoot, true);
            }
        }

        [Test]
        public void RuntimeServerEnforcesSingleControllerLease()
        {
            var artifactsRoot = CreateTempArtifactsRoot();
            try
            {
                using (var server = StartServer(artifactsRoot, "editor-41010"))
                using (var first = RuntimeBridgeTestClient.Connect(server.TcpPort))
                using (var second = RuntimeBridgeTestClient.Connect(server.TcpPort))
                {
                    first.Send(HelloLine(ValidToken, ClientInstanceId));
                    second.Send(HelloLine(ValidToken, ClientInstanceIdB));
                    Assert.That(first.ReadMessage().Type, Is.EqualTo(VisualBridge.Runtime.VisualBridgeRuntimeBridgeMessageType.Welcome));
                    Assert.That(second.ReadMessage().Type, Is.EqualTo(VisualBridge.Runtime.VisualBridgeRuntimeBridgeMessageType.Welcome));

                    // A 获取租约成功（ok 无载荷）。
                    first.Send(LeaseRequestLine("req-la", "acquireLease"));
                    var acquired = first.ReadMessage();
                    Assert.That(acquired.IsOk, Is.True);
                    Assert.That(acquired.RequestId, Is.EqualTo("req-la"));
                    Assert.That(acquired.Documents, Is.Null);
                    Assert.That(acquired.Sources, Is.Null);

                    // B 被拒：leaseDenied 且 detail 含持有者 clientInstanceId。
                    second.Send(LeaseRequestLine("req-lb", "acquireLease"));
                    var denied = second.ReadMessage();
                    Assert.That(denied.IsOk, Is.False);
                    Assert.That(denied.ErrorCode, Is.EqualTo("runtime.leaseDenied"));
                    Assert.That(denied.ErrorDetail, Does.Contain(ClientInstanceId));

                    // A 重复获取（幂等）仍 ok。
                    first.Send(LeaseRequestLine("req-la2", "acquireLease"));
                    Assert.That(first.ReadMessage().IsOk, Is.True);

                    // A 断开 → 租约自动释放 → B 可获取（轮询等待服务端感知断开）。
                    first.Dispose();
                    var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(5);
                    var reacquired = false;
                    while (DateTime.UtcNow < deadline)
                    {
                        second.Send(LeaseRequestLine("req-lb2", "acquireLease"));
                        var response = second.ReadMessage();
                        if (response.IsOk)
                        {
                            reacquired = true;
                            break;
                        }

                        Assert.That(response.ErrorCode, Is.EqualTo("runtime.leaseDenied"));
                        Thread.Sleep(50);
                    }

                    Assert.That(reacquired, Is.True, "lease should be released after the holder disconnects");
                }
            }
            finally
            {
                Directory.Delete(artifactsRoot, true);
            }
        }

        [Test]
        public void RuntimeServerRequiresLeaseForDocumentSources()
        {
            var artifactsRoot = CreateTempArtifactsRoot();
            try
            {
                using (var server = StartServer(artifactsRoot, "editor-41011"))
                using (var client = RuntimeBridgeTestClient.Connect(server.TcpPort))
                {
                    client.Send(HelloLine(ValidToken, ClientInstanceId));
                    Assert.That(client.ReadMessage().Type, Is.EqualTo(VisualBridge.Runtime.VisualBridgeRuntimeBridgeMessageType.Welcome));

                    // 无租约：leaseRequired。
                    client.Send(SourcesRequestLine("req-src0"));
                    var error = client.ReadMessage();
                    Assert.That(error.IsOk, Is.False);
                    Assert.That(error.RequestId, Is.EqualTo("req-src0"));
                    Assert.That(error.ErrorCode, Is.EqualTo("runtime.leaseRequired"));

                    // 观察者语义不受租约影响：getSnapshot 无租约仍 ok。
                    client.Send(RequestLine("req-snap0", null));
                    var snapshot = client.ReadMessage();
                    Assert.That(snapshot.IsOk, Is.True);
                    Assert.That(snapshot.Documents.Count, Is.EqualTo(2));
                }
            }
            finally
            {
                Directory.Delete(artifactsRoot, true);
            }
        }

        [Test]
        public void RuntimeServerServesDocumentSourcesToLeaseHolder()
        {
            var artifactsRoot = CreateTempArtifactsRoot();
            try
            {
                using (var server = StartServer(artifactsRoot, "editor-41012"))
                using (var client = RuntimeBridgeTestClient.Connect(server.TcpPort))
                {
                    client.Send(HelloLine(ValidToken, ClientInstanceId));
                    Assert.That(client.ReadMessage().Type, Is.EqualTo(VisualBridge.Runtime.VisualBridgeRuntimeBridgeMessageType.Welcome));

                    client.Send(LeaseRequestLine("req-la", "acquireLease"));
                    Assert.That(client.ReadMessage().IsOk, Is.True);

                    client.Send(SourcesRequestLine("req-src1"));
                    var response = client.ReadMessage();
                    Assert.That(response.IsOk, Is.True);
                    Assert.That(response.RequestId, Is.EqualTo("req-src1"));
                    Assert.That(response.Documents, Is.Null);
                    Assert.That(response.Sources.Count, Is.EqualTo(2));

                    var settings = response.Sources.Single(s => s.DocumentTypeId == "sample.test.settings");
                    Assert.That(settings.DocumentId, Is.EqualTo("sample.test.settings.default"));
                    Assert.That(settings.SourcePath, Is.EqualTo("Config/sample.test.settings.gamesettings"));
                    Assert.That(settings.SourceSha256, Does.Match("^[a-f0-9]{64}$"));

                    var hero = response.Sources.Single(s => s.DocumentTypeId == "sample.test.hero");
                    Assert.That(hero.SourcePath, Is.EqualTo("Entities/sample.test.hero.vbentity"));
                    Assert.That(hero.SourceSha256, Does.Match("^[a-f0-9]{64}$"));
                }
            }
            finally
            {
                Directory.Delete(artifactsRoot, true);
            }
        }

        [Test]
        public void RuntimeServerReleaseLeaseSemantics()
        {
            var artifactsRoot = CreateTempArtifactsRoot();
            try
            {
                using (var server = StartServer(artifactsRoot, "editor-41013"))
                using (var first = RuntimeBridgeTestClient.Connect(server.TcpPort))
                using (var second = RuntimeBridgeTestClient.Connect(server.TcpPort))
                {
                    first.Send(HelloLine(ValidToken, ClientInstanceId));
                    second.Send(HelloLine(ValidToken, ClientInstanceIdB));
                    Assert.That(first.ReadMessage().Type, Is.EqualTo(VisualBridge.Runtime.VisualBridgeRuntimeBridgeMessageType.Welcome));
                    Assert.That(second.ReadMessage().Type, Is.EqualTo(VisualBridge.Runtime.VisualBridgeRuntimeBridgeMessageType.Welcome));

                    first.Send(LeaseRequestLine("req-la", "acquireLease"));
                    Assert.That(first.ReadMessage().IsOk, Is.True);

                    // 非持有者 release → leaseDenied。
                    second.Send(LeaseRequestLine("req-rb", "releaseLease"));
                    var denied = second.ReadMessage();
                    Assert.That(denied.IsOk, Is.False);
                    Assert.That(denied.ErrorCode, Is.EqualTo("runtime.leaseDenied"));
                    Assert.That(denied.ErrorDetail, Does.Contain(ClientInstanceId));

                    // 持有者 release → ok；再 release → leaseNotHeld。
                    first.Send(LeaseRequestLine("req-ra", "releaseLease"));
                    Assert.That(first.ReadMessage().IsOk, Is.True);
                    first.Send(LeaseRequestLine("req-ra2", "releaseLease"));
                    var notHeld = first.ReadMessage();
                    Assert.That(notHeld.IsOk, Is.False);
                    Assert.That(notHeld.ErrorCode, Is.EqualTo("runtime.leaseNotHeld"));

                    // 释放后其他客户端可获取。
                    second.Send(LeaseRequestLine("req-lb", "acquireLease"));
                    Assert.That(second.ReadMessage().IsOk, Is.True);
                }
            }
            finally
            {
                Directory.Delete(artifactsRoot, true);
            }
        }

        [Test]
        public void RuntimeServerServesRealCompiledDocumentSources()
        {
            var compiledRoot = Path.Combine(
                VisualBridgeEditorBridgeService.UnityProjectRoot(), "Library", "VisualBridge", "Compiled");
            if (!Directory.Exists(compiledRoot))
            {
                Assert.Ignore("Library/VisualBridge/Compiled 缺失；先运行 Structured/Entity/Table/Graph Compiler batch。");
            }

            // ArtifactStore 直查：四域产物全部带源映射。
            var direct = VisualBridge.Runtime.VisualBridgeRuntimeArtifactStore.DocumentSources(compiledRoot);
            Assert.That(direct.Count, Is.EqualTo(4));

            using (var server = StartServer(compiledRoot, "editor-41014"))
            using (var client = RuntimeBridgeTestClient.Connect(server.TcpPort))
            {
                client.Send(HelloLine(ValidToken, ClientInstanceId));
                Assert.That(client.ReadMessage().Type, Is.EqualTo(VisualBridge.Runtime.VisualBridgeRuntimeBridgeMessageType.Welcome));

                client.Send(LeaseRequestLine("req-la", "acquireLease"));
                Assert.That(client.ReadMessage().IsOk, Is.True);

                client.Send(SourcesRequestLine("req-src1"));
                var response = client.ReadMessage();
                Assert.That(response.IsOk, Is.True);
                Assert.That(response.Sources.Count, Is.EqualTo(4));

                var encounter = response.Sources.Single(s => s.DocumentTypeId == "sample.unity.encounter");
                Assert.That(encounter.DocumentId, Is.EqualTo("sample.unity.encounter.opening"));
                Assert.That(encounter.SourcePath, Is.EqualTo("Graphs/Encounter.vbflow"));

                var settings = response.Sources.Single(s => s.DocumentTypeId == "sample.unity.game.settings");
                Assert.That(settings.SourcePath, Is.EqualTo("Config/Game.gamesettings"));

                var hero = response.Sources.Single(s => s.DocumentTypeId == "sample.unity.hero");
                Assert.That(hero.SourcePath, Is.EqualTo("Entities/Hero.vbentity"));

                // table 产物无 inputs.document：源映射来自 .vbsource.json 的 sources 数组。
                var skills = response.Sources.Single(s => s.DocumentTypeId == "sample.unity.skills");
                Assert.That(skills.DocumentId, Is.EqualTo("sample.unity.skills"));
                Assert.That(skills.SourcePath, Is.EqualTo("Tables/Skills_Main.csv"));

                foreach (var source in response.Sources)
                {
                    Assert.That(source.SourcePath, Is.Not.Null.And.Not.Empty, source.DocumentTypeId);
                    Assert.That(Sha256Pattern.IsMatch(source.SourceSha256), Is.True, source.DocumentTypeId);
                }
            }
        }

        [Test]
        public void RuntimeArtifactStoreLoadsRealCompiledArtifacts()
        {
            var compiledRoot = Path.Combine(
                VisualBridgeEditorBridgeService.UnityProjectRoot(), "Library", "VisualBridge", "Compiled");
            if (!Directory.Exists(compiledRoot))
            {
                Assert.Ignore("Library/VisualBridge/Compiled 缺失；先运行 Structured/Entity/Table/Graph Compiler batch。");
            }

            var snapshot = VisualBridge.Runtime.VisualBridgeRuntimeArtifactStore.Snapshot(compiledRoot);
            Assert.That(snapshot.Count, Is.EqualTo(4));

            Assert.That(snapshot[0].DocumentTypeId, Is.EqualTo("sample.unity.encounter"));
            Assert.That(snapshot[0].DocumentId, Is.EqualTo("sample.unity.encounter.opening"));
            Assert.That(snapshot[0].Kind, Is.EqualTo("visualbridge.graph.compiled"));

            Assert.That(snapshot[1].DocumentTypeId, Is.EqualTo("sample.unity.game.settings"));
            Assert.That(snapshot[1].DocumentId, Is.EqualTo("sample.unity.game.settings.default"));
            Assert.That(snapshot[1].Kind, Is.EqualTo("visualbridge.structured.compiled"));

            Assert.That(snapshot[2].DocumentTypeId, Is.EqualTo("sample.unity.hero"));
            Assert.That(snapshot[2].DocumentId, Is.EqualTo("sample.unity.hero.default"));
            Assert.That(snapshot[2].Kind, Is.EqualTo("visualbridge.entity.compiled"));

            // table 产物身份是 tableTypeId（无 documentId 字段）。
            Assert.That(snapshot[3].DocumentTypeId, Is.EqualTo("sample.unity.skills"));
            Assert.That(snapshot[3].DocumentId, Is.EqualTo("sample.unity.skills"));
            Assert.That(snapshot[3].Kind, Is.EqualTo("visualbridge.table.compiled"));

            foreach (var document in snapshot)
            {
                Assert.That(document.Data, Is.Not.Null, document.DocumentId);
                Assert.That(document.Data.HasValues, Is.True, document.DocumentId);
            }

            var first = VisualBridge.Runtime.VisualBridgeRuntimeArtifactStore.ComputeDigest(compiledRoot);
            var second = VisualBridge.Runtime.VisualBridgeRuntimeArtifactStore.ComputeDigest(compiledRoot);
            Assert.That(first, Is.Not.Null.And.Not.Empty);
            Assert.That(first, Is.EqualTo(second));
        }

        [Test]
        public void RuntimeServerPushesArtifactsChangedEvent()
        {
            var artifactsRoot = CreateTempArtifactsRoot();
            try
            {
                using (var server = StartServer(artifactsRoot, "editor-41008"))
                using (var client = RuntimeBridgeTestClient.Connect(server.TcpPort))
                {
                    client.Send(HelloLine(ValidToken));
                    Assert.That(client.ReadMessage().Type, Is.EqualTo(VisualBridge.Runtime.VisualBridgeRuntimeBridgeMessageType.Welcome));

                    // 后台写入新产物：新增 entity 文档 + 登记它的 entity manifest。
                    WriteArtifact(artifactsRoot, "manifest.entity.json", "documents/p1/sample.test.hero2/sample.test.hero2.default.vbcompiled.json", "visualbridge.entity.compiled", "sample.test.hero2", "sample.test.hero2.default");

                    var changed = client.WaitForEvent("artifactsChanged", TimeSpan.FromSeconds(5));
                    Assert.That(changed, Is.Not.Null, "expected an artifactsChanged event within 5 seconds");
                    Assert.That(changed.Documents.Count, Is.EqualTo(3));
                    Assert.That(changed.Documents.Any(d => d.DocumentId == "sample.test.hero2.default"), Is.True);
                }
            }
            finally
            {
                Directory.Delete(artifactsRoot, true);
            }
        }

        [Test]
        public void RuntimeDiscoveryMarksStaleHeartbeatAndDeadPidRecords()
        {
            if (Environment.OSVersion.Platform != PlatformID.Win32NT)
            {
                Assert.Ignore("Dead-pid coverage spawns cmd.exe and is Windows-specific.");
            }

            var directory = CreateTempDirectory();
            try
            {
                var currentPid = Process.GetCurrentProcess().Id;
                WriteDiscoveryRecord(directory, "fresh.json", "editor-" + currentPid, currentPid);
                WriteDiscoveryRecord(directory, "stale.json", "editor-" + currentPid, currentPid, heartbeatAge: TimeSpan.FromSeconds(10));
                WriteDiscoveryRecord(directory, "dead.json", "player-" + SpawnExitedProcessId(), SpawnExitedProcessId());

                var instances = VisualBridge.Runtime.VisualBridgeRuntimeBridgeDiscovery.EnumerateInstances(null, directory);
                Assert.That(instances.Count, Is.EqualTo(3));

                var fresh = instances.Single(i => Path.GetFileName(i.RecordPath) == "fresh.json");
                Assert.That(fresh.IsStale, Is.False);
                Assert.That(fresh.StaleReason, Is.Null);
                Assert.That(fresh.Kind, Is.EqualTo("editor-play"));
                Assert.That(fresh.TcpPort, Is.EqualTo(4594));
                Assert.That(fresh.Generation, Is.EqualTo(2));

                var stale = instances.Single(i => Path.GetFileName(i.RecordPath) == "stale.json");
                Assert.That(stale.IsStale, Is.True);
                Assert.That(stale.StaleReason, Does.Contain("heartbeat"));

                var dead = instances.Single(i => Path.GetFileName(i.RecordPath) == "dead.json");
                Assert.That(dead.IsStale, Is.True);
                Assert.That(dead.StaleReason, Does.Contain("pid"));
                Assert.That(dead.Kind, Is.EqualTo("player"));
            }
            finally
            {
                Directory.Delete(directory, true);
            }
        }

        [Test]
        public void FrameReaderPreservesMultibyteCharactersSplitAcrossChunks()
        {
            var payloadText = "{\"type\":\"response\",\"requestId\":\"req-1\",\"detail\":\"中文内容\"}";
            var payload = Encoding.UTF8.GetBytes(payloadText);
            var bytes = VisualBridge.Runtime.VisualBridgeFraming.EncodeFrame(
                VisualBridge.Runtime.VisualBridgeChannel.Editor,
                VisualBridge.Runtime.VisualBridgePayloadKind.Json,
                payload);
            var chineseStart = IndexOfBytes(bytes, Encoding.UTF8.GetBytes("中"));
            Assert.That(chineseStart, Is.GreaterThan(0));
            var split = chineseStart + 1; // 落在三字节字符中间

            var reader = new VisualBridge.Runtime.VisualBridgeFrameReader();
            reader.Append(bytes, 0, split);
            Assert.That(reader.TryReadFrame(out _), Is.False, "帧未读满时不得提前交付。");
            Assert.That(reader.BufferedByteCount, Is.EqualTo(split));

            reader.Append(bytes, split, bytes.Length - split);
            Assert.That(reader.TryReadFrame(out var frame), Is.True);
            var decoded = Encoding.UTF8.GetString(frame.Payload);
            Assert.That(decoded, Is.EqualTo(payloadText));
            Assert.That(decoded.Contains("�"), Is.False, "跨块解码不得产生替换字符。");
            Assert.That(decoded, Does.Contain("中文内容"));
            Assert.That(reader.TryReadFrame(out _), Is.False);
        }

        [Test]
        public void FrameReaderDropsIncompleteTrailingBytesOnDiscard()
        {
            var reader = new VisualBridge.Runtime.VisualBridgeFrameReader();
            var payload = Encoding.UTF8.GetBytes("{\"detail\":\"完成\"}");
            var complete = VisualBridge.Runtime.VisualBridgeFraming.EncodeFrame(
                VisualBridge.Runtime.VisualBridgeChannel.Editor,
                VisualBridge.Runtime.VisualBridgePayloadKind.Json,
                payload);
            // 只收到帧头 + 部分载荷：长度字段声明的字节尚未到齐。
            var partialLength = VisualBridge.Runtime.VisualBridgeFraming.HeaderBytes + 4;
            reader.Append(complete, 0, partialLength);
            Assert.That(reader.TryReadFrame(out _), Is.False);

            // 连接关闭/读取失败：残留半帧被显式丢弃，不会静默拼进后续数据。
            reader.DiscardPending();
            Assert.That(reader.BufferedByteCount, Is.Zero);
            Assert.That(reader.TryReadFrame(out _), Is.False);

            reader.Append(complete, 0, complete.Length);
            Assert.That(reader.TryReadFrame(out var frame), Is.True);
            var decoded = Encoding.UTF8.GetString(frame.Payload);
            Assert.That(decoded, Is.EqualTo("{\"detail\":\"完成\"}"));
            Assert.That(decoded.Contains("�"), Is.False);
        }

        [Test]
        public void FrameReaderReturnsMultipleCompleteFramesFromOneChunk()
        {
            var reader = new VisualBridge.Runtime.VisualBridgeFrameReader();
            var first = VisualBridge.Runtime.VisualBridgeFraming.EncodeFrame(
                VisualBridge.Runtime.VisualBridgeChannel.Editor,
                VisualBridge.Runtime.VisualBridgePayloadKind.Json,
                Encoding.UTF8.GetBytes("第一帧"));
            var second = VisualBridge.Runtime.VisualBridgeFraming.EncodeFrame(
                VisualBridge.Runtime.VisualBridgeChannel.Debug,
                VisualBridge.Runtime.VisualBridgePayloadKind.Binary,
                new byte[] { 1, 2, 3 });
            var bytes = new byte[first.Length + second.Length];
            Buffer.BlockCopy(first, 0, bytes, 0, first.Length);
            Buffer.BlockCopy(second, 0, bytes, first.Length, second.Length);
            reader.Append(bytes, 0, bytes.Length);
            Assert.That(reader.TryReadFrame(out var firstFrame), Is.True);
            Assert.That(Encoding.UTF8.GetString(firstFrame.Payload), Is.EqualTo("第一帧"));
            Assert.That(reader.TryReadFrame(out var secondFrame), Is.True);
            Assert.That(secondFrame.Channel, Is.EqualTo(VisualBridge.Runtime.VisualBridgeChannel.Debug));
            Assert.That(secondFrame.Payload, Is.EqualTo(new byte[] { 1, 2, 3 }));
            Assert.That(reader.TryReadFrame(out _), Is.False);
        }

        private static int IndexOfBytes(byte[] haystack, byte[] needle)
        {
            for (var index = 0; index <= haystack.Length - needle.Length; index++)
            {
                var matched = true;
                for (var offset = 0; offset < needle.Length; offset++)
                {
                    if (haystack[index + offset] == needle[offset])
                    {
                        continue;
                    }

                    matched = false;
                    break;
                }

                if (matched)
                {
                    return index;
                }
            }

            return -1;
        }

        /// <summary>轮询直到条件成立（真实装配的回调在其它线程，先等状态落定再断言）。</summary>
        private static bool WaitUntil(Func<bool> condition, TimeSpan timeout)
        {
            var deadline = DateTime.UtcNow + timeout;
            while (DateTime.UtcNow < deadline)
            {
                if (condition())
                {
                    return true;
                }

                Thread.Sleep(20);
            }

            return condition();
        }

        private static VisualBridge.Runtime.VisualBridgeRuntimeBridgeServer StartServer(
            string artifactsRoot, string instanceId, int generation = 1)
        {
            return new VisualBridge.Runtime.VisualBridgeRuntimeBridgeServer(
                instanceId, "editor-play", 0, ValidToken, artifactsRoot, generation);
        }

        /// <summary>
        /// hello（附录 A.3 统一形状）。clientEndpointId 缺省用 <see cref="ClientInstanceId"/>；
        /// 端口/模拟实例的解析见 RuntimeBridgeTestClient。
        /// </summary>
        private static string HelloLine(string token, string clientEndpointId = null, string resumeSessionId = null)
        {
            return VisualBridge.Runtime.VisualBridgeRuntimeBridgeValidator
                .CreateHello(clientEndpointId ?? ClientInstanceId, token, string.Empty, new[] { "json" }, resumeSessionId)
                .ToLine();
        }

        private static string RequestLine(string requestId, string[] documentTypeIds)
        {
            return VisualBridge.Runtime.VisualBridgeRuntimeBridgeValidator
                .CreateSnapshotRequest(requestId, documentTypeIds).ToLine();
        }

        private static string LeaseRequestLine(string requestId, string action)
        {
            return VisualBridge.Runtime.VisualBridgeRuntimeBridgeValidator
                .CreateLeaseRequest(requestId, action).ToLine();
        }

        /// <summary>开始一个执行实例并返回其 ID（tracking 处于开启状态时）。</summary>
        private static string SourcesRequestLine(string requestId)
        {
            return VisualBridge.Runtime.VisualBridgeRuntimeBridgeValidator
                .CreateSourcesRequest(requestId).ToLine();
        }

        /// <summary>临时产物目录：structured + entity 各一份合法产物及其 manifest。</summary>
        private static string CreateTempArtifactsRoot()
        {
            var root = CreateTempDirectory();
            WriteArtifact(
                root,
                "manifest.json",
                "documents/p1/sample.test.settings/sample.test.settings.default.vbcompiled.json",
                "visualbridge.structured.compiled",
                "sample.test.settings",
                "sample.test.settings.default",
                "Config/sample.test.settings.gamesettings",
                new string('1', 64));
            WriteArtifact(
                root,
                "manifest.entity.json",
                "documents/p1/sample.test.hero/sample.test.hero.default.vbcompiled.json",
                "visualbridge.entity.compiled",
                "sample.test.hero",
                "sample.test.hero.default",
                "Entities/sample.test.hero.vbentity",
                new string('2', 64));
            return root;
        }

        private static void WriteArtifact(
            string root,
            string manifestName,
            string relativePath,
            string kind,
            string documentTypeId,
            string documentId,
            string sourcePath = null,
            string sourceSha256 = null,
            string payloadPadding = null)
        {
            var absolutePath = Path.Combine(root, relativePath.Replace('/', Path.DirectorySeparatorChar));
            Directory.CreateDirectory(Path.GetDirectoryName(absolutePath));
            var data = new JObject { ["formatVersion"] = 1, ["kind"] = kind };
            if (payloadPadding != null)
            {
                // 超过 MaxMessageBytes 的响应用例：把 data 撑到 1 MB 以上。
                data["padding"] = payloadPadding;
            }

            var artifact = new JObject
            {
                ["formatVersion"] = 1,
                ["kind"] = kind,
                ["projectId"] = "p1",
                ["documentTypeId"] = documentTypeId,
                ["documentId"] = documentId,
                ["inputs"] = new JObject
                {
                    // 产物冻结格式：非 table 产物必须登记 Authoring 源路径与摘要。
                    ["document"] = new JObject
                    {
                        ["path"] = sourcePath ?? (documentId + ".vbsource"),
                        ["sha256"] = sourceSha256 ?? new string('3', 64),
                    },
                },
                ["data"] = data,
            };
            File.WriteAllText(absolutePath, artifact.ToString(Newtonsoft.Json.Formatting.None));

            var manifestPath = Path.Combine(root, manifestName);
            var manifest = File.Exists(manifestPath)
                ? ParseWithoutDateCoercion(File.ReadAllText(manifestPath))
                : new JObject
                {
                    ["formatVersion"] = 1,
                    ["kind"] = kind.Replace("compiled", "compileManifest"),
                    ["projectId"] = "p1",
                    ["outputs"] = new JArray(),
                };
            ((JArray)manifest["outputs"]).Add(new JObject
            {
                ["kind"] = "artifact",
                ["path"] = relativePath,
                ["sha256"] = new string('0', 64),
            });
            File.WriteAllText(manifestPath, manifest.ToString(Newtonsoft.Json.Formatting.None));
        }

        private static void WriteDiscoveryRecord(
            string directory, string fileName, string instanceId, int pid, TimeSpan? heartbeatAge = null)
        {
            var path = Path.Combine(directory, fileName);
            File.WriteAllText(path, "{\"formatVersion\":1,\"protocolVersion\":4,\"coreVersion\":1,\"instanceId\":\""
                + instanceId + "\",\"kind\":\"" + (instanceId.StartsWith("player-") ? "player" : "editor-play")
                + "\",\"capabilities\":[\"snapshot\",\"events\"],\"tcpPort\":4594,\"token\":\"" + ValidToken
                + "\",\"pid\":" + pid + ",\"generation\":2,\"startedAt\":\"2026-08-31T12:00:00.000Z\"}");
            if (heartbeatAge.HasValue)
            {
                File.SetLastWriteTimeUtc(path, DateTime.UtcNow - heartbeatAge.Value);
            }
        }

        private static string CreateTempDirectory()
        {
            var directory = Path.Combine(Path.GetTempPath(), "visualbridge-runtime-tests-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(directory);
            return directory;
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

        /// <summary>
        /// 测试用最小同步 TCP 客户端：连接后按统一协议的 6 字节帧收发，
        /// 用 Runtime 校验器解析每条服务端消息。
        /// </summary>
        private sealed class RuntimeBridgeTestClient : IDisposable
        {
            private readonly TcpClient client;
            private readonly NetworkStream stream;
            private readonly VisualBridge.Runtime.VisualBridgeFrameReader frameReader =
                new VisualBridge.Runtime.VisualBridgeFrameReader();
            private readonly byte[] readBuffer = new byte[8192];

            private RuntimeBridgeTestClient(TcpClient client, NetworkStream stream)
            {
                this.client = client;
                this.stream = stream;
                stream.ReadTimeout = 5000;
                stream.WriteTimeout = 5000;
            }

            public static RuntimeBridgeTestClient Connect(int port)
            {
                var client = new TcpClient();
                var async = client.BeginConnect("127.0.0.1", port, null, null);
                if (!async.AsyncWaitHandle.WaitOne(5000))
                {
                    client.Dispose();
                    throw new TimeoutException("TCP connect timed out.");
                }

                client.EndConnect(async);
                return new RuntimeBridgeTestClient(client, client.GetStream());
            }

            public void Send(string line)
            {
                var frame = VisualBridge.Runtime.VisualBridgeFraming.EncodeFrame(
                    VisualBridge.Runtime.VisualBridgeChannel.Editor,
                    VisualBridge.Runtime.VisualBridgePayloadKind.Json,
                    Encoding.UTF8.GetBytes(line));
                stream.Write(frame, 0, frame.Length);
                stream.Flush();
            }

            public VisualBridge.Runtime.VisualBridgeRuntimeBridgeMessage ReadMessage()
            {
                return VisualBridge.Runtime.VisualBridgeRuntimeBridgeValidator.ParseMessage(ReadPayload());
            }

            /// <summary>轮询读取直到出现目标事件或超时；期间跳过其它消息。</summary>
            public VisualBridge.Runtime.VisualBridgeRuntimeBridgeMessage WaitForEvent(string eventName, TimeSpan timeout)
            {
                var deadline = DateTime.UtcNow + timeout;
                while (DateTime.UtcNow < deadline)
                {
                    VisualBridge.Runtime.VisualBridgeRuntimeBridgeMessage message;
                    try
                    {
                        message = ReadMessage();
                    }
                    catch (IOException)
                    {
                        // 读超时：未在期限内等到事件。
                        return null;
                    }

                    if (message.Type == VisualBridge.Runtime.VisualBridgeRuntimeBridgeMessageType.Event
                        && message.EventName == eventName)
                    {
                        return message;
                    }
                }

                return null;
            }

            /// <summary>
            /// 读一条指定通道的 JSON 载荷，直到出现包含 <paramref name="expectedFragment"/> 的那条；
            /// 其它通道/其它载荷跳过。超时或断开返回 null。
            /// </summary>
            public string TryReadChannelJson(
                VisualBridge.Runtime.VisualBridgeChannel channel, TimeSpan timeout, string expectedFragment)
            {
                var previousTimeout = stream.ReadTimeout;
                stream.ReadTimeout = Math.Max(1, (int)timeout.TotalMilliseconds);
                try
                {
                    while (true)
                    {
                        while (frameReader.TryReadFrame(out var frame))
                        {
                            if (frame.Channel != channel)
                            {
                                continue;
                            }

                            var payload = Encoding.UTF8.GetString(frame.Payload);
                            if (payload.Contains(expectedFragment))
                            {
                                return payload;
                            }
                        }

                        var read = stream.Read(readBuffer, 0, readBuffer.Length);
                        if (read == 0)
                        {
                            frameReader.DiscardPending();
                            return null;
                        }

                        frameReader.Append(readBuffer, 0, read);
                    }
                }
                catch (IOException)
                {
                    return null;
                }
                finally
                {
                    stream.ReadTimeout = previousTimeout;
                }
            }

            public bool IsDisconnected()
            {
                try
                {
                    return stream.Read(readBuffer, 0, 1) == 0;
                }
                catch (IOException)
                {
                    return true;
                }
                catch (SocketException)
                {
                    return true;
                }
            }

            private string ReadPayload()
            {
                while (true)
                {
                    while (frameReader.TryReadFrame(out var frame))
                    {
                        // 该测试客户端只消费控制通道消息。
                        if (frame.Channel != VisualBridge.Runtime.VisualBridgeChannel.Editor)
                        {
                            continue;
                        }

                        return Encoding.UTF8.GetString(frame.Payload);
                    }

                    var read = stream.Read(readBuffer, 0, readBuffer.Length);
                    if (read == 0)
                    {
                        frameReader.DiscardPending();
                        throw new IOException("connection closed by the server.");
                    }

                    frameReader.Append(readBuffer, 0, read);
                }
            }

            public void Dispose()
            {
                stream.Dispose();
                client.Dispose();
            }
        }
    }
}
