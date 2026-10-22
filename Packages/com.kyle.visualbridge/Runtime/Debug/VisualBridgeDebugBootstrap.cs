using UnityEngine;

namespace VisualBridge.Debug
{
    /// <summary>调试通道生命周期入口：启动策略与退出清理。</summary>
    internal static class VisualBridgeDebugBootstrap
    {
        private static bool s_quittingSubscribed;

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

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.BeforeSceneLoad)]
        private static void Initialize()
        {
            // 宏关闭时 isDebugBuild 为 const false，整个引导直接退出。
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
    }
}
