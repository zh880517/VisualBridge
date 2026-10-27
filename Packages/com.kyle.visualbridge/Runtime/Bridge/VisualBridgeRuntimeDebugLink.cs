using System;
using System.Collections.Generic;

namespace VisualBridge.Runtime
{
    /// <summary>
    /// 一条已握手连接上的调试通道（附录 A.2/A.9）：本类型只搬运字节与连接态，
    /// 不解释消息语义。调试运行期（<c>VisualBridge.Debug.Bridge</c>）的实现把它包成
    /// <c>IVisualBridgeDebugTransport</c>，从而让 <c>VisualBridge.Runtime</c> 不引用调试程序集。
    /// 宿主在握手完成后订阅 <see cref="VisualBridgeRuntimeBridgeServer.DebugLinkOpened"/> 取得实例；
    /// 所有回调都在连接读线程（或心跳线程）上触发，处理器不得阻塞。
    /// </summary>
    public sealed class VisualBridgeRuntimeDebugLink
    {
        private readonly VisualBridgeBridgeSocket socket;
        private readonly Action<string> log;

        internal VisualBridgeRuntimeDebugLink(VisualBridgeBridgeSocket socket, long generation, Action<string> log)
        {
            this.socket = socket;
            this.log = log;
            Generation = generation;
        }

        /// <summary>连接是否仍然可用；每次状态变化由连接层推进。</summary>
        public bool IsOpen => socket != null && socket.IsOpen;

        /// <summary>连接代次：每条新连接递增（断连期间不变），用于识别“没观察到断连就又连上”的重连。</summary>
        public long Generation { get; }

        /// <summary>发送侧计数快照（调试传输层用它把队列淘汰计入 <c>dropped.queueOverflow</c>）。</summary>
        public VisualBridgeSendCounters SendCounters
        {
            get { return socket == null ? new VisualBridgeSendCounters() : socket.SendCounters; }
        }

        /// <summary>通道 1 的入站帧（当前只有对端发来的 <c>request</c>，见附录 A.2）。</summary>
        public event Action<VisualBridgePayloadKind, byte[]> DebugFrameReceived;

        /// <summary>连接关闭（只触发一次）。</summary>
        public event Action Closed;

        /// <summary>心跳节拍（约 1 s 一次），供传输层按周期上报 <c>dropped</c>。</summary>
        public event Action Tick;

        /// <summary>
        /// 通道 1 的控制类消息（debugCreate/debugFinish/debugFrame/dropped/通道 1 的 response）：
        /// 走控制队列（不淘汰），帧头通道位是 1；队列满时连接会被断开。
        /// </summary>
        public bool SendControl(byte[] payload, VisualBridgePayloadKind payloadKind)
        {
            return socket != null && socket.SendDebugControl(payload, payloadKind);
        }

        /// <summary>通道 1 的数据消息。</summary>
        public bool SendDebug(byte[] payload, VisualBridgePayloadKind payloadKind)
        {
            return socket != null && socket.SendDebug(payload, payloadKind);
        }

        internal void NotifyDebugFrame(VisualBridgePayloadKind payloadKind, byte[] payload)
        {
            var handler = DebugFrameReceived;
            if (handler == null)
            {
                return;
            }

            try
            {
                handler(payloadKind, payload);
            }
            catch (Exception exception)
            {
                // 调试消息处理异常不得断开连接（附录 A.9：未知方法/未知槽位只丢弃并计数）。
                log?.Invoke("[runtime-bridge] debug frame handler failed: " + exception.Message);
            }
        }

        internal void NotifyTick()
        {
            var handler = Tick;
            if (handler == null)
            {
                return;
            }

            try
            {
                handler();
            }
            catch (Exception exception)
            {
                log?.Invoke("[runtime-bridge] debug tick handler failed: " + exception.Message);
            }
        }

        internal void NotifyClosed()
        {
            var handler = Closed;
            if (handler == null)
            {
                return;
            }

            try
            {
                handler();
            }
            catch (Exception exception)
            {
                log?.Invoke("[runtime-bridge] debug close handler failed: " + exception.Message);
            }
        }
    }
}
