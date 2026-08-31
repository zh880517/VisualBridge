using System;

namespace VisualBridge.Runtime
{
    /// <summary>动态端口组声明；字段必须是 List&lt;T&gt;，item 由元素类型经共享字段模型推导。</summary>
    [AttributeUsage(AttributeTargets.Field, Inherited = false)]
    public sealed class VisualBridgeDynamicPortGroupAttribute : Attribute
    {
        public VisualBridgeDynamicPortGroupAttribute(string id, string title, VisualBridgePortDirection direction)
        {
            Id = id;
            Title = title;
            Direction = direction;
        }

        public string Id { get; }

        public string Title { get; }

        public VisualBridgePortDirection Direction { get; }

        public string[] Aliases { get; set; } = Array.Empty<string>();

        public string Description { get; set; }

        public VisualBridgeListPortMode ListPortMode { get; set; } = VisualBridgeListPortMode.List;

        public string DataTypeId { get; set; }

        /// <summary>0 表示省略。</summary>
        public int MaxItems { get; set; }
    }
}
