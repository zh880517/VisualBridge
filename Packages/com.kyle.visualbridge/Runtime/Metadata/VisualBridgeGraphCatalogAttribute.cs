using System;

namespace VisualBridge.Runtime
{
    /// <summary>程序集级 Graph Catalog 声明（每个程序集一个 graph catalog）。</summary>
    [AttributeUsage(AttributeTargets.Assembly, Inherited = false)]
    public sealed class VisualBridgeGraphCatalogAttribute : Attribute
    {
        public VisualBridgeGraphCatalogAttribute(string catalogId, string title)
        {
            CatalogId = catalogId;
            Title = title;
        }

        public string CatalogId { get; }

        public string Title { get; }
    }
}
