using System;
using System.Collections.Generic;

namespace VisualBridge.Diagnostics
{
#if UNITY_EDITOR || VISUALBRIDGE_RUNTIME_BRIDGE
    /// <summary>
    /// 一次连接会话的只读快照：实例集合、槽位映射、槽位绑定的分类与连接态。
    /// 只整体替换、不原地修改，因此 <see cref="VisualBridgeDebugSession.Start"/> 一次 volatile 读即可无锁访问。
    /// 槽位 → 分类是 debugResult 补全 JSON 信封的唯一依据（附录 A.4 的 slot → instance → category 路由）。
    /// </summary>
    internal sealed class VisualBridgeDebugSnapshot
    {
        internal static readonly VisualBridgeDebugSnapshot Disconnected = new VisualBridgeDebugSnapshot(
            new HashSet<string>(StringComparer.Ordinal),
            new Dictionary<string, ushort>(StringComparer.Ordinal),
            new Dictionary<ushort, string>(),
            false);

        internal VisualBridgeDebugSnapshot(HashSet<string> instances, Dictionary<string, ushort> slots,
            Dictionary<ushort, string> categories, bool connected)
        {
            Instances = instances;
            Slots = slots;
            Categories = categories;
            Connected = connected;
        }

        /// <summary>实例 id 集合；键比较始终是 <see cref="StringComparer.Ordinal"/>。</summary>
        internal HashSet<string> Instances { get; }

        /// <summary>实例 id → 槽位（0 表示未分配，正常运行不会出现）。</summary>
        internal Dictionary<string, ushort> Slots { get; }

        /// <summary>槽位 → 实例分类；Create 时绑定，Finish 时移除。</summary>
        internal Dictionary<ushort, string> Categories { get; }

        /// <summary>该快照所属会话是否处于已连接状态。</summary>
        internal bool Connected { get; }

        /// <summary>复用集合、只翻转连接态；集合本身按不可变语义使用。</summary>
        internal VisualBridgeDebugSnapshot WithConnected(bool connected)
        {
            return new VisualBridgeDebugSnapshot(Instances, Slots, Categories, connected);
        }

        /// <summary>取槽位绑定的分类；未知槽位返回 null（debugResult 仍可只靠 requestId 关联）。</summary>
        internal string GetCategory(ushort instanceSlot)
        {
            return Categories.TryGetValue(instanceSlot, out var category) ? category : null;
        }
    }
#endif
}
