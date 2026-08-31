using System;

namespace VisualBridge.Runtime
{
    /// <summary>NodeType 声明；带 SubgraphGraphTypeIds 时导出 subgraph 契约。</summary>
    [AttributeUsage(AttributeTargets.Class | AttributeTargets.Struct, Inherited = false)]
    public sealed class VisualBridgeNodeTypeAttribute : Attribute
    {
        public VisualBridgeNodeTypeAttribute(string catalogId, string id, string title, string category)
        {
            CatalogId = catalogId;
            Id = id;
            Title = title;
            Category = category;
        }

        public string CatalogId { get; }

        public string Id { get; }

        public string Title { get; }

        public string Category { get; }

        public string[] Aliases { get; set; } = Array.Empty<string>();

        public string Description { get; set; }

        public string Icon { get; set; }

        public string[] MenuPath { get; set; } = Array.Empty<string>();

        public string[] Tags { get; set; } = Array.Empty<string>();

        public string[] Traits { get; set; } = Array.Empty<string>();

        public string[] SubgraphGraphTypeIds { get; set; } = Array.Empty<string>();
    }
}
