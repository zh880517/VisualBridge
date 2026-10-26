using System;
using System.Collections.Generic;

namespace VisualBridge.Diagnostics
{
#if UNITY_EDITOR || VISUALBRIDGE_RUNTIME_BRIDGE
    /// <summary>
    /// 契约告警的诊断汇聚点。Debug 程序集是 noEngineReferences，不能直接 Debug.Log：
    /// 由 Bridge 程序集注入 sink 转成 Unity 控制台告警，未注入时只留在环形缓冲里供诊断与测试读取。
    /// </summary>
    internal static class VisualBridgeDebugDiagnostics
    {
        private const int MaxWarnings = 64;

        private static readonly object Gate = new object();
        private static readonly List<string> s_warnings = new List<string>();
        private static Action<string> s_sink;

        internal static int WarningCount
        {
            get
            {
                lock (Gate)
                {
                    return s_warnings.Count;
                }
            }
        }

        internal static void Warning(string message)
        {
            if (string.IsNullOrEmpty(message))
            {
                return;
            }

            Action<string> sink;
            lock (Gate)
            {
                if (s_warnings.Count >= MaxWarnings)
                {
                    s_warnings.RemoveAt(0);
                }

                s_warnings.Add(message);
                sink = s_sink;
            }

            if (sink == null)
            {
                return;
            }

            try
            {
                sink(message);
            }
            catch (Exception)
            {
                // 诊断输出失败不得影响业务调用。
            }
        }

        internal static string[] GetWarnings()
        {
            lock (Gate)
            {
                return s_warnings.ToArray();
            }
        }

        internal static void SetSink(Action<string> sink)
        {
            lock (Gate)
            {
                s_sink = sink;
            }
        }

        internal static void Reset()
        {
            lock (Gate)
            {
                s_warnings.Clear();
            }
        }
    }
#endif
}
