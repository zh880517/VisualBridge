using System;
using System.Collections.Generic;

namespace VisualBridge.Debug
{
    /// <summary>调试实例元数据消息体。</summary>
    public sealed class DebugInstanceBody : IDebugMessageBody
    {
        public DebugInstanceBody(string label, IReadOnlyList<string> keywords)
        {
            Label = label;
            Keywords = keywords ?? Array.Empty<string>();
        }

        /// <summary>实例显示名。</summary>
        public string Label { get; }

        /// <summary>实例筛选关键词。</summary>
        public IReadOnlyList<string> Keywords { get; }
    }
}
