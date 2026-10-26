using System;

namespace VisualBridge.Diagnostics
{
    /// <summary>
    /// 请求里的一个载荷参数（附录 A.5 的 <c>args</c> 项）：<see cref="Tag"/> 用于在
    /// 生成代码给出的声明表里定位参数，<see cref="Value"/> 已经由传输层按线格式解成 CLR 值，
    /// 运行期只做 tag → 声明顺序的重排与枚举/数值容错（E4/E6 负责线上格式）。
    /// </summary>
    public readonly struct VisualBridgeDebugQueryArgument
    {
        public VisualBridgeDebugQueryArgument(ushort tag, object value)
            : this(tag, null, value)
        {
        }

        public VisualBridgeDebugQueryArgument(ushort tag, string name, object value)
        {
            Tag = tag;
            Name = name;
            Value = value;
        }

        /// <summary>参数号（附录 B.5：0 保留给系统字段，载荷参数从 1 起）。</summary>
        public ushort Tag { get; }

        /// <summary>参数名（JSON 信封携带，二进制可缺）；只用于诊断，匹配一律按 <see cref="Tag"/>。</summary>
        public string Name { get; }

        /// <summary>已解码的参数值；null 表示默认值。</summary>
        public object Value { get; }
    }
}
