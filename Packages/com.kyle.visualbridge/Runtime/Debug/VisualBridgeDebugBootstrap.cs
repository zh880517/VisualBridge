using UnityEngine;

namespace VisualBridge.Debug
{
    /// <summary>调试通道生命周期入口：启动策略与退出清理。</summary>
    internal static class VisualBridgeDebugBootstrap
    {
        /// <summary>纯启动策略；Editor 永不自动启动。</summary>
        internal static bool ShouldAutoStart(
            VisualBridgeConnectType connectType,
            bool enabled,
            bool autoStartInPlayer,
            bool autoStartInEditorPlay)
        {
            switch (connectType)
            {
                case VisualBridgeConnectType.Player:
                    return enabled && autoStartInPlayer;
                case VisualBridgeConnectType.EditorPlayer:
                    return enabled && autoStartInEditorPlay;
                default:
                    return false;
            }
        }

#if UNITY_EDITOR || VISUALBRIDGE_RUNTIME_BRIDGE
        private static bool s_quittingSubscribed;

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.BeforeSceneLoad)]
        private static void Initialize()
        {
            // 编译期已由宏隔离；此处再按构建开关做一次运行期防御。
            bool debugEnabled = VisualBridgeDebug.isDebugBuild;
            if (!debugEnabled)
            {
                return;
            }

            VisualBridgeDebug.RefreshConnectType();

            if (!s_quittingSubscribed)
            {
                s_quittingSubscribed = true;
                Application.quitting += OnApplicationQuitting;
            }

            if (ShouldAutoStart(
                    VisualBridgeDebug.ConnectType,
                    VisualBridgeDebugSettings.Enabled,
                    VisualBridgeDebugSettings.AutoStartInPlayer,
                    VisualBridgeDebugSettings.AutoStartInEditorPlay))
            {
                VisualBridgeDebug.StartTransport();
            }
        }

        private static void OnApplicationQuitting()
        {
            VisualBridgeDebug.StopTransport();
        }
#endif
    }
}
