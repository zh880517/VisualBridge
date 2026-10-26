using System;

namespace VisualBridge.Diagnostics
{
    /// <summary>
    /// 调试消息编码器（附录 B.4）：替换编码器的唯一要求是 <see cref="VisualBridgeDebug.SetEncoder"/>
    /// 之后生成代码零改动，因此这里只暴露 Begin/PushParam/End 三步。
    /// </summary>
    public interface IDebugMessageEncoder
    {
        /// <summary>开始一条消息；<paramref name="requestSeq"/> 只用于 debugResult。</summary>
        void Begin(ushort methodId, ushort instanceSlot, uint requestSeq);

        /// <summary>压入一个非默认参数；门面层已跳过默认值，实现按声明类型处理。</summary>
        void PushParam(string name, ushort tag, object value);

        /// <summary>结束一条消息并返回完整载荷。</summary>
        ReadOnlyMemory<byte> End();
    }
}
