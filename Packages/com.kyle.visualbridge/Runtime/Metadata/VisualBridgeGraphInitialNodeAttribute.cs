using System;

namespace VisualBridge.Runtime
{
    /// <summary>GraphType 的初始节点声明。</summary>
    [AttributeUsage(AttributeTargets.Class, AllowMultiple = true, Inherited = false)]
    public sealed class VisualBridgeGraphInitialNodeAttribute : Attribute
    {
        public VisualBridgeGraphInitialNodeAttribute(string nodeTypeId)
        {
            NodeTypeId = nodeTypeId;
        }

        public string NodeTypeId { get; }

        public string Title { get; set; }
    }
}
