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
using UnityEditor;
using UnityEngine;

[assembly: VisualBridgeGraphCatalog("tests.visualbridge.graph", "VisualBridge Graph Exporter Tests")]
[assembly: VisualBridgeGraphDataType("int", "Integer")]
[assembly: VisualBridgeGraphDataType("list.string", "String List")]
[assembly: VisualBridgeGraphDataType("string", "String", Accepts = new[] { "int" })]

namespace VisualBridge.Editor.Tests
{
    [VisualBridgeGraphType(
        "tests.visualbridge.graph",
        "tests.flow",
        "Flow Graph",
        Usage = VisualBridgeGraphUsage.Root,
        SupportedCatalogIds = new[] { "tests.visualbridge.graph" },
        PortConnectionInput = VisualBridgePortConnectionMode.Single,
        AllowedNodeTags = new[] { "tests.tag.core" },
        AllowedNodeTraits = new[] { "tests.trait.pure", "tests.trait.side-effect" },
        AllowSubgraphs = false)]
    [VisualBridgeGraphNodeConstraint("tests.constraint.branch", "tests.node.branch", MinInstances = 0, MaxInstances = 1)]
    [VisualBridgeGraphInitialNode("tests.node.branch", Title = "Entry")]
    public sealed class GraphExporterRootGraphType
    {
        [VisualBridgeField("title", "Title", Order = 0, DefaultJson = "\"Graph\"", Editor = VisualBridgeEditorKind.Text)]
        public string Title;
    }

    [VisualBridgeGraphType(
        "tests.visualbridge.graph",
        "tests.sub",
        "Sub Graph",
        Usage = VisualBridgeGraphUsage.Subgraph,
        SupportedCatalogIds = new[] { "tests.visualbridge.graph" })]
    public sealed class GraphExporterSubgraphGraphType
    {
        [VisualBridgeField("title", "Title", DefaultJson = "\"Sub\"", Editor = VisualBridgeEditorKind.Text)]
        public string Title;
    }

    [VisualBridgeNodeType("tests.visualbridge.graph", "tests.node.action", "Action", "Logic", MenuPath = new[] { "Logic", "Action" }, Tags = new[] { "tests.tag.core" }, Traits = new[] { "tests.trait.pure" })]
    public sealed class GraphExporterActionNodeType
    {
        [VisualBridgePort("exec.in", "Exec In", VisualBridgePortKind.Flow, VisualBridgePortDirection.Input)]
        public bool ExecIn;

        [VisualBridgePort("exec.out", "Exec Out", VisualBridgePortKind.Flow, VisualBridgePortDirection.Output, MaxConnections = 1)]
        public bool ExecOut;

        [VisualBridgePort("count.in", "Count", VisualBridgePortKind.Data, VisualBridgePortDirection.Input)]
        public int Count;

        [VisualBridgePort("label.out", "Label", VisualBridgePortKind.Data, VisualBridgePortDirection.Output, DataTypeId = "string")]
        public string Label;

        [VisualBridgeDynamicPortGroup("tests.group.inputs", "Inputs", VisualBridgePortDirection.Input, DataTypeId = "list.string", MaxItems = 8)]
        public List<string> Inputs;

        [VisualBridgeDynamicPortGroup("tests.group.outputs", "Outputs", VisualBridgePortDirection.Input, ListPortMode = VisualBridgeListPortMode.Element)]
        public List<string> Outputs;

        [VisualBridgeField("enabled", "Enabled", Order = 0, DefaultJson = "true", Editor = VisualBridgeEditorKind.Checkbox)]
        public bool Enabled;
    }

    [VisualBridgeNodeType("tests.visualbridge.graph", "tests.node.branch", "Branch", "Flow", Tags = new[] { "tests.tag.core" })]
    public sealed class GraphExporterBranchNodeType
    {
        [VisualBridgePort("exec.in", "Exec In", VisualBridgePortKind.Flow, VisualBridgePortDirection.Input)]
        public bool ExecIn;

