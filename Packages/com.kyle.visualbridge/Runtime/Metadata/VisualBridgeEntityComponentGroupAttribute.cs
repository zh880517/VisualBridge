using System;

namespace VisualBridge.Runtime
{
    [AttributeUsage(AttributeTargets.Assembly, AllowMultiple = true, Inherited = false)]
    public sealed class VisualBridgeEntityComponentGroupAttribute : Attribute
    {
        public VisualBridgeEntityComponentGroupAttribute(string catalogId, string id, string title)
        {
            CatalogId = catalogId;
            Id = id;
            Title = title;
        }

        public string CatalogId { get; }

        public string Id { get; }

        public string Title { get; }

        public string[] Aliases { get; set; } = Array.Empty<string>();
    }
}
