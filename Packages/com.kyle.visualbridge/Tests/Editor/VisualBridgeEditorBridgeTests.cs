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

namespace VisualBridge.Editor.Tests
{
    public sealed class VisualBridgeEditorBridgeTests
    {
        private static readonly string ValidToken = new string('a', 48);

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
                "1b3121ab-2646-4e0f-a789-e970d4fbca8f", ValidToken, new[] { "open", "reveal" });
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
            using (var client = new VisualBridgeEditorBridgeClient(TestWindow(server.Port, generation: 7), "1b3121ab-2646-4e0f-a789-e970d4fbca8f", new[] { "open", "reveal" }))
            {
                var welcome = client.Connect();
                Assert.That(welcome.ServerGeneration, Is.EqualTo(7));
                Assert.That(client.State, Is.EqualTo(VisualBridgeBridgeConnectionState.Connected));

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
        public void ClientRejectsInvalidTokenErrorFromServer()
        {
            using (var server = BridgeTestServer.Start("{\"type\":\"error\",\"code\":\"bridge.invalidToken\",\"detail\":\"rejected\"}"))
            using (var client = new VisualBridgeEditorBridgeClient(TestWindow(server.Port), "1b3121ab-2646-4e0f-a789-e970d4fbca8f", new[] { "open", "reveal" }))
            {
                var exception = Assert.Throws<VisualBridgeIntegrationException>(() => client.Connect());
                Assert.That(exception.Code, Is.EqualTo("bridge.invalidToken"));
                Assert.That(client.State, Is.EqualTo(VisualBridgeBridgeConnectionState.Disconnected));
            }
        }

        [Test]
        public void ClientRejectsProtocolVersionMismatchErrorFromServer()
        {
            using (var server = BridgeTestServer.Start("{\"type\":\"error\",\"code\":\"bridge.protocolVersionMismatch\"}"))
            using (var client = new VisualBridgeEditorBridgeClient(TestWindow(server.Port), "1b3121ab-2646-4e0f-a789-e970d4fbca8f", new[] { "open", "reveal" }))
            {
                var exception = Assert.Throws<VisualBridgeIntegrationException>(() => client.Connect());
                Assert.That(exception.Code, Is.EqualTo("bridge.protocolVersionMismatch"));
            }
        }

        [Test]
        public void ClientRejectsWelcomeWithStaleServerGeneration()
        {
            using (var server = BridgeTestServer.Start(Welcome(generation: 2)))
            using (var client = new VisualBridgeEditorBridgeClient(TestWindow(server.Port, generation: 1), "1b3121ab-2646-4e0f-a789-e970d4fbca8f", new[] { "open", "reveal" }))
            {
                var exception = Assert.Throws<VisualBridgeIntegrationException>(() => client.Connect());
                Assert.That(exception.Code, Is.EqualTo("bridge.staleGeneration"));
            }
        }

        [Test]
        public void ClientRejectsRequestWithoutAdvertisedCapability()
        {
            using (var server = BridgeTestServer.Start(Welcome(generation: 1, capabilities: "[\"open\"]")))
            using (var client = new VisualBridgeEditorBridgeClient(TestWindow(server.Port, generation: 1), "1b3121ab-2646-4e0f-a789-e970d4fbca8f", new[] { "open", "reveal" }))
            {
                Assert.DoesNotThrow(() => client.Connect());
                var exception = Assert.Throws<VisualBridgeIntegrationException>(() =>
                    client.SendRequest(VisualBridgeEditorBridgeValidator.CreateReveal("req-cap-1", "game.item:x", false), 5000));
                Assert.That(exception.Code, Is.EqualTo("bridge.capabilityMissing"));
            }
        }

        [Test]
        public void ClientFailsPendingRequestWhenServerSendsInvalidJson()
        {
            using (var server = BridgeTestServer.Start(Welcome(generation: 1), thenSend: "{not json"))
            using (var client = new VisualBridgeEditorBridgeClient(TestWindow(server.Port), "1b3121ab-2646-4e0f-a789-e970d4fbca8f", new[] { "open", "reveal" }))
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
            using (var client = new VisualBridgeEditorBridgeClient(TestWindow(server.Port), "1b3121ab-2646-4e0f-a789-e970d4fbca8f", new[] { "open", "reveal" }))
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
            using (var client = new VisualBridgeEditorBridgeClient(TestWindow(server.Port), "1b3121ab-2646-4e0f-a789-e970d4fbca8f", new[] { "open", "reveal" }))
            {
                Assert.DoesNotThrow(() => client.Connect());
                server.CloseConnection();
                var exception = Assert.Throws<VisualBridgeIntegrationException>(() =>
                    client.SendRequest(VisualBridgeEditorBridgeValidator.CreateOpen("req-close-1", "Config/Game.gamesettings"), 5000));
                Assert.That(exception.Code, Is.EqualTo("bridge.disconnected"));
            }
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
                ProtocolVersion = 1,
                Capabilities = new[] { "open", "reveal" },
                ProjectRoots = new[] { "D:/Authoring" },
                PipePath = @"\\.\pipe\visualbridge-unused",
                TcpPort = tcpPort,
                Token = ValidToken,
                Pid = Process.GetCurrentProcess().Id,
                Generation = generation,
                StartedAt = DateTime.UtcNow,
                RecordPath = null,
            };
        }