        [VisualBridgePort("exec.out", "Exec Out", VisualBridgePortKind.Flow, VisualBridgePortDirection.Output)]
        public bool ExecOut;

        [VisualBridgeField("condition", "Condition", Order = 0, DefaultJson = "true", Editor = VisualBridgeEditorKind.Checkbox)]
        public bool Condition;
    }

    [VisualBridgeNodeType("tests.visualbridge.graph", "tests.node.subgraph", "Subgraph", "Flow", SubgraphGraphTypeIds = new[] { "tests.sub" })]
    public sealed class GraphExporterSubgraphNodeType
    {
        [VisualBridgePort("value.in", "Value", VisualBridgePortKind.Data, VisualBridgePortDirection.Input)]
        public int Value;

        [VisualBridgePort("result.out", "Result", VisualBridgePortKind.Data, VisualBridgePortDirection.Output, DataTypeId = "string")]
        public string Result;
    }

    [VisualBridgeNodeType("tests.visualbridge.graph", "tests.node.action", "Duplicate Action", "Logic")]
    public sealed class GraphExporterDuplicateActionNodeType
    {
    }

    [VisualBridgeGraphType("tests.visualbridge.graph", "tests.both", "Both")]
    [VisualBridgeNodeType("tests.visualbridge.graph", "tests.both", "Both", "Flow")]
    public sealed class GraphExporterBothMetadataType
    {
    }

    public sealed class GraphExporterMissingMetadataType
    {
    }

    [VisualBridgeNodeType("tests.visualbridge.graph", "tests.node.flow-data", "Flow Data", "Flow")]
    public sealed class GraphExporterFlowPortWithDataTypeType
    {
        [VisualBridgePort("exec.in", "Exec In", VisualBridgePortKind.Flow, VisualBridgePortDirection.Input, DataTypeId = "int")]
        public bool ExecIn;
    }

    [VisualBridgeNodeType("tests.visualbridge.graph", "tests.node.custom-port", "Custom Port", "Flow")]
    public sealed class GraphExporterUnsupportedPortDataTypeType
    {
        [VisualBridgePort("value.in", "Value", VisualBridgePortKind.Data, VisualBridgePortDirection.Input)]
        public GraphExporterPortPayload Value;
    }

    public sealed class GraphExporterPortPayload
    {
    }

    [VisualBridgeNodeType("tests.visualbridge.graph", "tests.node.port-field", "Port Field", "Flow")]
    public sealed class GraphExporterPortAndFieldType
    {
        [VisualBridgePort("value.in", "Value", VisualBridgePortKind.Data, VisualBridgePortDirection.Input, DataTypeId = "int")]
        [VisualBridgeField("value", "Value", Order = 0, DefaultJson = "0", Editor = VisualBridgeEditorKind.Number)]
        public int Value;
    }

    [VisualBridgeGraphType("tests.visualbridge.graph", "tests.invalid-reference", "Invalid Reference", SupportedCatalogIds = new[] { "tests.other.catalog" })]
    public sealed class GraphExporterInvalidReferenceGraphType
    {
    }

    public sealed class VisualBridgeGraphCatalogExporterTests
    {
        private static readonly UTF8Encoding Utf8WithoutBom = new UTF8Encoding(false);

        [Test]
        public void GenerateIsDeterministic()
        {
            using (var fixture = new GraphExportFixture(DefaultTypes()))
            {
                var first = VisualBridgeGraphCatalogExporter.Export(fixture.Root, VisualBridgeCatalogExportMode.Generate);
                var firstBytes = File.ReadAllBytes(fixture.OutputPath);
                var second = VisualBridgeGraphCatalogExporter.Export(fixture.Root, VisualBridgeCatalogExportMode.Generate);
                var secondBytes = File.ReadAllBytes(fixture.OutputPath);

                Assert.That(first.DriftDetected, Is.True);
                Assert.That(second.DriftDetected, Is.False);
                Assert.That(secondBytes, Is.EqualTo(firstBytes));
            }
        }

