using UnityEngine;
using UnityEngine.LowLevel;
using UnityEngine.PlayerLoop;
#if UNITY_EDITOR
using UnityEditor;
#endif

namespace VisualBridge.Diagnostics.Bridge
{
    /// <summary>
    /// 查询运行期的主线程 pump 挂接（附录 B.6 的宿主责任）。查询队列本身在
    /// <see cref="VisualBridgeDebugQueryRuntime"/>（无引擎引用的程序集），
    /// 但 pump 必须挂在引擎的每帧回调上，因此挂接放在本程序集：
    /// <list type="bullet">
    /// <item>Player / Play 模式：注册到 <c>PlayerLoop</c> 的 <see cref="Update"/> 子系统（BeforeSceneLoad）。</item>
    /// <item>Editor 非播放态：<c>EditorApplication.update</c>。</item>
    /// </list>
    /// Domain Reload 会清空静态字段并重跑静态构造，因此挂接必须幂等且能重新挂上
    /// （旧的 PlayerLoop 项在 reload 后仍可能留着已失效的委托，装之前先摘掉同名项）。
    /// </summary>
    public static class VisualBridgeDebugQueryPump
    {
        private const string LogPrefix = "[visualbridge] query pump";

        private static bool playerLoopInstalled;
        private static bool editorPumpInstalled;

        /// <summary>PlayerLoop 里是否已挂上本 pump。</summary>
        public static bool IsPlayerLoopInstalled => playerLoopInstalled;

        /// <summary>Editor 非播放态的 update 是否已挂上。</summary>
        public static bool IsEditorPumpInstalled => editorPumpInstalled;

        /// <summary>pump 实际执行次数（诊断用；未经 <see cref="Pump"/> 的调用不计）。</summary>
        public static long PumpCount { get; private set; }

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.BeforeSceneLoad)]
        private static void InstallForPlayer()
        {
            EnsureInstalled();
        }

#if UNITY_EDITOR
        [InitializeOnLoadMethod]
        private static void InstallForEditor()
        {
            if (Application.isPlaying)
            {
                return;
            }

            InstallEditorPump();
        }
#endif

        /// <summary>幂等安装：PlayerLoop 恒装（Player 与 Play 模式），Editor 非播放态另装 update。</summary>
        public static void EnsureInstalled()
        {
            InstallPlayerLoop();
#if UNITY_EDITOR
            if (!Application.isPlaying)
            {
                InstallEditorPump();
            }
#endif
        }

        /// <summary>移除挂接（测试与关闭用）。</summary>
        public static void Uninstall()
        {
            RemovePlayerLoop();
#if UNITY_EDITOR
            if (editorPumpInstalled)
            {
                EditorApplication.update -= EditorTick;
                editorPumpInstalled = false;
            }
#endif
        }

        /// <summary>测试用：摘掉全部挂接并把诊断计数归零（生产路径不调用）。</summary>
        internal static void ResetForTests()
        {
            Uninstall();
            PumpCount = 0;
        }

        /// <summary>执行一次 pump；返回本次执行的请求数（0 或 1）。</summary>
        public static int Pump()
        {
            PumpCount++;
            return VisualBridgeDebugQueryRuntime.Pump();
        }

        private static void InstallPlayerLoop()
        {
            if (playerLoopInstalled && PlayerLoopContainsPump())
            {
                return;
            }

            // reload 之后旧项可能还在（委托已失效）：先摘干净再装，避免每帧两次 pump。
            RemovePlayerLoop();
            var loop = PlayerLoop.GetCurrentPlayerLoop();
            if (!InsertIntoUpdate(ref loop))
            {
                Debug.LogWarning($"{LogPrefix}: no Update subsystem in the current PlayerLoop; queries will not be pumped.");
                return;
            }

            PlayerLoop.SetPlayerLoop(loop);
            playerLoopInstalled = true;
        }

        private static void RemovePlayerLoop()
        {
            var loop = PlayerLoop.GetCurrentPlayerLoop();
            if (RemoveFromUpdate(ref loop))
            {
                PlayerLoop.SetPlayerLoop(loop);
            }

            playerLoopInstalled = false;
        }

        private static void Tick()
        {
            Pump();
        }

        private static bool InsertIntoUpdate(ref PlayerLoopSystem loop)
        {
            var systems = loop.subSystemList;
            if (systems == null)
            {
                return false;
            }

            for (var index = 0; index < systems.Length; index++)
            {
                if (systems[index].type != typeof(Update))
                {
                    continue;
                }

                var children = systems[index].subSystemList ?? new PlayerLoopSystem[0];
                foreach (var child in children)
                {
                    if (child.type == typeof(VisualBridgeDebugQueryPump))
                    {
                        return true;
                    }
                }

                var extended = new PlayerLoopSystem[children.Length + 1];
                System.Array.Copy(children, extended, children.Length);
                extended[children.Length] = new PlayerLoopSystem
                {
                    type = typeof(VisualBridgeDebugQueryPump),
                    updateDelegate = Tick,
                };
                systems[index].subSystemList = extended;
                loop.subSystemList = systems;
                return true;
            }

            return false;
        }

        private static bool RemoveFromUpdate(ref PlayerLoopSystem loop)
        {
            var systems = loop.subSystemList;
            if (systems == null)
            {
                return false;
            }

            for (var index = 0; index < systems.Length; index++)
            {
                if (systems[index].type != typeof(Update))
                {
                    continue;
                }

                var children = systems[index].subSystemList;
                if (children == null)
                {
                    return false;
                }

                var kept = new System.Collections.Generic.List<PlayerLoopSystem>(children.Length);
                var removed = false;
                foreach (var child in children)
                {
                    if (child.type == typeof(VisualBridgeDebugQueryPump))
                    {
                        removed = true;
                        continue;
                    }

                    kept.Add(child);
                }

                if (!removed)
                {
                    return false;
                }

                systems[index].subSystemList = kept.ToArray();
                loop.subSystemList = systems;
                return true;
            }

            return false;
        }

        private static bool PlayerLoopContainsPump()
        {
            var loop = PlayerLoop.GetCurrentPlayerLoop();
            var systems = loop.subSystemList;
            if (systems == null)
            {
                return false;
            }

            foreach (var system in systems)
            {
                if (system.type != typeof(Update) || system.subSystemList == null)
                {
                    continue;
                }

                foreach (var child in system.subSystemList)
                {
                    if (child.type == typeof(VisualBridgeDebugQueryPump))
                    {
                        return true;
                    }
                }
            }

            return false;
        }

#if UNITY_EDITOR
        private static void InstallEditorPump()
        {
            if (editorPumpInstalled)
            {
                return;
            }

            editorPumpInstalled = true;
            EditorApplication.update += EditorTick;
        }

        private static void EditorTick()
        {
            // 非播放态的编辑器里没有 PlayerLoop，查询靠这个回调推进。
            Pump();
        }
#endif
    }
}
