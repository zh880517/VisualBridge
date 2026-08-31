using System.Collections.Generic;
using VisualBridge.Runtime;

[assembly: VisualBridgeGraphCatalog("sample.unity.graph", "Unity Gameplay Graphs")]
[assembly: VisualBridgeGraphDataType("int", "Integer")]
[assembly: VisualBridgeGraphDataType("bool", "Boolean")]
[assembly: VisualBridgeGraphDataType("string", "Text")]
[assembly: VisualBridgeGraphDataType("list.string", "Text List")]

namespace VisualBridge.Sample
{
    [VisualBridgeGraphType(
        "sample.unity.graph",
        "sample.unity.encounter",
        "Encounter",
        Usage = VisualBridgeGraphUsage.Root,
        SupportedCatalogIds = new[] { "sample.unity.graph" },
        PortConnectionInput = VisualBridgePortConnectionMode.Single,
        PortConnectionOutput = VisualBridgePortConnectionMode.Multiple,
        AllowedNodeTags = new[] { "sample.unity" },
        AllowSubgraphs = false)]
    public sealed class EncounterGraph
    {
        [VisualBridgeField("title", "Title", Order = 0, DefaultJson = "\"Encounter\"", Editor = VisualBridgeEditorKind.Text)]
        public string Title;
    }

    [VisualBridgeGraphType(
        "sample.unity.graph",
        "sample.unity.encounter.branch",
        "Encounter Branch",
        Usage = VisualBridgeGraphUsage.Subgraph,
        SupportedCatalogIds = new[] { "sample.unity.graph" },
        PortConnectionInput = VisualBridgePortConnectionMode.Single,
        PortConnectionOutput = VisualBridgePortConnectionMode.Multiple,
        AllowedNodeTags = new[] { "sample.unity" })]
    public sealed class EncounterBranchGraph
    {
        [VisualBridgeField("condition", "Condition", Order = 0, DefaultJson = "\"true\"", Editor = VisualBridgeEditorKind.Text)]
        public string Condition;
    }

    [VisualBridgeNodeType(
        "sample.unity.graph",
        "sample.unity.node.log",
        "Log Message",
        "Logic",
        Tags = new[] { "sample.unity" },
        MenuPath = new[] { "Logic", "Log" })]
    public sealed class LogNode
    {
        [VisualBridgeField("message", "Message", Order = 0, DefaultJson = "\"Hello\"", Editor = VisualBridgeEditorKind.Text)]
        public string Message;

        [VisualBridgePort("execIn", "Exec In", VisualBridgePortKind.Flow, VisualBridgePortDirection.Input)]
        public bool ExecIn;

        [VisualBridgePort("execOut", "Exec Out", VisualBridgePortKind.Flow, VisualBridgePortDirection.Output)]
        public bool ExecOut;
    }

    [VisualBridgeNodeType(
        "sample.unity.graph",
        "sample.unity.node.compare",
        "Compare Value",
        "Logic",
        Tags = new[] { "sample.unity" },
        MenuPath = new[] { "Logic", "Compare" })]
    public sealed class CompareNode
    {
        [VisualBridgeField("threshold", "Threshold", Order = 0, DefaultJson = "10", Editor = VisualBridgeEditorKind.Number, Integer = true)]
        public int Threshold;

        [VisualBridgePort("execIn", "Exec In", VisualBridgePortKind.Flow, VisualBridgePortDirection.Input)]
        public bool ExecIn;

        [VisualBridgePort("valueIn", "Value In", VisualBridgePortKind.Data, VisualBridgePortDirection.Input)]
        public int ValueIn;

        [VisualBridgePort("trueOut", "True Out", VisualBridgePortKind.Flow, VisualBridgePortDirection.Output)]
        public bool TrueOut;

        [VisualBridgePort("falseOut", "False Out", VisualBridgePortKind.Flow, VisualBridgePortDirection.Output)]
        public bool FalseOut;

        [VisualBridgePort("resultOut", "Result Out", VisualBridgePortKind.Data, VisualBridgePortDirection.Output)]
        public bool ResultOut;
    }

    [VisualBridgeNodeType(
        "sample.unity.graph",
        "sample.unity.node.message.list",
        "Message List",
        "Logic",
        Tags = new[] { "sample.unity" },
        MenuPath = new[] { "Logic", "Message List" })]
    public sealed class MessageListNode
    {
        [VisualBridgePort("execIn", "Exec In", VisualBridgePortKind.Flow, VisualBridgePortDirection.Input)]
        public bool ExecIn;

        [VisualBridgeDynamicPortGroup("messages", "Messages", VisualBridgePortDirection.Input, DataTypeId = "list.string")]
        public List<string> Messages;
    }

    [VisualBridgeNodeType(
        "sample.unity.graph",
        "sample.unity.node.encounter.branch",
        "Encounter Branch Call",
        "Subgraph",
        Tags = new[] { "sample.unity" },
        SubgraphGraphTypeIds = new[] { "sample.unity.encounter.branch" })]
    public sealed class EncounterBranchNode
    {
        [VisualBridgePort("dataIn", "Data In", VisualBridgePortKind.Data, VisualBridgePortDirection.Input)]
        public string DataIn;
    }
}
