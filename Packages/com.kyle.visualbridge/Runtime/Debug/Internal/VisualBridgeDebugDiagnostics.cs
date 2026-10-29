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

        /// <summary>
        /// 一行调试 trace（仅 <c>VISUALBRIDGE_DEBUG_TRACE=1</c> 时输出）：会话重置时序、发射端重建实例等。
        /// 只读观察：不进 Warning 公告、不计 dropped、不改任何会话状态。Runtime 程序集禁止 Unity API，
        /// 所以日志走宿主 Install 时注入的 sink（与 Warning 共用同一条通道）。
        /// </summary>
        internal static void Log(string message)
        {
            if (string.IsNullOrEmpty(message) || !TraceEnabled)
            {
                return;
            }

            Action<string> sink;
            lock (Gate)
            {
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

        /// <summary>trace 是否开启：环境变量 <c>VISUALBRIDGE_DEBUG_TRACE=1</c>（会话时序排障用）。</summary>
        private static readonly bool TraceEnabled =
            string.Equals(Environment.GetEnvironmentVariable("VISUALBRIDGE_DEBUG_TRACE"), "1", StringComparison.Ordinal);

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
