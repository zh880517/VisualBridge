using System;

namespace VisualBridge.Runtime
{
    [AttributeUsage(AttributeTargets.Class | AttributeTargets.Struct, Inherited = false)]
    public sealed class VisualBridgeStructuredConfigAttribute : Attribute
    {
        public VisualBridgeStructuredConfigAttribute(string catalogId, string id, string title)
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
    }
}
