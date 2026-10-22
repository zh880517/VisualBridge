using System;
using System.Collections.Generic;

#if UNITY_EDITOR || VISUALBRIDGE_RUNTIME_BRIDGE
namespace VisualBridge.Diagnostics
{
    /// <summary>按接口全名登记请求处理器。</summary>
    internal sealed class VisualBridgeDebugRegistry
    {
        private readonly object _gate = new object();
        private readonly Dictionary<string, Action<VisualBridgeDebugRequest>> _handlers =
            new Dictionary<string, Action<VisualBridgeDebugRequest>>(StringComparer.Ordinal);

        /// <summary>登记处理器；返回 true 表示覆盖了已有登记。</summary>
        public bool Register(string iface, Action<VisualBridgeDebugRequest> handler)
        {
            lock (_gate)
            {
                bool replaced = _handlers.ContainsKey(iface);
                _handlers[iface] = handler;
                return replaced;
            }
        }

        /// <summary>移除处理器；返回是否存在。</summary>
        public bool Unregister(string iface)
        {
            lock (_gate)
            {
                return _handlers.Remove(iface);
            }
        }

        /// <summary>查找处理器。</summary>
        public bool TryGet(string iface, out Action<VisualBridgeDebugRequest> handler)
        {
            lock (_gate)
            {
                return _handlers.TryGetValue(iface, out handler);
            }
        }
    }
}
#endif
