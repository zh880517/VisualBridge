using System;
using System.Text;
using Newtonsoft.Json.Linq;

namespace VisualBridge.Runtime
{
    /// <summary>
    /// 通道 0 的保活消息（附录 A.2：<c>ping</c> / <c>pong</c>，JSON，双向）。
    /// 它们在连接层被就地消化，不进入握手与业务消息分发：
    /// 收到 <c>ping</c> 立即回 <c>pong</c>，收到 <c>pong</c> 只用于刷新入站空闲计时。
    /// 只识别 ≤64 字节的通道 0 JSON 控制载荷，其余载荷一律原样交给上层，避免误吞业务消息。
    /// </summary>
    internal static class VisualBridgePingPayload
    {
        private const int MaxControlBytes = 64;

        internal static readonly byte[] Ping = Encoding.UTF8.GetBytes("{\"type\":\"ping\"}");

        internal static readonly byte[] Pong = Encoding.UTF8.GetBytes("{\"type\":\"pong\"}");

        /// <summary>载荷是否是通道 0 的 ping（true 表示调用方应回 pong 且不再分发）。</summary>
        internal static bool IsPing(byte[] payload)
        {
            return IsType(payload, "ping");
        }

        /// <summary>载荷是否是通道 0 的 pong（true 表示调用方只刷新空闲计时，不再分发）。</summary>
        internal static bool IsPong(byte[] payload)
        {
            return IsType(payload, "pong");
        }

        private static bool IsType(byte[] payload, string type)
        {
            if (payload == null || payload.Length == 0 || payload.Length > MaxControlBytes)
            {
                return false;
            }

            try
            {
                var text = Encoding.UTF8.GetString(payload);
                if (text.IndexOf("\"type\"", StringComparison.Ordinal) < 0)
                {
                    return false;
                }

                var value = JObject.Parse(text);
                var token = value["type"];
                return token != null
                    && token.Type == JTokenType.String
                    && string.Equals(token.Value<string>(), type, StringComparison.Ordinal);
            }
            catch (Exception)
            {
                // 不是合法 JSON 的短控制载荷：交给上层按协议错误处理。
                return false;
            }
        }
    }
}
