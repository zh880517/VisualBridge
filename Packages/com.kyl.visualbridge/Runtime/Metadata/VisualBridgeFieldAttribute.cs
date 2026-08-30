using System;

namespace Kyl.VisualBridge
{
    [AttributeUsage(AttributeTargets.Field, Inherited = false)]
    public sealed class VisualBridgeFieldAttribute : Attribute
    {
        public VisualBridgeFieldAttribute(string id, string title)
        {
            Id = id;
            Title = title;
        }

        public string Id { get; }

        public string Title { get; }

        public string[] Aliases { get; set; } = Array.Empty<string>();

        public string Description { get; set; }

        public int Order { get; set; }

        public string DataTypeId { get; set; }

        public string DefaultJson { get; set; }

        public VisualBridgeEditorKind Editor { get; set; } = VisualBridgeEditorKind.Auto;

        public bool ReadOnly { get; set; }

        public bool Integer { get; set; }

        public double Min { get; set; } = double.NaN;

        public double Max { get; set; } = double.NaN;

        public double Step { get; set; } = double.NaN;

        public string ReferenceKind { get; set; }

        public string ReferenceTargetJson { get; set; }

        public bool AllowMissingReference { get; set; }
    }
}
