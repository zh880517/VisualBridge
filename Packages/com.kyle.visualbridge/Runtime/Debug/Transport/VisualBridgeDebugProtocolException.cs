using System;

namespace VisualBridge.Diagnostics
{
    /// <summary>调试协议错误。</summary>
    public sealed class VisualBridgeDebugProtocolException : Exception
    {
        public VisualBridgeDebugProtocolException(string message)
            : base(message)
        {
        }

        public VisualBridgeDebugProtocolException(string message, Exception inner)
            : base(message, inner)
        {
        }
    }
}
