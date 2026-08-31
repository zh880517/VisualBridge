using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using VisualBridge.Runtime;
using VisualBridge.Editor;
using NUnit.Framework;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace VisualBridge.Editor.Tests
{
    // 本文件补充 Graph Compiler 专用测试类型（复用 Exporter 测试声明的 tests.visualbridge.graph
    // catalog 与既有 action/branch/subgraph 类型）；tests.compiler.flow 是无 selector 的宽松 root
    // graphType，承载正路径与多数负路径。
    [VisualBridgeGraphType(
        "tests.visualbridge.graph",
        "tests.compiler.flow",
        "Compiler Flow",
        Usage = VisualBridgeGraphUsage.Root,
        SupportedCatalogIds = new[] { "tests.visualbridge.graph" })]
    public sealed class GraphCompilerFlowGraphType
    {
        [VisualBridgeField("title", "Title", Order = 0, Aliases = new[] { "label" }, DefaultJson = "\"Compiled Flow\"", Editor = VisualBridgeEditorKind.Text)]
        public string Title;
    }

    [VisualBridgeGraphType(
        "tests.visualbridge.graph",
        "tests.compiler.single",
        "Compiler Single Output",
        Usage = VisualBridgeGraphUsage.Root,
        SupportedCatalogIds = new[] { "tests.visualbridge.graph" },
        PortConnectionOutput = VisualBridgePortConnectionMode.Single)]
    public sealed class GraphCompilerSingleGraphType
    {
    }

    [VisualBridgeGraphType(
        "tests.visualbridge.graph",
        "tests.compiler.constrained",
        "Compiler Constrained",
        Usage = VisualBridgeGraphUsage.Root,
        SupportedCatalogIds = new[] { "tests.visualbridge.graph" })]
    [VisualBridgeGraphNodeConstraint("tests.compiler.constraint.entry", "tests.node.action", MinInstances = 1)]
    [VisualBridgeGraphNodeConstraint("tests.compiler.constraint.limit", "tests.compiler.node.alias", MaxInstances = 1)]
    public sealed class GraphCompilerConstrainedGraphType
    {
    }

    // 与既有 tests.sub 区分的 subgraph graphType，用于 subgraphCallTypeMismatch 负路径。
    [VisualBridgeGraphType(
        "tests.visualbridge.graph",
        "tests.compiler.sub2",
        "Compiler Subgraph",
        Usage = VisualBridgeGraphUsage.Subgraph,
        SupportedCatalogIds = new[] { "tests.visualbridge.graph" })]
    public sealed class GraphCompilerSubgraphGraphType
    {
    }

    [VisualBridgeNodeType(
        "tests.visualbridge.graph",
        "tests.compiler.node.alias",
        "Aliased Action",
        "Logic",
        Aliases = new[] { "tests.compiler.node.legacy" },
        Tags = new[] { "tests.tag.core" })]
    public sealed class GraphCompilerAliasedNodeType
    {
        [VisualBridgePort("exec.in", "Exec In", VisualBridgePortKind.Flow, VisualBridgePortDirection.Input)]
        public bool ExecIn;

        [VisualBridgePort("exec.out", "Exec Out", VisualBridgePortKind.Flow, VisualBridgePortDirection.Output, Aliases = new[] { "run.out" })]
        public bool ExecOut;

        [VisualBridgeField("message", "Message", Order = 0, Aliases = new[] { "text" }, DefaultJson = "\"Hello\"", Editor = VisualBridgeEditorKind.Text)]
        public string Message;
    }

    // tags 不命中 tests.flow 的 selector，用于 nodeTypeNotAllowed 负路径。
    [VisualBridgeNodeType(
        "tests.visualbridge.graph",
        "tests.compiler.node.outsider",
        "Outsider",
        "Logic",
        Tags = new[] { "tests.compiler.tag.other" })]
    public sealed class GraphCompilerOutsiderNodeType
    {
        [VisualBridgePort("exec.in", "Exec In", VisualBridgePortKind.Flow, VisualBridgePortDirection.Input)]
        public bool ExecIn;

        [VisualBridgePort("exec.out", "Exec Out", VisualBridgePortKind.Flow, VisualBridgePortDirection.Output)]
        public bool ExecOut;
    }

    public sealed class VisualBridgeGraphCompilerTests
    {
        private static readonly UTF8Encoding Utf8WithoutBom = new UTF8Encoding(false);

        [Test]
        public void GenerateMaterializesDefaultsCanonicalizesAliasesAndIsDeterministic()
        {
            using (var fixture = new GraphCompilerFixture())
            {
                fixture.WriteValidDocument();

                var first = VisualBridgeGraphCompiler.Compile(fixture.Root, VisualBridgeGraphCompileMode.Generate);
                var firstSnapshot = first.Outputs.ToDictionary(output => output.Path, output => File.ReadAllBytes(output.Path));
                var second = VisualBridgeGraphCompiler.Compile(fixture.Root, VisualBridgeGraphCompileMode.Generate);

                Assert.That(first.DriftDetected, Is.True);
                Assert.That(second.DriftDetected, Is.False);
                Assert.That(second.Outputs.All(output => File.ReadAllBytes(output.Path).SequenceEqual(firstSnapshot[output.Path])), Is.True);

                var artifact = JObject.Parse(File.ReadAllText(fixture.ArtifactPath));
                Assert.That(artifact.Value<string>("kind"), Is.EqualTo("visualbridge.graph.compiled"));
                Assert.That(artifact.Value<string>("documentTypeId"), Is.EqualTo("tests.root"));
                var graphs = ((JArray)artifact["data"]["graphs"]).Cast<JObject>().ToList();
                Assert.That(graphs.Count, Is.EqualTo(1));
                Assert.That(graphs[0].Value<string>("id"), Is.EqualTo("root"));
                // graphTypeId 与缺失属性都以 canonical 形态物化。
                Assert.That(graphs[0].Value<string>("graphTypeId"), Is.EqualTo("tests.compiler.flow"));
                Assert.That(graphs[0]["properties"]["title"].Value<string>(), Is.EqualTo("Compiled Flow"));
                var nodes = ((JArray)graphs[0]["nodes"]).Cast<JObject>().ToList();
                Assert.That(nodes[0].Value<string>("id"), Is.EqualTo("welcome"));
                Assert.That(nodes[0].Value<string>("nodeTypeId"), Is.EqualTo("tests.compiler.node.alias"));
                Assert.That(nodes[0]["properties"]["message"].Value<string>(), Is.EqualTo("alias-value"));
                Assert.That(((JObject)nodes[0]["properties"]).Property("text"), Is.Null);
                Assert.That(File.ReadAllBytes(fixture.ArtifactPath).Last(), Is.EqualTo((byte)'\n'));

                var mapping = JObject.Parse(File.ReadAllText(fixture.MappingPath));
                var mappings = ((JArray)mapping["mappings"]).Cast<JObject>().ToList();
                var graphTitle = mappings.Single(entry => entry.Value<string>("artifactPath") == "data.graphs[0].properties.title");
                Assert.That(graphTitle.Value<string>("origin"), Is.EqualTo("metadataDefault"));
                Assert.That(graphTitle.Property("sourcePath"), Is.Null);
                var nodeMessage = mappings.Single(entry => entry.Value<string>("artifactPath") == "data.graphs[0].nodes[0].properties.message");
                Assert.That(nodeMessage.Value<string>("origin"), Is.EqualTo("document"));
                Assert.That(nodeMessage.Value<string>("sourcePath"), Is.EqualTo("graphs[root].nodes[welcome].properties.text"));
            }
        }

        [Test]
        public void CheckDetectsDriftWithoutWriting()
        {
            using (var fixture = new GraphCompilerFixture())
            {
                fixture.WriteValidDocument();
                VisualBridgeGraphCompiler.Compile(fixture.Root, VisualBridgeGraphCompileMode.Generate);
                var drift = Utf8WithoutBom.GetBytes("{}\n");
                File.WriteAllBytes(fixture.ArtifactPath, drift);

                var result = VisualBridgeGraphCompiler.Compile(fixture.Root, VisualBridgeGraphCompileMode.Check);

                Assert.That(result.DriftDetected, Is.True);
                Assert.That(File.ReadAllBytes(fixture.ArtifactPath), Is.EqualTo(drift));
                Assert.That(Directory.GetFiles(fixture.OutputRoot, "*.tmp", SearchOption.AllDirectories), Is.Empty);
            }
        }

        [Test]
        public void StaleOutputsAreRemovedOnGenerateAndKeptOnCheck()
        {
            using (var fixture = new GraphCompilerFixture())
            {
                fixture.WriteValidDocument();
                VisualBridgeGraphCompiler.Compile(fixture.Root, VisualBridgeGraphCompileMode.Generate);
                File.Delete(fixture.DocumentPath);

                var check = VisualBridgeGraphCompiler.Compile(fixture.Root, VisualBridgeGraphCompileMode.Check);
                Assert.That(check.StaleOutputs, Is.Not.Empty);
                Assert.That(File.Exists(fixture.ArtifactPath), Is.True);

                var generate = VisualBridgeGraphCompiler.Compile(fixture.Root, VisualBridgeGraphCompileMode.Generate);
                Assert.That(generate.StaleOutputs, Is.Not.Empty);
                Assert.That(File.Exists(fixture.ArtifactPath), Is.False);
                Assert.That(File.Exists(fixture.MappingPath), Is.False);
                Assert.That(Directory.GetFiles(fixture.OutputRoot, "*.tmp", SearchOption.AllDirectories), Is.Empty);
            }
        }

        [Test]
        public void SubgraphHappyPathCompilesWithRootGraphFirst()
        {
            using (var fixture = new GraphCompilerFixture())
            {
                fixture.WriteDocument(
                    "{\n  \"formatVersion\": 3,\n  \"documentId\": \"tests.graph.default\",\n  \"rootGraphId\": \"root\",\n  \"graphs\": [\n"
                    + "    {\n      \"id\": \"root\",\n      \"graphTypeId\": \"tests.compiler.flow\",\n      \"title\": \"Root\",\n      \"properties\": {},\n"
                    + "      \"interfacePorts\": [],\n"
                    + "      \"nodes\": [\n"
                    + "        { \"kind\": \"node\", \"id\": \"a\", \"nodeTypeId\": \"tests.node.action\", \"title\": \"Action\", \"position\": { \"x\": 0, \"y\": 0 }, \"properties\": {}, \"dynamicPorts\": [] },\n"
                    + "        { \"kind\": \"subgraph\", \"id\": \"call\", \"nodeTypeId\": \"tests.node.subgraph\", \"subgraphId\": \"child\", \"title\": \"Call\", \"position\": { \"x\": 200, \"y\": 0 }, \"properties\": {}, \"dynamicPorts\": [] }\n"
                    + "      ],\n"
                    + "      \"edges\": [\n"
                    + "        { \"id\": \"e1\", \"kind\": \"data\", \"source\": { \"kind\": \"node\", \"nodeId\": \"a\", \"portId\": \"label.out\" }, \"target\": { \"kind\": \"node\", \"nodeId\": \"call\", \"portId\": \"param\" } }\n"
                    + "      ]\n    },\n"
                    + "    {\n      \"id\": \"child\",\n      \"graphTypeId\": \"tests.sub\", \"title\": \"Child\", \"properties\": {},\n"
                    + "      \"interfacePorts\": [ { \"id\": \"param\", \"title\": \"Param\", \"kind\": \"data\", \"direction\": \"input\", \"dataTypeId\": \"string\" } ],\n"
                    + "      \"nodes\": [],\n      \"edges\": []\n    }\n"
                    + "  ]\n}\n");

                var result = VisualBridgeGraphCompiler.Compile(fixture.Root, VisualBridgeGraphCompileMode.Generate);
                Assert.That(result.DriftDetected, Is.True);

                var artifact = JObject.Parse(File.ReadAllText(fixture.ArtifactPath));
                var graphs = ((JArray)artifact["data"]["graphs"]).Cast<JObject>().ToList();
                // root 图排最前，其余按 id。
                Assert.That(graphs.Select(graph => graph.Value<string>("id")).ToArray(), Is.EqualTo(new[] { "root", "child" }));
                var rootNodes = ((JArray)graphs[0]["nodes"]).Cast<JObject>().ToList();
                Assert.That(rootNodes.Select(node => node.Value<string>("id")).ToArray(), Is.EqualTo(new[] { "a", "call" }));
                Assert.That(rootNodes[1].Value<string>("subgraphId"), Is.EqualTo("child"));
                Assert.That(rootNodes[1].Value<string>("nodeTypeId"), Is.EqualTo("tests.node.subgraph"));
                var edges = ((JArray)graphs[0]["edges"]).Cast<JObject>().ToList();
                Assert.That(edges[0]["target"].Value<string>("portId"), Is.EqualTo("param"));
                var childPorts = ((JArray)graphs[1]["interfacePorts"]).Cast<JObject>().ToList();
                Assert.That(childPorts[0].Value<string>("id"), Is.EqualTo("param"));
                Assert.That(childPorts[0].Value<string>("dataTypeId"), Is.EqualTo("string"));
            }
        }

        [Test]
        public void FailedGeneratePreservesLastValidOutputsAndAuthoringBytes()
        {
            using (var fixture = new GraphCompilerFixture())
            {
                fixture.WriteValidDocument();
                var generated = VisualBridgeGraphCompiler.Compile(fixture.Root, VisualBridgeGraphCompileMode.Generate);
                var before = generated.Outputs.ToDictionary(output => output.Path, output => File.ReadAllBytes(output.Path));
                var invalid = Utf8WithoutBom.GetBytes(
                    "{\n  \"formatVersion\": 3,\n  \"documentId\": \"tests.graph.default\",\n  \"rootGraphId\": \"root\",\n  \"graphs\": [\n"
                    + "    { \"id\": \"root\", \"graphTypeId\": \"tests.compiler.flow\", \"title\": \"Root\", \"properties\": {}, \"interfacePorts\": [],\n"
                    + "      \"nodes\": [ { \"kind\": \"node\", \"id\": \"welcome\", \"nodeTypeId\": \"tests.compiler.node.alias\", \"title\": \"Welcome\", \"position\": { \"x\": 0, \"y\": 0 }, \"properties\": { \"message\": 5 }, \"dynamicPorts\": [] } ],\n"
                    + "      \"edges\": [] }\n  ]\n}\n");
                File.WriteAllBytes(fixture.DocumentPath, invalid);

                var exception = Assert.Throws<VisualBridgeIntegrationException>(() =>
                    VisualBridgeGraphCompiler.Compile(fixture.Root, VisualBridgeGraphCompileMode.Generate));

                Assert.That(exception.Code, Is.EqualTo("compile.typeMismatch"));
                Assert.That(before.All(entry => File.ReadAllBytes(entry.Key).SequenceEqual(entry.Value)), Is.True);
                Assert.That(File.ReadAllBytes(fixture.DocumentPath), Is.EqualTo(invalid));
            }
        }

        [Test]
        public void UnsupportedDocumentVersionFailsClosed()
        {
            using (var fixture = new GraphCompilerFixture())
            {
                fixture.WriteDocument(
                    "{\n  \"formatVersion\": 2,\n  \"documentId\": \"tests.graph.default\",\n  \"rootGraphId\": \"root\",\n"
                    + "  \"graphs\": [ { \"id\": \"root\", \"graphTypeId\": \"tests.compiler.flow\", \"title\": \"Root\", \"properties\": {}, \"interfacePorts\": [], \"nodes\": [], \"edges\": [] } ]\n}\n");

                var exception = Assert.Throws<VisualBridgeIntegrationException>(() =>
                    VisualBridgeGraphCompiler.Compile(fixture.Root, VisualBridgeGraphCompileMode.Check));

                Assert.That(exception.Code, Is.EqualTo("compile.documentUnsupportedVersion"));
            }
        }

        [Test]
        public void UnknownGraphTypeFailsClosed()
        {
            using (var fixture = new GraphCompilerFixture())
            {
                fixture.WriteDocument(RootGraph("tests.missing.graph", "[]", "[]"));

                var exception = Assert.Throws<VisualBridgeIntegrationException>(() =>
                    VisualBridgeGraphCompiler.Compile(fixture.Root, VisualBridgeGraphCompileMode.Check));

                Assert.That(exception.Code, Is.EqualTo("compile.graphTypeUnknown"));
            }
        }

        [Test]
        public void UnknownNodeTypeFailsClosed()
        {
            using (var fixture = new GraphCompilerFixture())
            {
                fixture.WriteDocument(RootGraph(
                    "tests.compiler.flow",
                    "[ { \"kind\": \"node\", \"id\": \"a\", \"nodeTypeId\": \"tests.missing.node\", \"title\": \"A\", \"position\": { \"x\": 0, \"y\": 0 }, \"properties\": {}, \"dynamicPorts\": [] } ]",
                    "[]"));

                var exception = Assert.Throws<VisualBridgeIntegrationException>(() =>
                    VisualBridgeGraphCompiler.Compile(fixture.Root, VisualBridgeGraphCompileMode.Check));

                Assert.That(exception.Code, Is.EqualTo("compile.nodeTypeUnknown"));
            }
        }

        [Test]
        public void NodeTypeNotAllowedFailsClosed()
        {
            using (var fixture = new GraphCompilerFixture())
            {
                fixture.WriteDocument(RootGraph(
                    "tests.flow",
                    "[ { \"kind\": \"node\", \"id\": \"a\", \"nodeTypeId\": \"tests.compiler.node.outsider\", \"title\": \"A\", \"position\": { \"x\": 0, \"y\": 0 }, \"properties\": {}, \"dynamicPorts\": [] } ]",
                    "[]"));

                var exception = Assert.Throws<VisualBridgeIntegrationException>(() =>
                    VisualBridgeGraphCompiler.Compile(fixture.Root, VisualBridgeGraphCompileMode.Check));

                Assert.That(exception.Code, Is.EqualTo("compile.nodeTypeNotAllowed"));
            }
        }

        [Test]
        public void InvalidSourceDirectionFailsClosed()
        {
            using (var fixture = new GraphCompilerFixture())
            {
                fixture.WriteDocument(RootGraph(
                    "tests.compiler.flow",
                    "[ { \"kind\": \"node\", \"id\": \"a\", \"nodeTypeId\": \"tests.node.action\", \"title\": \"A\", \"position\": { \"x\": 0, \"y\": 0 }, \"properties\": {}, \"dynamicPorts\": [] } ]",
                    "[ { \"id\": \"e1\", \"kind\": \"flow\", \"source\": { \"kind\": \"node\", \"nodeId\": \"a\", \"portId\": \"exec.in\" }, \"target\": { \"kind\": \"node\", \"nodeId\": \"a\", \"portId\": \"exec.in\" } } ]"));

                var exception = Assert.Throws<VisualBridgeIntegrationException>(() =>
                    VisualBridgeGraphCompiler.Compile(fixture.Root, VisualBridgeGraphCompileMode.Check));

                Assert.That(exception.Code, Is.EqualTo("compile.invalidSourceDirection"));
            }
        }

        [Test]
        public void EdgeKindMismatchFailsClosed()
        {
            using (var fixture = new GraphCompilerFixture())
            {
                fixture.WriteDocument(RootGraph(
                    "tests.compiler.flow",
                    "[ { \"kind\": \"node\", \"id\": \"a\", \"nodeTypeId\": \"tests.node.action\", \"title\": \"A\", \"position\": { \"x\": 0, \"y\": 0 }, \"properties\": {}, \"dynamicPorts\": [] } ]",
                    "[ { \"id\": \"e1\", \"kind\": \"flow\", \"source\": { \"kind\": \"node\", \"nodeId\": \"a\", \"portId\": \"label.out\" }, \"target\": { \"kind\": \"node\", \"nodeId\": \"a\", \"portId\": \"exec.in\" } } ]"));

                var exception = Assert.Throws<VisualBridgeIntegrationException>(() =>
                    VisualBridgeGraphCompiler.Compile(fixture.Root, VisualBridgeGraphCompileMode.Check));

                Assert.That(exception.Code, Is.EqualTo("compile.edgeKindMismatch"));
            }
        }

        [Test]
        public void DataTypeMismatchFailsClosed()
        {
            using (var fixture = new GraphCompilerFixture())
            {
                fixture.WriteDocument(RootGraph(
                    "tests.compiler.flow",
                    "[ { \"kind\": \"node\", \"id\": \"a\", \"nodeTypeId\": \"tests.node.action\", \"title\": \"A\", \"position\": { \"x\": 0, \"y\": 0 }, \"properties\": {}, \"dynamicPorts\": [] } ]",
                    "[ { \"id\": \"e1\", \"kind\": \"data\", \"source\": { \"kind\": \"node\", \"nodeId\": \"a\", \"portId\": \"label.out\" }, \"target\": { \"kind\": \"node\", \"nodeId\": \"a\", \"portId\": \"count.in\" } } ]"));

                var exception = Assert.Throws<VisualBridgeIntegrationException>(() =>
                    VisualBridgeGraphCompiler.Compile(fixture.Root, VisualBridgeGraphCompileMode.Check));

                Assert.That(exception.Code, Is.EqualTo("compile.dataTypeMismatch"));
            }
        }

        [Test]
        public void TooManyConnectionsFailsClosed()
        {
            using (var fixture = new GraphCompilerFixture())
            {
                fixture.WriteDocument(RootGraph(
                    "tests.compiler.single",
                    "["
                    + " { \"kind\": \"node\", \"id\": \"b\", \"nodeTypeId\": \"tests.node.branch\", \"title\": \"B\", \"position\": { \"x\": 0, \"y\": 0 }, \"properties\": {}, \"dynamicPorts\": [] },"
                    + " { \"kind\": \"node\", \"id\": \"a1\", \"nodeTypeId\": \"tests.node.action\", \"title\": \"A1\", \"position\": { \"x\": 100, \"y\": 0 }, \"properties\": {}, \"dynamicPorts\": [] },"
                    + " { \"kind\": \"node\", \"id\": \"a2\", \"nodeTypeId\": \"tests.node.action\", \"title\": \"A2\", \"position\": { \"x\": 200, \"y\": 0 }, \"properties\": {}, \"dynamicPorts\": [] }"
                    + "]",
                    "["
                    + " { \"id\": \"e1\", \"kind\": \"flow\", \"source\": { \"kind\": \"node\", \"nodeId\": \"b\", \"portId\": \"exec.out\" }, \"target\": { \"kind\": \"node\", \"nodeId\": \"a1\", \"portId\": \"exec.in\" } },"
                    + " { \"id\": \"e2\", \"kind\": \"flow\", \"source\": { \"kind\": \"node\", \"nodeId\": \"b\", \"portId\": \"exec.out\" }, \"target\": { \"kind\": \"node\", \"nodeId\": \"a2\", \"portId\": \"exec.in\" } }"
                    + "]"));

                var exception = Assert.Throws<VisualBridgeIntegrationException>(() =>
                    VisualBridgeGraphCompiler.Compile(fixture.Root, VisualBridgeGraphCompileMode.Check));

                Assert.That(exception.Code, Is.EqualTo("compile.tooManyConnections"));
            }
        }

        [Test]
        public void SubgraphCallTypeMismatchFailsClosed()
        {
            using (var fixture = new GraphCompilerFixture())
            {
                fixture.WriteDocument(
                    "{\n  \"formatVersion\": 3,\n  \"documentId\": \"tests.graph.default\",\n  \"rootGraphId\": \"root\",\n  \"graphs\": [\n"
                    + "    { \"id\": \"root\", \"graphTypeId\": \"tests.compiler.flow\", \"title\": \"Root\", \"properties\": {}, \"interfacePorts\": [],\n"
                    + "      \"nodes\": [ { \"kind\": \"subgraph\", \"id\": \"call\", \"nodeTypeId\": \"tests.node.subgraph\", \"subgraphId\": \"child\", \"title\": \"Call\", \"position\": { \"x\": 0, \"y\": 0 }, \"properties\": {}, \"dynamicPorts\": [] } ],\n"
                    + "      \"edges\": [] },\n"
                    + "    { \"id\": \"child\", \"graphTypeId\": \"tests.compiler.sub2\", \"title\": \"Child\", \"properties\": {}, \"interfacePorts\": [], \"nodes\": [], \"edges\": [] }\n"
                    + "  ]\n}\n");

                var exception = Assert.Throws<VisualBridgeIntegrationException>(() =>
                    VisualBridgeGraphCompiler.Compile(fixture.Root, VisualBridgeGraphCompileMode.Check));

                Assert.That(exception.Code, Is.EqualTo("compile.subgraphCallTypeMismatch"));
            }
        }

        [Test]
        public void TooFewNodeInstancesFailsClosed()
        {
            using (var fixture = new GraphCompilerFixture())
            {
                fixture.WriteDocument(RootGraph(
                    "tests.compiler.constrained",
                    "[ { \"kind\": \"node\", \"id\": \"n\", \"nodeTypeId\": \"tests.compiler.node.alias\", \"title\": \"N\", \"position\": { \"x\": 0, \"y\": 0 }, \"properties\": {}, \"dynamicPorts\": [] } ]",
                    "[]"));

                var exception = Assert.Throws<VisualBridgeIntegrationException>(() =>
                    VisualBridgeGraphCompiler.Compile(fixture.Root, VisualBridgeGraphCompileMode.Check));

                Assert.That(exception.Code, Is.EqualTo("compile.tooFewNodeInstances"));
            }
        }

        [Test]
        public void TooManyNodeInstancesFailsClosed()
        {
            using (var fixture = new GraphCompilerFixture())
            {
                fixture.WriteDocument(RootGraph(
                    "tests.compiler.constrained",
                    "["
                    + " { \"kind\": \"node\", \"id\": \"a\", \"nodeTypeId\": \"tests.node.action\", \"title\": \"A\", \"position\": { \"x\": 0, \"y\": 0 }, \"properties\": {}, \"dynamicPorts\": [] },"
                    + " { \"kind\": \"node\", \"id\": \"n1\", \"nodeTypeId\": \"tests.compiler.node.alias\", \"title\": \"N1\", \"position\": { \"x\": 100, \"y\": 0 }, \"properties\": {}, \"dynamicPorts\": [] },"
                    + " { \"kind\": \"node\", \"id\": \"n2\", \"nodeTypeId\": \"tests.compiler.node.alias\", \"title\": \"N2\", \"position\": { \"x\": 200, \"y\": 0 }, \"properties\": {}, \"dynamicPorts\": [] }"
                    + "]",
                    "[]"));

                var exception = Assert.Throws<VisualBridgeIntegrationException>(() =>
                    VisualBridgeGraphCompiler.Compile(fixture.Root, VisualBridgeGraphCompileMode.Check));

                Assert.That(exception.Code, Is.EqualTo("compile.tooManyNodeInstances"));
            }
        }

        [Test]
        public void UnknownFieldFailsClosed()
        {
            using (var fixture = new GraphCompilerFixture())
            {
                fixture.WriteDocument(RootGraph(
                    "tests.compiler.flow",
                    "[ { \"kind\": \"node\", \"id\": \"n\", \"nodeTypeId\": \"tests.compiler.node.alias\", \"title\": \"N\", \"position\": { \"x\": 0, \"y\": 0 }, \"properties\": { \"totally.unknown\": 1 }, \"dynamicPorts\": [] } ]",
                    "[]"));

                var exception = Assert.Throws<VisualBridgeIntegrationException>(() =>
                    VisualBridgeGraphCompiler.Compile(fixture.Root, VisualBridgeGraphCompileMode.Check));

                Assert.That(exception.Code, Is.EqualTo("compile.unknownField"));
            }
        }

        [Test]
        public void DuplicateSemanticConnectionFailsClosed()
        {
            using (var fixture = new GraphCompilerFixture())
            {
                fixture.WriteDocument(RootGraph(
                    "tests.compiler.flow",
                    "[ { \"kind\": \"node\", \"id\": \"n\", \"nodeTypeId\": \"tests.compiler.node.alias\", \"title\": \"N\", \"position\": { \"x\": 0, \"y\": 0 }, \"properties\": {}, \"dynamicPorts\": [] } ]",
                    "["
                    + " { \"id\": \"e1\", \"kind\": \"flow\", \"source\": { \"kind\": \"node\", \"nodeId\": \"n\", \"portId\": \"exec.out\" }, \"target\": { \"kind\": \"node\", \"nodeId\": \"n\", \"portId\": \"exec.in\" } },"
                    + " { \"id\": \"e2\", \"kind\": \"flow\", \"source\": { \"kind\": \"node\", \"nodeId\": \"n\", \"portId\": \"run.out\" }, \"target\": { \"kind\": \"node\", \"nodeId\": \"n\", \"portId\": \"exec.in\" } }"
                    + "]"));

                var exception = Assert.Throws<VisualBridgeIntegrationException>(() =>
                    VisualBridgeGraphCompiler.Compile(fixture.Root, VisualBridgeGraphCompileMode.Check));

                Assert.That(exception.Code, Is.EqualTo("compile.duplicateSemanticConnection"));
            }
        }

        [Test]
        public void BatchExitCodesShareOneContract()
        {
            Assert.That(VisualBridgeGraphCompilerBatch.SuccessExitCode, Is.EqualTo(0));
            Assert.That(VisualBridgeGraphCompilerBatch.FailureExitCode, Is.EqualTo(1));
            Assert.That(VisualBridgeGraphCompilerBatch.DriftExitCode, Is.EqualTo(2));
            Assert.That(VisualBridgeGraphCompilerBatch.SuccessExitCode, Is.EqualTo(VisualBridgeStructuredCompilerBatch.SuccessExitCode));
            Assert.That(VisualBridgeGraphCompilerBatch.FailureExitCode, Is.EqualTo(VisualBridgeStructuredCompilerBatch.FailureExitCode));
            Assert.That(VisualBridgeGraphCompilerBatch.DriftExitCode, Is.EqualTo(VisualBridgeStructuredCompilerBatch.DriftExitCode));
        }

        private static string RootGraph(string graphTypeId, string nodes, string edges)
        {
            return "{\n  \"formatVersion\": 3,\n  \"documentId\": \"tests.graph.default\",\n  \"rootGraphId\": \"root\",\n  \"graphs\": [\n"
                + "    { \"id\": \"root\", \"graphTypeId\": \"" + graphTypeId + "\", \"title\": \"Root\", \"properties\": {}, \"interfacePorts\": [],\n"
                + "      \"nodes\": " + nodes + ",\n      \"edges\": " + edges + " }\n"
                + "  ]\n}\n";
        }

        private sealed class GraphCompilerFixture : IDisposable
        {
            public const string ProjectId = "tests.graph.project";

            public GraphCompilerFixture()
            {
                Root = Path.Combine(Path.GetTempPath(), "VisualBridgeGraphCompilerTests", Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(Path.Combine(Root, "ProjectSettings"));
                Directory.CreateDirectory(Path.Combine(Root, "Authoring", "Catalog"));
                Directory.CreateDirectory(Path.Combine(Root, "Authoring", "Graphs"));
                WriteProfile();
                WriteProject();
                VisualBridgeGraphCatalogExporter.Export(Root, VisualBridgeCatalogExportMode.Generate);
            }

            public string Root { get; }

            public string OutputRoot => Path.Combine(Root, "Library", "VisualBridge", "Compiled");

            public string DocumentPath => Path.Combine(Root, "Authoring", "Graphs", "Encounter.vbflow");

            public string ArtifactPath => Path.Combine(OutputRoot, "documents", ProjectId, "tests.root", "tests.graph.default.vbcompiled.json");

            public string MappingPath => Path.Combine(OutputRoot, "mappings", ProjectId, "tests.root", "tests.graph.default.vbsource.json");

            public string ManifestPath => Path.Combine(OutputRoot, "manifest.graph.json");

            public void WriteValidDocument()
            {
                WriteDocument(
                    "{\n  \"formatVersion\": 3,\n  \"documentId\": \"tests.graph.default\",\n  \"rootGraphId\": \"root\",\n  \"graphs\": [\n"
                    + "    {\n      \"id\": \"root\",\n      \"graphTypeId\": \"tests.compiler.flow\",\n      \"title\": \"Root\",\n      \"properties\": {},\n"
                    + "      \"interfacePorts\": [],\n"
                    + "      \"nodes\": [\n"
                    + "        { \"kind\": \"node\", \"id\": \"welcome\", \"nodeTypeId\": \"tests.compiler.node.legacy\", \"title\": \"Welcome\", \"position\": { \"x\": 80, \"y\": 80 }, \"properties\": { \"text\": \"alias-value\" }, \"dynamicPorts\": [] }\n"
                    + "      ],\n      \"edges\": []\n    }\n"
                    + "  ]\n}\n");
            }

            public void WriteDocument(string text)
            {
                File.WriteAllText(DocumentPath, text, Utf8WithoutBom);
            }

            public void Dispose()
            {
                if (Directory.Exists(Root))
                {
                    Directory.Delete(Root, true);
                }
            }

            private void WriteProfile()
            {
                var types = string.Join(",", DefaultRegisteredTypes().Select(JsonConvert.ToString));
                File.WriteAllText(
                    Path.Combine(Root, "ProjectSettings", "VisualBridgeIntegration.json"),
                    "{\n  \"formatVersion\": 1,\n  \"authoringProject\": \"Authoring/VisualBridge.project.vbjson\",\n  \"catalogExports\": [{\"catalogId\": \"tests.visualbridge.graph\""
                    + ", \"title\": \"VisualBridge Graph Exporter Tests\", \"output\": \"Authoring/Catalog/Test.vbgraphcatalog\", \"types\": [" + types + "]}],\n"
                    + "  \"compileOutputRoot\": \"Library/VisualBridge/Compiled\"\n}\n",
                    Utf8WithoutBom);
            }

            private void WriteProject()
            {
                File.WriteAllText(
                    Path.Combine(Root, "Authoring", "VisualBridge.project.vbjson"),
                    "{\n  \"formatVersion\": 1,\n  \"projectId\": \"" + ProjectId + "\",\n  \"documentRoots\": [\"Graphs\"],\n  \"documentTypes\": [\n"
                    + "    {\"id\": \"tests.root\", \"editor\": \"graph\", \"include\": [\"Graphs/**/*.vbflow\"], \"exclude\": [], \"catalogs\": [\"Catalog/Test.vbgraphcatalog\"]}\n"
                    + "  ]\n}\n",
                    Utf8WithoutBom);
            }

            private static IReadOnlyList<string> DefaultRegisteredTypes()
            {
                return new[]
                {
                    typeof(GraphExporterRootGraphType).AssemblyQualifiedName,
                    typeof(GraphExporterSubgraphGraphType).AssemblyQualifiedName,
                    typeof(GraphExporterActionNodeType).AssemblyQualifiedName,
                    typeof(GraphExporterBranchNodeType).AssemblyQualifiedName,
                    typeof(GraphExporterSubgraphNodeType).AssemblyQualifiedName,
                    typeof(GraphCompilerFlowGraphType).AssemblyQualifiedName,
                    typeof(GraphCompilerSingleGraphType).AssemblyQualifiedName,
                    typeof(GraphCompilerConstrainedGraphType).AssemblyQualifiedName,
                    typeof(GraphCompilerSubgraphGraphType).AssemblyQualifiedName,
                    typeof(GraphCompilerAliasedNodeType).AssemblyQualifiedName,
                    typeof(GraphCompilerOutsiderNodeType).AssemblyQualifiedName,
                };
            }
        }
    }
}
