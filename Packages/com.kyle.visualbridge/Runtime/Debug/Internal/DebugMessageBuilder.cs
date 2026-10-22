using System;
using System.Collections.Generic;

namespace VisualBridge.Debug
{
    /// <summary>线程本地的单条消息构建器。</summary>
    internal sealed class DebugMessageBuilder
    {
        [ThreadStatic]
        private static DebugMessageBuilder t_current;

        private readonly List<DebugArgValue> _args = new List<DebugArgValue>();
        private bool _building;
        private DebugMessageKind _kind;
        private string _category;
        private string _instance;
        private int _version;
        private string _iface;
        private string _method;
        private string _requestId;
        private long _frame;

        /// <summary>当前线程的构建器。</summary>
        public static DebugMessageBuilder Current
        {
            get { return t_current ?? (t_current = new DebugMessageBuilder()); }
        }

        /// <summary>是否处于 Building 状态。</summary>
        public bool IsBuilding
        {
            get { return _building; }
        }

        /// <summary>
        /// 开始一条消息；返回 true 表示上一条尚未 End、已被丢弃。
        /// </summary>
        public bool Begin(
            string category,
            int version,
            string iface,
            string method,
            string instance,
            string requestId,
            long frame)
        {
            bool abandoned = _building;
            _building = true;
            _kind = requestId == null ? DebugMessageKind.Debug : DebugMessageKind.DebugResult;
            _category = category;
            _instance = instance ?? string.Empty;
            _version = version;
            _iface = iface;
            _method = method;
            _requestId = requestId;
            _frame = frame;
            _args.Clear();
            return abandoned;
        }

        /// <summary>追加一个参数；调用方保证处于 Building 状态。</summary>
        public void Add(DebugArgValue arg)
        {
            _args.Add(arg);
        }

        /// <summary>结束当前消息并回到 Idle；Seq 由队列分配，故此处写 0。</summary>
        public DebugMessageHeader End(out DebugArgsBody body)
        {
            var header = new DebugMessageHeader(
                _kind, _category, _instance, _version, _iface, _method, _requestId, 0, _frame);
            body = new DebugArgsBody(_args.ToArray());
            _building = false;
            _args.Clear();
            _category = null;
            _instance = string.Empty;
            _iface = null;
            _method = null;
            _requestId = null;
            _frame = -1;
            return header;
        }
    }
}
