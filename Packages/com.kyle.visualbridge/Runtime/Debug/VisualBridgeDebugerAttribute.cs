using System;

namespace VisualBridge.Diagnostics
{
    /// <summary>
    /// 声明一个调试接口（附录 B.1）。<see cref="GeneratedDirectory"/> 必填、没有隐式默认值：
    /// 生成器在该目录下产出静态门面与实现，目录必须已被 asmdef 覆盖（VBDBG011）。
    /// </summary>
    [AttributeUsage(AttributeTargets.Interface, Inherited = false)]
    public sealed class VisualBridgeDebugerAttribute : Attribute
    {
        public VisualBridgeDebugerAttribute(string category)
        {
            Category = category;
        }

        /// <summary>分类名（只用于展示与契约分组，二进制头里不带分类号）。</summary>
        public string Category { get; }

        /// <summary>接口类别，默认 <see cref="VisualBridgeDebugerKind.Event"/>。</summary>
        public VisualBridgeDebugerKind Kind { get; set; }

        /// <summary>生成目录（必填）。</summary>
        public string GeneratedDirectory { get; set; }
    }
}
