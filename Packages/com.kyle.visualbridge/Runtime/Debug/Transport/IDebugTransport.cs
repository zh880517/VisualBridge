using System;
using System.Collections.Generic;

namespace VisualBridge.Diagnostics
{
    /// <summary>调试消息传输；只接收已成帧的负载。</summary>
    public interface IDebugTransport
    {
        /// <summary>当前是否已连接。</summary>
        bool IsConnected { get; }

        /// <summary>连接状态变化。</summary>
        event Action<bool> ConnectionChanged;

        /// <summary>发送一条已成帧的负载。</summary>
        void Send(byte[] payload);

        /// <summary>批量发送已成帧的负载。</summary>
        void SendBatch(IReadOnlyList<byte[]> payloads);

        /// <summary>释放传输资源。</summary>
        void Dispose();
    }
}
