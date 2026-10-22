using UnityEditor;
using UnityEngine;
using VisualBridge.Diagnostics;

namespace VisualBridge.Editor
{
    /// <summary>调试通道的编辑器菜单入口：仅播放态手动启动。</summary>
    internal static class VisualBridgeDebugMenu
    {
        [MenuItem("Tools/VisualBridge/Debug/Start Debug Bridge (Editor Play)")]
        private static void StartDebugBridge()
        {
            if (!Application.isPlaying)
            {
                UnityEngine.Debug.Log("[visualbridge] 请先进入播放模式，再启动调试桥。");
                return;
            }

            VisualBridgeDebug.StartTransport();
            UnityEngine.Debug.Log(VisualBridgeDebug.isConnected
                ? "[visualbridge] 调试桥已启动。"
                : "[visualbridge] 调试传输尚不可用。");
        }
    }
}