        [Test]
        public void TypeOrderDoesNotChangeCatalogBytesOrSourceHash()
        {
            var firstOrder = DefaultTypes();
            var secondOrder = firstOrder.Reverse().ToArray();
            using (var first = new GraphExportFixture(firstOrder))
            using (var second = new GraphExportFixture(secondOrder))
            {
                VisualBridgeGraphCatalogExporter.Export(first.Root, VisualBridgeCatalogExportMode.Generate);
                VisualBridgeGraphCatalogExporter.Export(second.Root, VisualBridgeCatalogExportMode.Generate);
                var firstBytes = File.ReadAllBytes(first.OutputPath);
                var secondBytes = File.ReadAllBytes(second.OutputPath);

                Assert.That(secondBytes, Is.EqualTo(firstBytes));
                Assert.That(
                    JObject.Parse(Utf8WithoutBom.GetString(firstBytes))["source"]?["sourceHash"]?.Value<string>(),
                    Is.EqualTo(JObject.Parse(Utf8WithoutBom.GetString(secondBytes))["source"]?["sourceHash"]?.Value<string>()));
            }
        }

        [Test]
        public void CheckDetectsDriftWithoutWriting()
        {
            using (var fixture = new GraphExportFixture(DefaultTypes()))
            {
                VisualBridgeGraphCatalogExporter.Export(fixture.Root, VisualBridgeCatalogExportMode.Generate);
                var drift = Utf8WithoutBom.GetBytes("{}\n");
                File.WriteAllBytes(fixture.OutputPath, drift);

                var result = VisualBridgeGraphCatalogExporter.Export(fixture.Root, VisualBridgeCatalogExportMode.Check);

                Assert.That(result.DriftDetected, Is.True);
                Assert.That(File.ReadAllBytes(fixture.OutputPath), Is.EqualTo(drift));
            }
        }

