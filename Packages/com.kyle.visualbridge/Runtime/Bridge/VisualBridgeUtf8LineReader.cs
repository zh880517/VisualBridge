using System;
using System.Collections.Generic;
using System.Text;

namespace VisualBridge.Runtime
{
    /// <summary>
    /// NDJSON 按字节缓冲的行读取器。TCP chunk 边界可能落在多字节 UTF-8
    /// 字符中间，因此先累积字节、找到 0x0A 后再对整行解码；逐块 Decode
    /// 会把不完整序列替换成 U+FFFD。
    /// </summary>
    public sealed class VisualBridgeUtf8LineReader
    {
        private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false);
        private readonly List<byte> pending = new List<byte>();

        /// <summary>尚未组成完整行的缓冲字节数（用于诊断/测试）。</summary>
        public int BufferedByteCount => pending.Count;

        public void Append(byte[] buffer, int offset, int count)
        {
            if (buffer == null)
            {
                throw new ArgumentNullException(nameof(buffer));
            }

            for (var index = 0; index < count; index++)
            {
                pending.Add(buffer[offset + index]);
            }
        }

        /// <summary>取出一行（不含换行符）；没有完整行时返回 false。</summary>
        public bool TryReadLine(out string line)
        {
            var newline = pending.IndexOf((byte)'\n');
            if (newline < 0)
            {
                line = null;
                return false;
            }

            var bytes = new byte[newline];
            pending.CopyTo(0, bytes, 0, newline);
            pending.RemoveRange(0, newline + 1);
            line = Utf8.GetString(bytes);
            return true;
        }

        /// <summary>丢弃尚未成行的字节（连接关闭/读取失败时调用，避免静默半行）。</summary>
        public void DiscardPending()
        {
            pending.Clear();
        }
    }
}
