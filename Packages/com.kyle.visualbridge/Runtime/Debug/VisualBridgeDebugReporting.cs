using System.Threading;

namespace VisualBridge.Diagnostics
{
#if UNITY_EDITOR || VISUALBRIDGE_RUNTIME_BRIDGE
    /// <summary>
    /// 调试上报总开关（附录 A.2 的通道 0 控制消息 <c>debugSetEnabled</c> / <c>debugEnabled</c>）。
    /// 进程级、与传输解耦：面板发来的开关命令改这里，
    /// <see cref="VisualBridge.Diagnostics.Bridge.VisualBridgeDebugTransport"/> 只拦调试流的四条消息
    /// （<c>debug</c> / <c>debugCreate</c> / <c>debugFinish</c> / <c>debugFrame</c>）；
    /// 抑制是"不发"，不是"丢弃"：不写队列、不计 <c>dropped</c>、不告警。抑制点有两处：
    /// 事件在**编码之前**被拒（<c>Start</c>/<c>SendEvent</c> 路径），而 <c>End</c> 已经编码完的消息
    /// 在**写队列之前**丢弃——编码器必须调用 <c>End</c> 收尾，否则半条消息会污染下一条。
    /// <c>debugResult</c>（宿主查询的应答）不属于调试流，关闭期间照常送出；
    /// <c>dropped</c>（周期计数）与通道 1 的 <c>response</c> / <c>reject</c> 同样不受影响；
    /// 关闭期间到达的 <c>request</c> 立即以 <c>runtime.debugNotEnabled</c> 拒绝，不入队、不执行业务 handler。
    ///
    /// 权威值来自服务端的 <c>welcome.debugEnabled</c>（附录 A.3）：连接建立时用握手值重新对齐，
    /// 之后由 <c>debugSetEnabled</c> 命令改写。默认 <c>true</c>（附录 A.8：未连接时不影响本地调试语义）。
    /// </summary>
    public static class VisualBridgeDebugReporting
    {
        private static int s_enabled = 1;

        /// <summary>当前是否允许产生调试流消息。热路径只读这一个 volatile 字段。</summary>
        public static bool Enabled
        {
            get { return Volatile.Read(ref s_enabled) != 0; }
        }

        /// <summary>
        /// 改写开关。只改闸门本身：不 reset 调试会话、不动槽位分配。
        /// 关闭期间 <c>Create</c> 在已连接时按既有语义回滚本地发布、未连接时仍可入待发队列（连上后再 flush）；
        /// 重新打开后已注册的实例立刻恢复上报，未连接期间的待发项由重开路径强制再 flush（附录 A.5）。
        /// </summary>
        public static void SetEnabled(bool enabled)
        {
            Volatile.Write(ref s_enabled, enabled ? 1 : 0);
        }

        /// <summary>恢复默认值（<c>true</c>）。测试与宿主重装时用。</summary>
        internal static void Reset()
        {
            Volatile.Write(ref s_enabled, 1);
        }
    }
#endif
}
