using System;
using System.Collections.Generic;

namespace VisualBridge.Diagnostics
{
    /// <summary>
    /// 从对端收到的一条查询请求（附录 A.5 的 <c>request</c> 信封 + 已解码的 args）。
    /// 由传输层在 socket 读线程解析后交给 <see cref="VisualBridgeDebugQueryRuntime.TryEnqueue"/>：
    /// 运行期只做校验与入队，业务实现一律在主线程 pump 里执行。
    /// </summary>
    public sealed class VisualBridgeDebugQueryRequest
    {
        private static readonly VisualBridgeDebugQueryArgument[] NoArguments = new VisualBridgeDebugQueryArgument[0];

        public VisualBridgeDebugQueryRequest(uint requestSeq, string category, string instanceId, ushort methodId,
            string interfaceId, string method, IReadOnlyList<VisualBridgeDebugQueryArgument> arguments)
            : this(requestSeq, category, instanceId, 0, methodId, interfaceId, method, arguments)
        {
        }

        public VisualBridgeDebugQueryRequest(uint requestSeq, string category, string instanceId, ushort instanceSlot,
            ushort methodId, string interfaceId, string method, IReadOnlyList<VisualBridgeDebugQueryArgument> arguments)
        {
            RequestSeq = requestSeq;
            Category = category;
            InstanceId = instanceId;
            InstanceSlot = instanceSlot;
            MethodId = methodId;
            InterfaceId = interfaceId;
            Method = method;
            Arguments = arguments ?? NoArguments;
        }

        /// <summary>信封里的请求号（JSON 为 <c>"req-&lt;n&gt;"</c>，二进制为 u32）。</summary>
        public uint RequestSeq { get; }

        /// <summary>分类名；缺省时运行期用槽位绑定的分类补齐。</summary>
        public string Category { get; }

        /// <summary>目标实例；必须已 <c>Create</c> 且未 <c>Finish</c>。</summary>
        public string InstanceId { get; }

        /// <summary>二进制信封里的实例槽位；0 表示缺省（JSON 信封没有该字段），由实例 id 反查。</summary>
        public ushort InstanceSlot { get; }

        /// <summary>方法号（分类内唯一，附录 B.5）。</summary>
        public ushort MethodId { get; }

        /// <summary>接口 id（JSON 信封 <c>iface</c>）；缺省时按分类内方法号唯一性反查注册表。</summary>
        public string InterfaceId { get; }

        /// <summary>方法名（JSON 信封 <c>method</c>）；只用于诊断，不参与分发。</summary>
        public string Method { get; }

        /// <summary>载荷参数（按 tag 匹配生成代码的声明表，不要求顺序）。</summary>
        public IReadOnlyList<VisualBridgeDebugQueryArgument> Arguments { get; }
    }
}
