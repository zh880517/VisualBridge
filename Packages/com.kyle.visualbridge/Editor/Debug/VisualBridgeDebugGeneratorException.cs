using System;

namespace VisualBridge.Editor
{
    /// <summary>
    /// 调试契约生成器的失败。契约类错误用附录 B.5 的 <c>VBDBG011–015</c>；
    /// 其余输入校验用 <c>debug.*</c> 前缀（附录 B.5 没有为它们分配 VBDBG 号段）。
    /// </summary>
    public sealed class VisualBridgeDebugGeneratorException : Exception
    {
        public VisualBridgeDebugGeneratorException(string code, string message)
            : base(message)
        {
            Code = code;
        }

        /// <summary>错误码，例如 <c>VBDBG011</c>、<c>debug.parameterTypeUnsupported</c>。</summary>
        public string Code { get; }
    }
}
