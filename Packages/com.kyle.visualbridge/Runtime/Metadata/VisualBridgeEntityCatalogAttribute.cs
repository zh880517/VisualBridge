using System;

namespace VisualBridge.Runtime
{
    [AttributeUsage(AttributeTargets.Assembly, Inherited = false)]
    public sealed class VisualBridgeEntityCatalogAttribute : Attribute
    {
        public VisualBridgeEntityCatalogAttribute(string catalogId, string title)
        {
            CatalogId = catalogId;
            Title = title;
        }

        public string CatalogId { get; }

        public string Title { get; }
    }
}