        [Test]
        public void CatalogContainsDataTypesGraphTypesAndNodeTypes()
        {
            using (var fixture = new GraphExportFixture(DefaultTypes()))
            {
                VisualBridgeGraphCatalogExporter.Export(fixture.Root, VisualBridgeCatalogExportMode.Generate);
                var catalog = JObject.Parse(File.ReadAllText(fixture.OutputPath));

                Assert.That(catalog["formatVersion"]?.Value<int>(), Is.EqualTo(4));
                Assert.That(catalog["catalogId"]?.Value<string>(), Is.EqualTo("tests.visualbridge.graph"));
                Assert.That(catalog["source"]?["status"]?.Value<string>(), Is.EqualTo("current"));
                Assert.That(catalog["source"]?["providerId"]?.Value<string>(), Is.EqualTo("unity.csharp"));
                Assert.That(catalog["source"]?["sourceHash"]?.Value<string>().Length, Is.EqualTo(64));

                var dataTypes = ((JArray)catalog["dataTypes"]).Cast<JObject>().ToList();
                Assert.That(dataTypes.Select(dataType => dataType.Value<string>("id")).ToArray(), Is.EqualTo(new[]
                {
                    "int",
                    "list.string",
                    "string",
                }));
                Assert.That(dataTypes[0]["title"]?.Value<string>(), Is.EqualTo("Integer"));
                Assert.That(dataTypes[2]["accepts"]?.Values<string>(), Is.EqualTo(new[] { "int" }));
                Assert.That(dataTypes[1]["accepts"], Is.Null);

                var graphTypes = ((JArray)catalog["graphTypes"]).Cast<JObject>().ToList();
                Assert.That(graphTypes.Select(graphType => graphType.Value<string>("id")).ToArray(), Is.EqualTo(new[]
                {
                    "tests.flow",
                    "tests.sub",
                }));

                var flow = graphTypes[0];
                Assert.That(flow["usage"]?.Value<string>(), Is.EqualTo("root"));
                Assert.That(flow["portConnectionRules"]?["input"]?.Value<string>(), Is.EqualTo("single"));
                Assert.That(flow["portConnectionRules"]?["output"]?.Value<string>(), Is.EqualTo("multiple"));
                Assert.That(flow["allowedNodeSelectors"]?[0]?["tags"]?.Values<string>(), Is.EqualTo(new[] { "tests.tag.core" }));
                Assert.That(flow["allowedNodeSelectors"]?[0]?["traits"]?.Values<string>(), Is.EqualTo(new[]
                {
                    "tests.trait.pure",
                    "tests.trait.side-effect",
                }));
                Assert.That(flow["nodeConstraints"]?[0]?["selector"]?["nodeTypeIds"]?.Values<string>(), Is.EqualTo(new[] { "tests.node.branch" }));
                Assert.That(flow["nodeConstraints"]?[0]?["minInstances"]?.Value<int>(), Is.EqualTo(0));
                Assert.That(flow["nodeConstraints"]?[0]?["maxInstances"]?.Value<int>(), Is.EqualTo(1));
                Assert.That(flow["initialNodes"]?[0]?["nodeTypeId"]?.Value<string>(), Is.EqualTo("tests.node.branch"));
                Assert.That(flow["initialNodes"]?[0]?["title"]?.Value<string>(), Is.EqualTo("Entry"));
                Assert.That(flow["allowSubgraphs"]?.Value<bool>(), Is.False);
                Assert.That(flow["source"]?["typeName"]?.Value<string>(), Is.EqualTo(typeof(GraphExporterRootGraphType).AssemblyQualifiedName));

                var sub = graphTypes[1];
                Assert.That(sub["usage"]?.Value<string>(), Is.EqualTo("subgraph"));
                Assert.That(sub["portConnectionRules"]?["input"]?.Value<string>(), Is.EqualTo("multiple"));
                Assert.That(sub["allowedNodeSelectors"], Is.Null);
                Assert.That(sub["allowSubgraphs"], Is.Null);

                var nodeTypes = ((JArray)catalog["nodeTypes"]).Cast<JObject>().ToList();
                Assert.That(nodeTypes.Select(nodeType => nodeType.Value<string>("id")).ToArray(), Is.EqualTo(new[]
                {
                    "tests.node.action",
                    "tests.node.branch",
                    "tests.node.subgraph",
                }));

                var action = nodeTypes[0];
                Assert.That(action["category"]?.Value<string>(), Is.EqualTo("Logic"));
                Assert.That(action["menuPath"]?.Values<string>(), Is.EqualTo(new[] { "Logic", "Action" }));
                Assert.That(action["tags"]?.Values<string>(), Is.EqualTo(new[] { "tests.tag.core" }));
                Assert.That(action["traits"]?.Values<string>(), Is.EqualTo(new[] { "tests.trait.pure" }));
                var ports = ((JArray)action["ports"]).Cast<JObject>().ToList();
                Assert.That(ports.Select(port => port.Value<string>("id")).ToArray(), Is.EqualTo(new[]
                {
                    "exec.in",
                    "exec.out",
                    "count.in",
                    "label.out",
                }));
                Assert.That(ports[0]["kind"]?.Value<string>(), Is.EqualTo("flow"));
                Assert.That(ports[0]["direction"]?.Value<string>(), Is.EqualTo("input"));
                Assert.That(ports[0]["dataTypeId"], Is.Null);
                Assert.That(ports[1]["maxConnections"]?.Value<int>(), Is.EqualTo(1));
                Assert.That(ports[2]["kind"]?.Value<string>(), Is.EqualTo("data"));
                Assert.That(ports[2]["dataTypeId"]?.Value<string>(), Is.EqualTo("int"));
                Assert.That(ports[3]["dataTypeId"]?.Value<string>(), Is.EqualTo("string"));

                var groups = ((JArray)action["dynamicPortGroups"]).Cast<JObject>().ToList();
                Assert.That(groups.Select(group => group.Value<string>("id")).ToArray(), Is.EqualTo(new[]
                {
                    "tests.group.inputs",
                    "tests.group.outputs",
                }));
                Assert.That(groups[0]["listPortMode"], Is.Null);
                Assert.That(groups[0]["port"]?["direction"]?.Value<string>(), Is.EqualTo("input"));
                Assert.That(groups[0]["port"]?["dataTypeId"]?.Value<string>(), Is.EqualTo("list.string"));
                Assert.That(groups[0]["item"]?["valueType"]?.Value<string>(), Is.EqualTo("string"));
                Assert.That(groups[0]["item"]?["dataTypeId"]?.Value<string>(), Is.EqualTo("string"));
                Assert.That(groups[0]["item"]?["defaultValue"]?.Value<string>(), Is.EqualTo(string.Empty));
                Assert.That(groups[0]["maxItems"]?.Value<int>(), Is.EqualTo(8));
                Assert.That(groups[1]["listPortMode"]?.Value<string>(), Is.EqualTo("element"));
                Assert.That(groups[1]["port"]?["direction"]?.Value<string>(), Is.EqualTo("input"));
                Assert.That(groups[1]["port"]?["dataTypeId"]?.Value<string>(), Is.EqualTo("string"));
                Assert.That(groups[1]["maxItems"], Is.Null);
                Assert.That(action["properties"]?[0]?["editor"]?["kind"]?.Value<string>(), Is.EqualTo("checkbox"));

                var branch = nodeTypes[1];
                Assert.That(branch["subgraph"], Is.Null);
                Assert.That(((JArray)branch["ports"]).Count, Is.EqualTo(2));

                var subgraphNode = nodeTypes[2];
                Assert.That(subgraphNode["subgraph"]?["graphTypeIds"]?.Values<string>(), Is.EqualTo(new[] { "tests.sub" }));
                Assert.That(((JArray)subgraphNode["ports"]).Select(port => port.Value<string>("kind")).ToArray(), Is.EqualTo(new[] { "data", "data" }));
            }
        }

