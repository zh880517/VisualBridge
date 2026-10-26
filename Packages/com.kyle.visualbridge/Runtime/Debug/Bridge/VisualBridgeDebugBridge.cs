using System;

namespace VisualBridge.Diagnostics.Bridge
{
#if UNITY_EDITOR || VISUALBRIDGE_RUNTIME_BRIDGE
    /// <summary>
    /// 调试契约与传输层之间的显式挂接点（附录 B.1）：E1 实现 <see cref="IVisualBridgeDebugTransport"/> 后在这里注入，
    /// 业务与生成代码只调用 <see cref="VisualBridgeDebug"/>。
    /// 整个程序集的实现都在 <c>UNITY_EDITOR || VISUALBRIDGE_RUNTIME_BRIDGE</c> 内，宏关闭时不参与编译。
    /// </summary>
    public static class VisualBridgeDebugBridge
    {
        private static IVisualBridgeDebugTransport s_transport;

        /// <summary>是否已注入传输实现。</summary>
        public static bool IsInstalled
        {
            get { return s_transport != null; }
        }

        /// <summary>注入传输实现并挂接；重复注入以最后一次为准。</summary>
        public static void Install(IVisualBridgeDebugTransport transport)
        {
            if (transport == null)
            {
                return;
            }

            s_transport = transport;
            VisualBridgeDebugDiagnostics.SetSink(LogWarning);
            VisualBridgeDebugSession.SetTransport(transport);
        }

        /// <summary>解除注入并按断连语义重置会话状态；可重复调用。</summary>
        public static void Uninstall()
        {
            s_transport = null;
            VisualBridgeDebugSession.ClearTransport();
            VisualBridgeDebugDiagnostics.SetSink(null);
        }

        /// <summary>重连后显式挂接：建立连接并 flush 待发描述。</summary>
        public static void Attach()
        {
            VisualBridgeDebug.Attach();
        }

        /// <summary>显式解除挂接：按断连语义重置会话状态，保留注入的传输实现。</summary>
        public static void Detach()
        {
            VisualBridgeDebug.Detach();
        }

        /// <summary>
        /// 读取诊断计数（附录 B.3.3）：E4 的 dropped 聚合从这里取 DroppedMessages /
        /// DroppedOversizeMessages；业务与生成代码不依赖它。
        /// </summary>
        public static VisualBridgeDebugDiagnosticsSnapshot GetDiagnostics()
        {
            return VisualBridgeDebugMetrics.GetSnapshot();
        }

        // Debug 程序集是 noEngineReferences，告警在这里转成 Unity 控制台输出。
        private static void LogWarning(string message)
        {
            UnityEngine.Debug.LogWarning(message);
        }
    }
#endif
}
