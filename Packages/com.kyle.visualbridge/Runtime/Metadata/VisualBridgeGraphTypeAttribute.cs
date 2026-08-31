using System;

namespace VisualBridge.Runtime
{
    /// <summary>GraphType 声明；约束与初始节点由同类型上的约束 attribute 补充。</summary>
    [AttributeUsage(AttributeTargets.Class | AttributeTargets.Struct, Inherited = false)]
    public sealed class VisualBridgeGraphTypeAttribute : Attribute
    {
        public VisualBridgeGraphTypeAttribute(string catalogId, string id, string title)
        {
            CatalogId = catalogId;
            Id = id;
            Title = title;
        }

        public string CatalogId { get; }

        public string Id { get; }

        public string Title { get; }

        public string[] Aliases { get; set; } = Array.Empty<string>();

        public string Description { get; set; }

        public VisualBridgeGraphUsage Usage { get; set; } = VisualBridgeGraphUsage.Any;

        public string[] SupportedCatalogIds { get; set; } = Array.Empty<string>();

        public VisualBridgePortConnectionMode PortConnectionInput { get; set; } = VisualBridgePortConnectionMode.Multiple;

        public VisualBridgePortConnectionMode PortConnectionOutput { get; set; } = VisualBridgePortConnectionMode.Multiple;

        public string[] AllowedNodeTypeIds { get; set; } = Array.Empty<string>();

        public string[] AllowedNodeTags { get; set; } = Array.Empty<string>();

        public string[] AllowedNodeTraits { get; set; } = Array.Empty<string>();

        public bool AllowSubgraphs { get; set; } = true;

        public string[] AllowedSubgraphTypeIds { get; set; } = Array.Empty<string>();
    }
}
