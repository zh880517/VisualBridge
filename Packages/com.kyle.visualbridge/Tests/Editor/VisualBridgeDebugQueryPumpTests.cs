using NUnit.Framework;
using UnityEngine;
using UnityEngine.LowLevel;
using UnityEngine.PlayerLoop;
using VisualBridge.Diagnostics.Bridge;

namespace VisualBridge.Editor.Tests
{
    /// <summary>
    /// 主线程 pump 挂接（附录 B.6）：PlayerLoop 幂等安装/摘除、Editor 非播放态 update 挂接。
    /// 挂接点必须能在 Domain Reload 后重新装（静态字段被清空、旧项可能残留失效委托）。
    /// </summary>
    public sealed class VisualBridgeDebugQueryPumpTests
    {
        private PlayerLoopSystem original;

        [SetUp]
        public void SetUp()
        {
            // 静态状态跨测试残留：先摘挂接并清空诊断计数，每个用例都从"Domain Reload 后"起步。
            original = PlayerLoop.GetCurrentPlayerLoop();
            VisualBridgeDebugQueryPump.ResetForTests();
        }

        [TearDown]
        public void TearDown()
        {
            PlayerLoop.SetPlayerLoop(original);
            VisualBridgeDebugQueryPump.ResetForTests();
            // 恢复生产挂接：Editor 非播放态的查询靠 EditorApplication.update 推进。
            VisualBridgeDebugQueryPump.EnsureInstalled();
        }

        [Test]
        public void PlayerLoopPumpInstallsIdempotentlyAndRemovesCleanly()
        {
            VisualBridgeDebugQueryPump.EnsureInstalled();
            Assert.That(VisualBridgeDebugQueryPump.IsPlayerLoopInstalled, Is.True);
            Assert.That(CountPumpSystems(), Is.EqualTo(1), "The Update subsystem must carry exactly one pump entry.");

            VisualBridgeDebugQueryPump.EnsureInstalled();
            Assert.That(CountPumpSystems(), Is.EqualTo(1), "Re-installing must not duplicate the pump entry.");

            VisualBridgeDebugQueryPump.Uninstall();
            Assert.That(CountPumpSystems(), Is.EqualTo(0));
            Assert.That(VisualBridgeDebugQueryPump.IsPlayerLoopInstalled, Is.False);
        }

        [Test]
        public void EnsureInstalledAfterReloadReplacesAStalePlayerLoopEntry()
        {
            // 模拟 Domain Reload：静态字段已清空（playerLoopInstalled=false），但 PlayerLoop 里
            // 还留着上一代的同名项（委托已失效）。
            Assert.That(VisualBridgeDebugQueryPump.IsPlayerLoopInstalled, Is.False);
            InsertStalePumpEntry();
            Assert.That(CountPumpSystems(), Is.EqualTo(1), "Precondition: a stale entry is present.");

            VisualBridgeDebugQueryPump.EnsureInstalled();

            Assert.That(VisualBridgeDebugQueryPump.IsPlayerLoopInstalled, Is.True, "The reload branch must reinstall.");
            Assert.That(CountPumpSystems(), Is.EqualTo(1), "The stale entry must be replaced, not duplicated.");

            // 重装后的 pump 只推进一次：残留项若被保留，这里会被数两次。
            Assert.That(VisualBridgeDebugQueryPump.Pump(), Is.InRange(0, 1));
            Assert.That(VisualBridgeDebugQueryPump.PumpCount, Is.EqualTo(1));
        }

        [Test]
        public void EditorPumpInstallsForTheNonPlayModeEditor()
        {
            VisualBridgeDebugQueryPump.EnsureInstalled();
            Assert.That(Application.isPlaying, Is.False, "EditMode tests are not in play mode.");
            Assert.That(VisualBridgeDebugQueryPump.IsEditorPumpInstalled, Is.True,
                "Without a running PlayerLoop the editor needs EditorApplication.update to pump queries.");
        }

        [Test]
        public void PumpCountsInvocationsAndNeverThrowsWhenIdle()
        {
            Assert.That(VisualBridgeDebugQueryPump.PumpCount, Is.EqualTo(0));
            Assert.That(VisualBridgeDebugQueryPump.Pump(), Is.InRange(0, 1), "A pump call executes 0 or 1 queued query.");
            Assert.That(VisualBridgeDebugQueryPump.PumpCount, Is.EqualTo(1));
        }

        /// <summary>把一条同名、空委托的项塞进 Update：等价于 reload 后残留的失效挂接。</summary>
        private static void InsertStalePumpEntry()
        {
            var loop = PlayerLoop.GetCurrentPlayerLoop();
            var systems = loop.subSystemList;
            for (var index = 0; index < systems.Length; index++)
            {
                if (systems[index].type != typeof(Update))
                {
                    continue;
                }

                var children = systems[index].subSystemList ?? new PlayerLoopSystem[0];
                var extended = new PlayerLoopSystem[children.Length + 1];
                System.Array.Copy(children, extended, children.Length);
                extended[children.Length] = new PlayerLoopSystem { type = typeof(VisualBridgeDebugQueryPump) };
                systems[index].subSystemList = extended;
                loop.subSystemList = systems;
                PlayerLoop.SetPlayerLoop(loop);
                return;
            }

            Assert.Fail("The current PlayerLoop has no Update subsystem.");
        }

        private static int CountPumpSystems()
        {
            var loop = PlayerLoop.GetCurrentPlayerLoop();
            var count = 0;
            foreach (var system in loop.subSystemList ?? new PlayerLoopSystem[0])
            {
                if (system.type != typeof(Update) || system.subSystemList == null)
                {
                    continue;
                }

                foreach (var child in system.subSystemList)
                {
                    if (child.type == typeof(VisualBridgeDebugQueryPump))
                    {
                        count++;
                    }
                }
            }

            return count;
        }
    }
}
