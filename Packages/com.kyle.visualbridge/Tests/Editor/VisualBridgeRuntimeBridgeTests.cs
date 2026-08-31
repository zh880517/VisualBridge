using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using UnityEditor;
using UnityEngine;

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
            Assert.That(cases.Count, Is.EqualTo(36));
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
                    client.Send(HelloLine(ValidToken, new[] { "snapshot", "events" }));
                    var welcome = client.ReadMessage();
                    Assert.That(welcome.Type, Is.EqualTo(VisualBridge.Runtime.VisualBridgeRuntimeBridgeMessageType.Welcome));
                    Assert.That(welcome.InstanceId, Is.EqualTo("editor-41001"));
                    Assert.That(welcome.Kind, Is.EqualTo("editor-play"));
                    Assert.That(welcome.Generation, Is.EqualTo(3));
                    Assert.That(welcome.ProtocolVersion, Is.EqualTo(1));
                    Assert.That(welcome.CoreVersion, Is.EqualTo(1));
                    Assert.That(welcome.Capabilities, Is.EquivalentTo(new[] { "snapshot", "events", "lease", "sources" }));
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

        [Test]
        public void RuntimeServerAnswersUnknownActionWithResponseError()
        {
            var artifactsRoot = CreateTempArtifactsRoot();
            try
            {
                using (var server = StartServer(artifactsRoot, "editor-41002"))
                using (var client = RuntimeBridgeTestClient.Connect(server.TcpPort))
                {
                    client.Send(HelloLine(ValidToken, new[] { "snapshot" }));
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
                    client.Send(HelloLine(OtherToken, new[] { "snapshot" }));
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
                        "{\"type\":\"hello\",\"protocolVersion\":2,\"coreVersion\":1,\"token\":\"" + ValidToken
                        + "\",\"clientInstanceId\":\"" + ClientInstanceId + "\",\"capabilities\":[\"snapshot\"]}");
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
        public void RuntimeServerAcceptsConcurrentClients()
        {
            var artifactsRoot = CreateTempArtifactsRoot();
            try
            {
                using (var server = StartServer(artifactsRoot, "editor-41007"))
                using (var first = RuntimeBridgeTestClient.Connect(server.TcpPort))
                using (var second = RuntimeBridgeTestClient.Connect(server.TcpPort))
                {
                    first.Send(HelloLine(ValidToken, new[] { "snapshot" }));
                    second.Send(HelloLine(ValidToken, new[] { "snapshot" }));
                    Assert.That(first.ReadMessage().Type, Is.EqualTo(VisualBridge.Runtime.VisualBridgeRuntimeBridgeMessageType.Welcome));
                    Assert.That(second.ReadMessage().Type, Is.EqualTo(VisualBridge.Runtime.VisualBridgeRuntimeBridgeMessageType.Welcome));

                    first.Send(RequestLine("req-c1", null));
                    second.Send(RequestLine("req-c2", null));
                    var firstResponse = first.ReadMessage();
                    var secondResponse = second.ReadMessage();
                    Assert.That(firstResponse.IsOk && firstResponse.Documents.Count == 2, Is.True);
                    Assert.That(secondResponse.IsOk && secondResponse.Documents.Count == 2, Is.True);
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
                    client.Send(HelloLine(ValidToken, new[] { "snapshot", "lease" }));
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
                    first.Send(HelloLine(ValidToken, new[] { "snapshot", "lease", "sources" }, ClientInstanceId));
                    second.Send(HelloLine(ValidToken, new[] { "snapshot", "lease", "sources" }, ClientInstanceIdB));
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
                    client.Send(HelloLine(ValidToken, new[] { "snapshot", "lease", "sources" }, ClientInstanceId));
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
                    client.Send(HelloLine(ValidToken, new[] { "snapshot", "lease", "sources" }, ClientInstanceId));
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
                    first.Send(HelloLine(ValidToken, new[] { "snapshot", "lease" }, ClientInstanceId));
                    second.Send(HelloLine(ValidToken, new[] { "snapshot", "lease" }, ClientInstanceIdB));
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
                client.Send(HelloLine(ValidToken, new[] { "snapshot", "lease", "sources" }, ClientInstanceId));
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
                    client.Send(HelloLine(ValidToken, new[] { "snapshot", "events" }));
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

        private static VisualBridge.Runtime.VisualBridgeRuntimeBridgeServer StartServer(
            string artifactsRoot, string instanceId, int generation = 1)
        {
            return new VisualBridge.Runtime.VisualBridgeRuntimeBridgeServer(
                instanceId, "editor-play", 0, ValidToken, artifactsRoot, generation);
        }

        private static string HelloLine(string token, string[] capabilities, string clientInstanceId = null)
        {
            return VisualBridge.Runtime.VisualBridgeRuntimeBridgeValidator
                .CreateHello(clientInstanceId ?? ClientInstanceId, token, capabilities).ToLine();
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
            string sourceSha256 = null)
        {
            var absolutePath = Path.Combine(root, relativePath.Replace('/', Path.DirectorySeparatorChar));
            Directory.CreateDirectory(Path.GetDirectoryName(absolutePath));
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
                ["data"] = new JObject { ["formatVersion"] = 1, ["kind"] = kind },
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
            File.WriteAllText(path, "{\"formatVersion\":1,\"protocolVersion\":1,\"coreVersion\":1,\"instanceId\":\""
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
        /// 测试用最小同步 TCP 客户端：连接后按 NDJSON 行收发，
        /// 用 Runtime 校验器解析每条服务端消息。
        /// </summary>
        private sealed class RuntimeBridgeTestClient : IDisposable
        {
            private readonly TcpClient client;
            private readonly NetworkStream stream;
            private readonly StringBuilder lineBuffer = new StringBuilder();
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
                var bytes = Encoding.UTF8.GetBytes(line + "\n");
                stream.Write(bytes, 0, bytes.Length);
                stream.Flush();
            }

            public VisualBridge.Runtime.VisualBridgeRuntimeBridgeMessage ReadMessage()
            {
                return VisualBridge.Runtime.VisualBridgeRuntimeBridgeValidator.ParseMessage(ReadLine());
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

            private string ReadLine()
            {
                while (true)
                {
                    var buffered = lineBuffer.ToString();
                    var newline = buffered.IndexOf('\n');
                    if (newline >= 0)
                    {
                        var line = lineBuffer.ToString(0, newline);
                        lineBuffer.Remove(0, newline + 1);
                        if (line.Trim().Length > 0)
                        {
                            return line;
                        }

                        continue;
                    }

                    var read = stream.Read(readBuffer, 0, readBuffer.Length);
                    if (read == 0)
                    {
                        throw new IOException("connection closed by the server.");
                    }

                    lineBuffer.Append(Encoding.UTF8.GetString(readBuffer, 0, read));
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
