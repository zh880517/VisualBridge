using System;

namespace VisualBridge.Diagnostics
{
    /// <summary>
    /// 标记调试方法的实例参数（附录 B.1）：必须恰好一个 string 实例参数，优先用本特性，
    /// 否则生成器退化为“名为 instanceId 的唯一 string 参数”（VBDBG012）。
    /// </summary>
    [AttributeUsage(AttributeTargets.Parameter, Inherited = false)]
    public sealed class VisualBridgeDebugInstanceAttribute : Attribute
    {
    }
}
