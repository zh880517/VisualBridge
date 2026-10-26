using System;

namespace VisualBridge.Diagnostics
{
    /// <summary>
    /// 标记调试方法的参数号（附录 B.2）：<c>tag</c> 供二进制编码，参数名供 JSON。
    /// </summary>
    [AttributeUsage(AttributeTargets.Parameter, Inherited = false)]
    public sealed class VisualBridgeDebugTagAttribute : Attribute
    {
        public VisualBridgeDebugTagAttribute(ushort tag)
        {
            Tag = tag;
        }

        /// <summary>参数号；同一方法内唯一，按升序压入。</summary>
        public ushort Tag { get; }
    }
}
