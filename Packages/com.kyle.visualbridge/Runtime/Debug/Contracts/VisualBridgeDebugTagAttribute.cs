using System;

namespace VisualBridge.Diagnostics
{
    /// <summary>标记调试契约参数的标签。</summary>
    [AttributeUsage(AttributeTargets.Parameter, AllowMultiple = false)]
    public sealed class VisualBridgeDebugTagAttribute : Attribute
    {
        public VisualBridgeDebugTagAttribute(int tag)
        {
            Tag = tag;
        }

        /// <summary>参数标签值。</summary>
        public int Tag { get; }
    }
}
