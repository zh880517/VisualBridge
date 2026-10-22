namespace VisualBridge.Diagnostics
{
    /// <summary>调试参数值类型。</summary>
    public enum DebugValueKind : byte
    {
        Bool,
        Int32,
        Int64,
        UInt64,
        Single,
        Double,
        String,
        Bytes,
        Enum,
    }
}
