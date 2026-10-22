using NUnit.Framework;
using VisualBridge.Debug;

namespace VisualBridge.Editor.Tests
{
    /// <summary>验证调试通道的启动策略与传输生命周期。</summary>
    public sealed class VisualBridgeDebugBootstrapTests
    {
        [SetUp]
        public void SetUp()
        {
            VisualBridgeDebug.StopTransport();
        }

        [TearDown]
        public void TearDown()
        {
            VisualBridgeDebug.StopTransport();
            VisualBridgeDebug.RefreshConnectType();
        }

        [Test]
        public void PlayerWithAutoStartStarts()
        {
            Assert.That(
                VisualBridgeDebugBootstrap.ShouldAutoStart(
                    VisualBridgeConnectType.Player,
                    true,
                    true,
                    false),
                Is.True);
        }

        [Test]
        public void PlayerDisabledDoesNotStart()
        {
            Assert.That(
                VisualBridgeDebugBootstrap.ShouldAutoStart(
                    VisualBridgeConnectType.Player,
                    false,
                    true,
                    true),
                Is.False);
        }

        [Test]
        public void EditorPlayerWithoutAutoStartDoesNotStart()
        {
            Assert.That(
                VisualBridgeDebugBootstrap.ShouldAutoStart(
                    VisualBridgeConnectType.EditorPlayer,
                    true,
                    true,
                    false),
                Is.False);
        }

        [Test]
        public void EditorPlayerWithAutoStartStarts()
        {
            Assert.That(
                VisualBridgeDebugBootstrap.ShouldAutoStart(
                    VisualBridgeConnectType.EditorPlayer,
                    true,
                    false,
                    true),
                Is.True);
        }

        [Test]
        public void EditorNeverStarts()
        {
            Assert.That(
                VisualBridgeDebugBootstrap.ShouldAutoStart(
                    VisualBridgeConnectType.Editor,
                    true,
                    true,
                    true),
                Is.False);
        }

        [Test]
        public void StartAndStopTransportAreIdempotent()
        {
            VisualBridgeDebug.SetConnectTypeForTests(VisualBridgeConnectType.Player);

            Assert.DoesNotThrow(() =>
            {
                VisualBridgeDebug.StartTransport();
                VisualBridgeDebug.StartTransport();
                VisualBridgeDebug.StopTransport();
                VisualBridgeDebug.StopTransport();
            });

            Assert.That(VisualBridgeDebug.isConnected, Is.False);
        }

        [Test]
        public void EditorStartTransportKeepsDisconnected()
        {
            VisualBridgeDebug.SetConnectTypeForTests(VisualBridgeConnectType.Editor);

            Assert.DoesNotThrow(() =>
            {
                VisualBridgeDebug.StartTransport();
                VisualBridgeDebug.StartTransport();
            });

            Assert.That(VisualBridgeDebug.ConnectType, Is.EqualTo(VisualBridgeConnectType.Editor));
            Assert.That(VisualBridgeDebug.isConnected, Is.False);
        }

        [Test]
        public void SetConnectTypeForTestsUpdatesConnectType()
        {
            VisualBridgeDebug.SetConnectTypeForTests(VisualBridgeConnectType.Player);

            Assert.That(VisualBridgeDebug.ConnectType, Is.EqualTo(VisualBridgeConnectType.Player));
        }
    }
}