        [TestCase("Missing.Type, Missing.Assembly", "catalog.typeNotFound")]
        [TestCase(null, "catalog.metadataMissing")]
        public void InvalidRegisteredTypeFailsClosed(string registeredType, string expectedCode)
        {
            registeredType = registeredType ?? typeof(GraphExporterMissingMetadataType).AssemblyQualifiedName;
            using (var fixture = new GraphExportFixture(registeredType))
            {
                var exception = Assert.Throws<VisualBridgeIntegrationException>(() =>
                    VisualBridgeGraphCatalogExporter.Export(fixture.Root, VisualBridgeCatalogExportMode.Check));
                Assert.That(exception.Code, Is.EqualTo(expectedCode));
            }
        }

        [TestCase(typeof(GraphExporterBothMetadataType), "catalog.duplicateMetadata")]
        [TestCase(typeof(GraphExporterDuplicateActionNodeType), "catalog.identityConflict")]
        [TestCase(typeof(GraphExporterFlowPortWithDataTypeType), "catalog.invalidMetadata")]
        [TestCase(typeof(GraphExporterUnsupportedPortDataTypeType), "catalog.invalidPortDataType")]
        [TestCase(typeof(GraphExporterPortAndFieldType), "catalog.duplicateMetadata")]
        [TestCase(typeof(GraphExporterInvalidReferenceGraphType), "catalog.invalidReference")]
        public void InvalidGraphSemanticsFailClosed(Type type, string expectedCode)
        {
            var registeredTypes = type == typeof(GraphExporterDuplicateActionNodeType)
                ? new[]
                {
                    typeof(GraphExporterActionNodeType).AssemblyQualifiedName,
                    typeof(GraphExporterDuplicateActionNodeType).AssemblyQualifiedName,
                }
                : new[] { type.AssemblyQualifiedName };
            using (var fixture = new GraphExportFixture(registeredTypes))
            {
                var exception = Assert.Throws<VisualBridgeIntegrationException>(() =>
                    VisualBridgeGraphCatalogExporter.Export(fixture.Root, VisualBridgeCatalogExportMode.Check));
                Assert.That(exception.Code, Is.EqualTo(expectedCode));
            }
        }

