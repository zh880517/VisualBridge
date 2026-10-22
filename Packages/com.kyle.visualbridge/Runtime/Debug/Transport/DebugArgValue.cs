namespace VisualBridge.Debug
{
    /// <summary>单个调试参数。</summary>
    public readonly struct DebugArgValue
    {
        public DebugArgValue(string name, int tag, DebugValueKind kind, object value)
        {
            Name = name;
            Tag = tag;
            Kind = kind;
            Value = value;
        }

        /// <summary>参数名。</summary>
        public string Name { get; }

        /// <summary>参数标签。</summary>
        public int Tag { get; }

        /// <summary>参数值类型。</summary>
        public DebugValueKind Kind { get; }

        /// <summary>参数值；bool/整数/浮点/字符串/枚举名/字节数组，允许为 null。</summary>
        public object Value { get; }
    }
}
