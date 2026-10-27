namespace VisualBridge.Diagnostics
{
    /// <summary>
    /// 传输层的「入队前准入」（附录 A.9）：会话在**编码之前**咨询，未通过即整条消息不编码、不入队、不传输。
    /// 三项判定合并在一次调用里完成，避免热路径多次跨界调用：
    /// 槽位未知（含已随 <c>debugFinish</c> 失效）→ 计 <c>unknownSlot</c>；
    /// 方法号不在分类号段（0–9 为系统保留，分类方法从 10 起）→ 计 <c>unknownMethod</c>；
    /// 分类/实例未命中 <c>debugCategories</c> / <c>debugInstances</c> → 计 <c>filteredByServer</c>。
    /// 计数由实现累加（会话只负责「不编码」），并按周期以 <c>dropped</c> 上报。
    /// 未实现该接口的传输实现视为全部放行（附录 B.1.3 的传输实现不因此失效）。
    /// </summary>
    public interface IVisualBridgeDebugOutboundGate
    {
        /// <summary>
        /// 是否允许发出这条事件载荷。返回 false 表示已丢弃并计数，调用方必须不再编码、不再入队。
        /// <paramref name="instanceId"/> 为 null 时按槽位绑定推断。
        /// </summary>
        bool TryAdmitEvent(ushort instanceSlot, string instanceId, string category, ushort methodId);
    }
}