        [Test]
        public void StructuredAndEntityExportersSkipGraphOutputs()
        {
            using (var fixture = new GraphExportFixture(DefaultTypes()))
            {
                var structuredResult = VisualBridgeStructuredCatalogExporter.Export(fixture.Root, VisualBridgeCatalogExportMode.Check);
                Assert.That(structuredResult.Outputs, Is.Empty);

                var entityResult = VisualBridgeEntityCatalogExporter.Export(fixture.Root, VisualBridgeCatalogExportMode.Check);
                Assert.That(entityResult.Outputs, Is.Empty);

                var graphResult = VisualBridgeGraphCatalogExporter.Export(fixture.Root, VisualBridgeCatalogExportMode.Generate);
                Assert.That(graphResult.Outputs.Count, Is.EqualTo(1));
                Assert.That(graphResult.Outputs[0].Path, Is.EqualTo(fixture.OutputPath));
            }
        }

        [Test]
        public void GraphCatalogMustBeDeclaredByGraphDocumentType()
        {
            using (var fixture = new GraphExportFixture(DefaultTypes()))
            {
                var projectPath = Path.Combine(fixture.Root, "Authoring", "VisualBridge.project.vbjson");
                var project = JObject.Parse(File.ReadAllText(projectPath));
                project["documentTypes"][0]["editor"] = "structured";
                File.WriteAllText(projectPath, project.ToString(Formatting.Indented) + "\n", Utf8WithoutBom);

                var exception = Assert.Throws<VisualBridgeIntegrationException>(() =>
                    VisualBridgeGraphCatalogExporter.Export(fixture.Root, VisualBridgeCatalogExportMode.Check));
                Assert.That(exception.Code, Is.EqualTo("profile.catalogNotDeclared"));
            }
        }