        private static string Welcome(int generation = 1, string capabilities = "[\"open\",\"reveal\"]")
        {
            return "{\"type\":\"welcome\",\"protocolVersion\":1,\"windowId\":\"6f9619ff-8b86-4d01-b42d-00cf4fc964ff\",\"serverGeneration\":"
                + generation + ",\"capabilities\":" + capabilities + "}";
        }

        private static string CreateDiscoveryDirectory()
        {
            var directory = Path.Combine(Path.GetTempPath(), "visualbridge-bridge-tests-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(directory);
            return directory;
        }

        private static void WriteRecord(string directory, string fileName, int pid, TimeSpan? heartbeatAge = null, string projectRoot = "D:/Authoring", string windowId = "1b3121ab-2646-4e0f-a789-e970d4fbca8f")
        {
            var path = Path.Combine(directory, fileName);
            File.WriteAllText(path, "{\"formatVersion\":1,\"protocolVersion\":1,\"windowId\":\"" + windowId
                + "\",\"capabilities\":[\"open\",\"reveal\"],\"projectRoots\":[\"" + projectRoot.Replace('\\', '/')
                + "\"],\"pipePath\":\"\\\\\\\\.\\\\pipe\\\\visualbridge-test\",\"tcpPort\":8226,\"token\":\"" + ValidToken
                + "\",\"pid\":" + pid + ",\"generation\":1,\"startedAt\":\"2026-08-30T12:41:06.879Z\"}");
            if (heartbeatAge.HasValue)
            {
                File.SetLastWriteTimeUtc(path, DateTime.UtcNow - heartbeatAge.Value);
            }
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
        /// 监听 127.0.0.1 随机端口的最小服务端 TCP 对等体：用固定行应答 hello 握手、
        /// 记录收到的每个请求，并在每个请求后回放排队的响应行。进程内 Mono 命名管道
        /// 服务端在写入时死锁（2026-08-30 实测），因此协议测试走客户端优先的 TCP 端点。
        /// </summary>
        private sealed class BridgeTestServer : IDisposable
        {
            private readonly TcpListener listener;
            private readonly Thread thread;
            private readonly string replyToHello;
            private readonly string thenSend;
            private readonly object gate = new object();
            private readonly Queue<string> pending = new Queue<string>();
            private readonly System.Collections.Concurrent.ConcurrentQueue<string> received = new System.Collections.Concurrent.ConcurrentQueue<string>();
            private TcpClient client;
            private NetworkStream stream;

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

            public string[] GetReceivedRequests()
            {
                return received.ToArray();
            }

            public void QueueResponse(string line)
            {
                lock (gate)
                {
                    pending.Enqueue(line);
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

            private void Run()
            {
                try
                {
                    client = listener.AcceptTcpClient();
                    stream = client.GetStream();
                    // 先消费 hello 握手再应答 welcome，与服务端协议行为一致。
                    Receive();
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

            private void Send(string line)
            {
                var bytes = Encoding.UTF8.GetBytes(line + "\n");
                stream.Write(bytes, 0, bytes.Length);
                stream.Flush();
            }

            private string Receive()
            {
                var buffer = new byte[4096];
                var text = new StringBuilder();
                while (true)
                {
                    var read = stream.Read(buffer, 0, buffer.Length);
                    if (read == 0)
                    {
                        return null;
                    }

                    text.Append(Encoding.UTF8.GetString(buffer, 0, read));
                    var newline = text.ToString().IndexOf('\n');
                    if (newline >= 0)
                    {
                        return text.ToString(0, newline);
                    }
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
    }
}
