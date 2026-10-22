using System;

namespace VisualBridge.Diagnostics
{
    /// <summary>调试消息成帧器。</summary>
    public interface IDebugFramer
    {
        /// <summary>将消息编码为一行字节流。</summary>
        byte[] Frame(in DebugMessageHeader header, IDebugMessageBody body);

        /// <summary>从缓冲区解析一条完整消息。</summary>
        bool TryParse(
            ReadOnlySpan<byte> buffer,
            out int consumed,
            out DebugMessageHeader header,
            out IDebugMessageBody body);
    }
}