        [Test]
        public void ValidatorRejectsInvalidGraphSemantics()
        {
            var catalog = CreateValidCatalog();
            catalog["unexpected"] = true;
            Assert.That(ValidateCode(catalog), Is.EqualTo("catalog.unknownProperty"));

            catalog = CreateValidCatalog();
            catalog["formatVersion"] = 3;
            Assert.That(ValidateCode(catalog), Is.EqualTo("catalog.unsupportedVersion"));

            catalog = CreateValidCatalog();
            ((JObject)((JArray)catalog["nodeTypes"])[0]["ports"][2]).Remove("dataTypeId");
            Assert.That(ValidateCode(catalog), Is.EqualTo("catalog.missingProperty"));

            catalog = CreateValidCatalog();
            ((JArray)catalog["nodeTypes"])[0]["ports"][0]["dataTypeId"] = "fixture.number";
            Assert.That(ValidateCode(catalog), Is.EqualTo("catalog.invalidPort"));

            catalog = CreateValidCatalog();
            ((JArray)catalog["nodeTypes"])[0]["ports"][0]["maxConnections"] = 0;
            Assert.That(ValidateCode(catalog), Is.EqualTo("catalog.invalidNumber"));

            catalog = CreateValidCatalog();
            var subgraphNode = (JObject)((JArray)catalog["nodeTypes"])[0];
            subgraphNode["subgraph"] = new JObject { ["graphTypeIds"] = new JArray("fixture.flow") };
            Assert.That(ValidateCode(catalog), Is.EqualTo("catalog.invalidPort"));

            catalog = CreateValidCatalog();
            ((JArray)catalog["nodeTypes"])[0]["dynamicPortGroups"] = new JArray(new JObject
            {
                ["id"] = "fixture.group.values",
                ["title"] = "Values",
                ["port"] = new JObject
                {
                    ["kind"] = "data",
                    ["direction"] = "output",
                    ["dataTypeId"] = "fixture.text",
                },
                ["item"] = new JObject
                {
                    ["valueType"] = "string",
                    ["dataTypeId"] = "fixture.text",
                    ["defaultValue"] = string.Empty,
                },
            });
            Assert.That(ValidateCode(catalog), Is.EqualTo("catalog.invalidPort"));

            catalog = CreateValidCatalog();
            ((JArray)catalog["nodeTypes"])[0]["dynamicPortGroups"] = new JArray(new JObject
            {
                ["id"] = "fixture.group.values",
                ["title"] = "Values",
                ["listPortMode"] = "element",
                ["port"] = new JObject
                {
                    ["kind"] = "data",
                    ["direction"] = "input",
                    ["dataTypeId"] = "fixture.number",
                },
                ["item"] = new JObject
                {
                    ["valueType"] = "string",
                    ["dataTypeId"] = "fixture.text",
                    ["defaultValue"] = string.Empty,
                },
            });
            Assert.That(ValidateCode(catalog), Is.EqualTo("catalog.invalidPort"));

            catalog = CreateValidCatalog();
            ((JArray)catalog["nodeTypes"])[0]["dynamicPortGroups"] = new JArray(new JObject
            {
                ["id"] = "fixture.port.exec.in",
                ["title"] = "Conflicting Group",
                ["port"] = new JObject
                {
                    ["kind"] = "data",
                    ["direction"] = "input",
                    ["dataTypeId"] = "fixture.text",
                },
                ["item"] = new JObject
                {
                    ["valueType"] = "string",
                    ["dataTypeId"] = "fixture.text",
                    ["defaultValue"] = string.Empty,
                },
            });
            Assert.That(ValidateCode(catalog), Is.EqualTo("catalog.identityConflict"));
        }

        [Test]
        public void GraphSchemaAndValidatorShareParityFixture()
        {
            var fixtureAsset = AssetDatabase.LoadAssetAtPath<TextAsset>(
                "Packages/com.kyle.visualbridge/Tests/Fixtures/visualbridge-graph-catalog-cases.json");
            Assert.That(fixtureAsset, Is.Not.Null);
            var cases = (JArray)JObject.Parse(fixtureAsset.text)["cases"];
            Assert.That(cases.Count, Is.GreaterThanOrEqualTo(12));
            foreach (var testCase in cases.Cast<JObject>())
            {
                var value = testCase["value"] as JObject;
                Assert.That(value, Is.Not.Null, testCase.Value<string>("label"));
                if (testCase.Value<bool>("valid"))
                {
                    Assert.DoesNotThrow(
                        () => VisualBridgeGraphCatalogValidator.Validate(value),
                        testCase.Value<string>("label"));
                }
                else
                {
                    var exception = Assert.Throws<VisualBridgeIntegrationException>(
                        () => VisualBridgeGraphCatalogValidator.Validate(value),
                        testCase.Value<string>("label"));
                    Assert.That(exception.Code, Is.EqualTo(testCase.Value<string>("validatorCode")), testCase.Value<string>("label"));
                }
            }
        }

        private static string ValidateCode(JObject catalog)
        {
            return Assert.Throws<VisualBridgeIntegrationException>(() => VisualBridgeGraphCatalogValidator.Validate(catalog)).Code;
        }

        private static string[] DefaultTypes()
        {
            return new[]
            {
                typeof(GraphExporterRootGraphType).AssemblyQualifiedName,
                typeof(GraphExporterSubgraphGraphType).AssemblyQualifiedName,
                typeof(GraphExporterActionNodeType).AssemblyQualifiedName,
                typeof(GraphExporterBranchNodeType).AssemblyQualifiedName,
                typeof(GraphExporterSubgraphNodeType).AssemblyQualifiedName,
            };
        }

