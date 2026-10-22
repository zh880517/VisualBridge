using System;
using System.Collections.Generic;

namespace VisualBridge.Diagnostics
{
    /// <summary>带参数列表的调试消息体。</summary>
    public sealed class DebugArgsBody : IDebugMessageBody
    {
        public DebugArgsBody(IReadOnlyList<DebugArgValue> args)
        {
            Args = args ?? Array.Empty<DebugArgValue>();
        }

        /// <summary>参数列表。</summary>
        public IReadOnlyList<DebugArgValue> Args { get; }
    }
}
