using System;

namespace VisualBridge.Runtime
{
    /// <summary>程序集级 Graph 数据类型声明，AllowMultiple；title 必填因此无法自动推导。</summary>
    [AttributeUsage(AttributeTargets.Assembly, AllowMultiple = true, Inherited = false)]
    public sealed class VisualBridgeGraphDataTypeAttribute : Attribute
    {
        public VisualBridgeGraphDataTypeAttribute(string id, string title)
        {
            Id = id;
            Title = title;
        }

        public string Id { get; }

        public string Title { get; }

        public string Color { get; set; }

        public bool AcceptsAnySource { get; set; }

        public string[] Accepts { get; set; } = Array.Empty<string>();
    }
}