        private static JObject CreateValidCatalog()
        {
            return JObject.Parse(
                "{"
                + "\"formatVersion\": 4,"
                + "\"catalogId\": \"fixture.graph\","
                + "\"title\": \"Fixture\","
                + "\"source\": {\"status\": \"current\", \"providerId\": \"unity.csharp\", \"sourceHash\": \"" + new string('a', 64) + "\"},"
                + "\"dataTypes\": [{\"id\": \"fixture.number\", \"title\": \"Number\"}, {\"id\": \"fixture.text\", \"title\": \"Text\"}],"
                + "\"graphTypes\": [{\"id\": \"fixture.flow\", \"title\": \"Flow\", \"supportedCatalogIds\": [\"fixture.graph\"], \"portConnectionRules\": {\"input\": \"single\", \"output\": \"multiple\"}, \"properties\": []}],"
                + "\"nodeTypes\": [{\"id\": \"fixture.node.log\", \"title\": \"Log\", \"category\": \"Logic\", \"ports\": ["
                + "{\"id\": \"fixture.port.exec.in\", \"title\": \"Exec In\", \"kind\": \"flow\", \"direction\": \"input\"},"
                + "{\"id\": \"fixture.port.exec.out\", \"title\": \"Exec Out\", \"kind\": \"flow\", \"direction\": \"output\", \"maxConnections\": 1},"
                + "{\"id\": \"fixture.port.message\", \"title\": \"Message\", \"kind\": \"data\", \"direction\": \"input\", \"dataTypeId\": \"fixture.text\"}"
                + "], \"properties\": []}]"
                + "}");
        }

        private sealed class GraphExportFixture : IDisposable
        {
            public GraphExportFixture(string registeredType)
                : this(new[] { registeredType })
            {
            }

            public GraphExportFixture(IReadOnlyList<string> registeredTypes)
            {
                Root = Path.Combine(Path.GetTempPath(), "VisualBridgeGraphExporterTests", Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(Path.Combine(Root, "ProjectSettings"));
                Directory.CreateDirectory(Path.Combine(Root, "Authoring"));

                File.WriteAllText(
                    Path.Combine(Root, "Authoring", "VisualBridge.project.vbjson"),
                    "{\n  \"formatVersion\": 1,\n  \"projectId\": \"tests.project\",\n  \"documentRoots\": [\"Graph\"],\n  \"documentTypes\": [\n    {\"id\": \"tests.graphs\", \"editor\": \"graph\", \"include\": [\"Graph/**/*.vbgraph\"], \"catalogs\": [\"Catalog/Test.vbgraphcatalog\"]}\n  ]\n}\n",
                    Utf8WithoutBom);

                var serializedTypes = string.Join(", ", registeredTypes.Select(JsonConvert.ToString));
                ProfilePath = Path.Combine(Root, "ProjectSettings", "VisualBridgeIntegration.json");
                File.WriteAllText(
                    ProfilePath,
                    "{\n  \"formatVersion\": 1,\n  \"authoringProject\": \"Authoring/VisualBridge.project.vbjson\",\n  \"catalogExports\": [{\"catalogId\": \"tests.visualbridge.graph\", \"title\": \"VisualBridge Graph Exporter Tests\", \"output\": \"Authoring/Catalog/Test.vbgraphcatalog\", \"types\": ["
                    + serializedTypes + "]}],\n  \"compileOutputRoot\": \"Library/VisualBridge\"\n}\n",
                    Utf8WithoutBom);
                OutputPath = Path.Combine(Root, "Authoring", "Catalog", "Test.vbgraphcatalog");
            }

            public string Root { get; }

            public string OutputPath { get; }

            public string ProfilePath { get; }

            public void Dispose()
            {
                if (Directory.Exists(Root))
                {
                    Directory.Delete(Root, true);
                }
            }
        }
    }
}
