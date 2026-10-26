namespace VisualBridge.Diagnostics
{
    /// <summary>
    /// 调试接口的类别（附录 B.1）：Event 只上报、Query 由 VS Code 反向发起。
    /// </summary>
    public enum VisualBridgeDebugerKind
    {
        /// <summary>单向事件上报。</summary>
        Event = 0,

        /// <summary>可被反向查询的接口。</summary>
        Query,
    }
}
