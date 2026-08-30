using System;

namespace Kyl.VisualBridge
{
    [AttributeUsage(AttributeTargets.Assembly, AllowMultiple = true)]
    public sealed class VisualBridgeStructuredCatalogAttribute : Attribute
    {
        public VisualBridgeStructuredCatalogAttribute(string catalogId, string title)
        {
            CatalogId = catalogId;
            Title = title;
        }

        public string CatalogId { get; }

        public string Title { get; }
    }
}
