namespace VisualBridge.Diagnostics
{
    /// <summary>
    /// 查询处理器的统一签名（附录 B.5）：生成的 Dispatcher 直接把 <c>Dispatch</c> 适配成这个委托，
    /// 运行期按五元组直接调用，不做 DynamicInvoke，也不反射任何生成成员（IL2CPP 裁剪下不会静默失效）。
    /// 参数依次是方法号、实例 id、实例槽位、请求号、按声明顺序解码好的载荷参数。
    /// </summary>
    public delegate bool VisualBridgeDebugRequestDispatcher(
        ushort methodId,
        string instanceId,
        ushort instanceSlot,
        uint requestSeq,
        object[] parameters);
}
