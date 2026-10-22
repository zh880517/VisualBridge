using System;
using System.Collections.Generic;

namespace VisualBridge.Debug
{
    /// <summary>始终断开的空传输，用于未启用调试通道的构建。</summary>
    public sealed class NullDebugTransport : IDebugTransport
    {
        /// <summary>恒为 false。</summary>
        public bool IsConnected
        {
            get { return false; }
        }

        /// <summary>空事件：无连接变化。</summary>
        public event Action<bool> ConnectionChanged
        {
            add { }
            remove { }
        }

        /// <summary>丢弃负载。</summary>
        public void Send(byte[] payload)
        {
        }

        /// <summary>丢弃负载。</summary>
        public void SendBatch(IReadOnlyList<byte[]> payloads)
        {
        }

        /// <summary>无资源可释放。</summary>
        public void Dispose()
        {
        }
    }
}
