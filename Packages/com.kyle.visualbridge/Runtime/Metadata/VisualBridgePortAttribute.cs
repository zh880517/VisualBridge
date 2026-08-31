using System;

namespace VisualBridge.Runtime
{
    /// <summary>静态端口声明；data 端口 DataTypeId 缺省时由 CLR 类型推导。</summary>
    [AttributeUsage(AttributeTargets.Field, Inherited = false)]
    public sealed class VisualBridgePortAttribute : Attribute
    {
        public VisualBridgePortAttribute(string id, string title, VisualBridgePortKind kind, VisualBridgePortDirection direction)
        {
            Id = id;
            Title = title;
            Kind = kind;
            Direction = direction;
        }

        public string Id { get; }

        public string Title { get; }

        public VisualBridgePortKind Kind { get; }

        public VisualBridgePortDirection Direction { get; }

        public string[] Aliases { get; set; } = Array.Empty<string>();

        public string Description { get; set; }

        public string DataTypeId { get; set; }

        /// <summary>0 表示省略（由通用连接规则决定）。</summary>
        public int MaxConnections { get; set; }
    }
}
