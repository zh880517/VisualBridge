using System;

namespace VisualBridge.Diagnostics
{
#if UNITY_EDITOR || VISUALBRIDGE_RUNTIME_BRIDGE
    /// <summary>
    /// 一个接口的查询处理器注册项（附录 B.5）：Dispatcher 委托负责分发（它自己构造携带归属的
    /// <see cref="VisualBridgeDebugRequest"/>），Decoder 委托给出方法号 → 参数声明表。
    /// 两者都由生成的 Dispatcher 在 <c>Register</c> 时挂载，运行期不反射任何生成成员。
    /// </summary>
    internal sealed class VisualBridgeDebugRequestRegistration
    {
        internal VisualBridgeDebugRequestRegistration(string category, string interfaceId,
            VisualBridgeDebugRequestDispatcher dispatcher, VisualBridgeDebugRequestParameterDecoder decoder)
        {
            Category = category ?? string.Empty;
            InterfaceId = interfaceId ?? string.Empty;
            Dispatcher = dispatcher;
            Decoder = decoder;
        }

        internal string Category { get; }

        internal string InterfaceId { get; }

        internal VisualBridgeDebugRequestDispatcher Dispatcher { get; }

        /// <summary>参数声明表；缺少它时带载荷参数的请求按 <c>runtime.invalidArgument</c> 拒绝。</summary>
        internal VisualBridgeDebugRequestParameterDecoder Decoder { get; }

        /// <summary>方法号是否属于这个处理器；Decoder 缺失时无从判断。</summary>
        internal bool TryGetParameters(ushort methodId, out string[] names, out ushort[] tags, out Type[] types)
        {
            names = null;
            tags = null;
            types = null;
            var decoder = Decoder;
            if (decoder == null)
            {
                return false;
            }

            try
            {
                return decoder(methodId, out names, out tags, out types) && names != null && tags != null
                    && types != null && names.Length == tags.Length && tags.Length == types.Length;
            }
            catch (Exception exception)
            {
                VisualBridgeDebugDiagnostics.Warning(
                    "VisualBridgeDebug 读取查询参数声明表失败，按未注册方法处理：" + exception.Message);
                names = null;
                tags = null;
                types = null;
                return false;
            }
        }
    }
#endif
}
