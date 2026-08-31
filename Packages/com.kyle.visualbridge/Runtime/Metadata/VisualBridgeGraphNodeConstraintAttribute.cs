using System;

namespace VisualBridge.Runtime
{
    /// <summary>GraphType 的节点实例约束；V1 仅支持 nodeTypeId 形态的 selector。</summary>
    [AttributeUsage(AttributeTargets.Class, AllowMultiple = true, Inherited = false)]
    public sealed class VisualBridgeGraphNodeConstraintAttribute : Attribute
    {
        public VisualBridgeGraphNodeConstraintAttribute(string id, string nodeTypeId)
        {
            Id = id;
            NodeTypeId = nodeTypeId;
        }

        public string Id { get; }

        public string NodeTypeId { get; }

        /// <summary>未设置用 -1 表示，导出时小于 0 即省略。</summary>
        public int MinInstances { get; set; } = -1;

        /// <summary>未设置用 -1 表示，导出时小于 0 即省略。</summary>
        public int MaxInstances { get; set; } = -1;
    }
}
