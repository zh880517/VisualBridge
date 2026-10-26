using System;
using System.Collections.Generic;

namespace VisualBridge.Diagnostics
{
#if UNITY_EDITOR || VISUALBRIDGE_RUNTIME_BRIDGE
    /// <summary>
    /// 一次连接会话的只读快照：实例集合、槽位映射与连接态。
    /// 只整体替换、不原地修改，因此 <see cref="VisualBridgeDebugSession.Start"/> 一次 volatile 读即可无锁访问。
    /// </summary>
    internal sealed class VisualBridgeDebugSnapshot
    {
        internal static readonly VisualBridgeDebugSnapshot Disconnected = new VisualBridgeDebugSnapshot(
            new HashSet<string>(StringComparer.Ordinal),
            new Dictionary<string, ushort>(StringComparer.Ordinal),
            false);

        internal VisualBridgeDebugSnapshot(HashSet<string> instances, Dictionary<string, ushort> slots, bool connected)
        {
            Instances = instances;
            Slots = slots;
            Connected = connected;
        }

        /// <summary>实例 id 集合；键比较始终是 <see cref="StringComparer.Ordinal"/>。</summary>
        internal HashSet<string> Instances { get; }

        /// <summary>实例 id → 槽位（0 表示未分配，正常运行不会出现）。</summary>
        internal Dictionary<string, ushort> Slots { get; }

        /// <summary>该快照所属会话是否处于已连接状态。</summary>
        internal bool Connected { get; }

        /// <summary>复用集合、只翻转连接态；集合本身按不可变语义使用。</summary>
        internal VisualBridgeDebugSnapshot WithConnected(bool connected)
        {
            return new VisualBridgeDebugSnapshot(Instances, Slots, connected);
        }
    }
#endif
}
