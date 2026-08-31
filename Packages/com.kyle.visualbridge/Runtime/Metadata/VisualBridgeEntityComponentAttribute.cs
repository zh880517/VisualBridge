using System;

namespace VisualBridge.Runtime
{
    [AttributeUsage(AttributeTargets.Class | AttributeTargets.Struct, Inherited = false)]
    public sealed class VisualBridgeEntityComponentAttribute : Attribute
    {
        public VisualBridgeEntityComponentAttribute(string catalogId, string id, string title, string groupId)
        {
            CatalogId = catalogId;
            Id = id;
            Title = title;
            GroupId = groupId;
        }

        public string CatalogId { get; }

        public string Id { get; }

        public string Title { get; }

        public string GroupId { get; }

        public string[] Aliases { get; set; } = Array.Empty<string>();

        public string Description { get; set; }

        public string[] MenuPath { get; set; } = Array.Empty<string>();
    }
}
