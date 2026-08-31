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
    // tests.hero 路由到的 Entity Type 在本文件定义：既有 EntityExporterHeroType 未声明
    // AllowedComponentGroupIds，空白名单按 Node 侧语义不允许任何组件，无法覆盖
    // 「Hero 文档携带 health/movement 组件」的正路径，因此这里声明 combat/movement 组白名单。
    [VisualBridgeEntityType(
        "tests.visualbridge.entity",
        "tests.hero",
        "Hero",
        Aliases = new[] { "tests.hero.legacy" },
        AllowedComponentGroupIds = new[] { "tests.group.combat", "tests.group.movement" })]
    public sealed class EntityCompilerHeroType
    {
        public static int ConstructorCallCount;

        public EntityCompilerHeroType()
        {
            ConstructorCallCount++;
        }

        [VisualBridgeField("name", "Name", Order = 0, Aliases = new[] { "label" }, DefaultJson = "\"Hero\"", Editor = VisualBridgeEditorKind.Text)]
        public string Name;

        [VisualBridgeField("level", "Level", Order = 1, DefaultJson = "1", Editor = VisualBridgeEditorKind.Number, Integer = true)]
        public int Level;
    }

    // 挂在未被 Hero 白名单引用的 tests.group.unused 组上，用于 componentGroupNotAllowed 负路径。
    [VisualBridgeEntityComponent("tests.visualbridge.entity", "tests.mark", "Mark", "tests.group.unused")]
    public sealed class EntityCompilerUnusedGroupComponent
    {
        public static int ConstructorCallCount;

        public EntityCompilerUnusedGroupComponent()
        {
            ConstructorCallCount++;
        }

        [VisualBridgeField("value", "Value", DefaultJson = "1", Editor = VisualBridgeEditorKind.Number)]
        public float Value;
    }

    public sealed class VisualBridgeEntityCompilerTests
    {
        private static readonly UTF8Encoding Utf8WithoutBom = new UTF8Encoding(false);

        [Test]
        public void GenerateMaterializesDefaultsWithoutBusinessConstructorsAndIsDeterministic()
        {
            using (var fixture = new EntityCompilerFixture())
            {
                EntityCompilerHeroType.ConstructorCallCount = 0;
                EntityCompilerUnusedGroupComponent.ConstructorCallCount = 0;
                fixture.WriteValidDocument();

                var first = VisualBridgeEntityCompiler.Compile(fixture.Root, VisualBridgeEntityCompileMode.Generate);
                var firstSnapshot = first.Outputs.ToDictionary(output => output.Path, output => File.ReadAllBytes(output.Path));
                var second = VisualBridgeEntityCompiler.Compile(fixture.Root, VisualBridgeEntityCompileMode.Generate);

                Assert.That(first.DriftDetected, Is.True);
                Assert.That(second.DriftDetected, Is.False);
                Assert.That(second.Outputs.All(output => File.ReadAllBytes(output.Path).SequenceEqual(firstSnapshot[output.Path])), Is.True);
                Assert.That(EntityCompilerHeroType.ConstructorCallCount, Is.Zero);
                Assert.That(EntityCompilerUnusedGroupComponent.ConstructorCallCount, Is.Zero);

                var artifact = JObject.Parse(File.ReadAllText(fixture.ArtifactPath));
                Assert.That(artifact.Value<string>("kind"), Is.EqualTo("visualbridge.entity.compiled"));
                Assert.That(artifact.Value<string>("entityTypeId"), Is.EqualTo("tests.hero"));
                Assert.That(artifact["data"]["properties"]["name"].Value<string>(), Is.EqualTo("configured"));
                Assert.That(artifact["data"]["properties"]["level"].Value<int>(), Is.EqualTo(1));
                var components = ((JArray)artifact["data"]["components"]).Cast<JObject>().ToList();
                Assert.That(components.Count, Is.EqualTo(2));
                Assert.That(components[0].Value<string>("id"), Is.EqualTo("health"));
                Assert.That(components[0].Value<string>("componentTypeId"), Is.EqualTo("tests.health"));
                Assert.That(components[0].Value<bool>("enabled"), Is.True);
                Assert.That(components[0]["properties"]["maxHealth"].Value<int>(), Is.EqualTo(250));
                Assert.That(components[0]["properties"]["regen"].Value<double>(), Is.EqualTo(0.5));
                Assert.That(components[1].Value<string>("componentTypeId"), Is.EqualTo("tests.movement"));
                Assert.That(components[1]["properties"]["speed"].Value<double>(), Is.EqualTo(3.5));
                Assert.That(File.ReadAllBytes(fixture.ArtifactPath).Last(), Is.EqualTo((byte)'\n'));

                var mapping = JObject.Parse(File.ReadAllText(fixture.MappingPath));
                var origins = ((JArray)mapping["mappings"]).Cast<JObject>()
                    .ToDictionary(entry => entry.Value<string>("artifactPath"), entry => entry.Value<string>("origin"));
                Assert.That(origins["data.properties.name"], Is.EqualTo("document"));
                Assert.That(origins["data.properties.level"], Is.EqualTo("metadataDefault"));
                Assert.That(origins["data.components[0].properties.maxHealth"], Is.EqualTo("document"));
                Assert.That(origins["data.components[0].properties.regen"], Is.EqualTo("metadataDefault"));
                Assert.That(origins["data.components[1].properties.speed"], Is.EqualTo("metadataDefault"));
            }
        }

        [Test]
        public void BatchExitCodesShareOneContract()
        {
            Assert.That(VisualBridgeEntityCompilerBatch.SuccessExitCode, Is.EqualTo(0));
            Assert.That(VisualBridgeEntityCompilerBatch.FailureExitCode, Is.EqualTo(1));
            Assert.That(VisualBridgeEntityCompilerBatch.DriftExitCode, Is.EqualTo(2));
            Assert.That(VisualBridgeEntityCompilerBatch.SuccessExitCode, Is.EqualTo(VisualBridgeStructuredCompilerBatch.SuccessExitCode));
            Assert.That(VisualBridgeEntityCompilerBatch.FailureExitCode, Is.EqualTo(VisualBridgeStructuredCompilerBatch.FailureExitCode));
            Assert.That(VisualBridgeEntityCompilerBatch.DriftExitCode, Is.EqualTo(VisualBridgeStructuredCompilerBatch.DriftExitCode));
        }

        [Test]
        public void CheckDetectsDriftWithoutWriting()
        {
            using (var fixture = new EntityCompilerFixture())
            {
                fixture.WriteValidDocument();
                VisualBridgeEntityCompiler.Compile(fixture.Root, VisualBridgeEntityCompileMode.Generate);
                var drift = Utf8WithoutBom.GetBytes("{}\n");
                File.WriteAllBytes(fixture.ArtifactPath, drift);

                var result = VisualBridgeEntityCompiler.Compile(fixture.Root, VisualBridgeEntityCompileMode.Check);

                Assert.That(result.DriftDetected, Is.True);
                Assert.That(File.ReadAllBytes(fixture.ArtifactPath), Is.EqualTo(drift));
                Assert.That(Directory.GetFiles(fixture.OutputRoot, "*.tmp", SearchOption.AllDirectories), Is.Empty);
            }
        }

        [Test]
        public void StaleOutputsAreRemovedOnGenerateAndKeptOnCheck()
        {
            using (var fixture = new EntityCompilerFixture())
            {
                fixture.WriteValidDocument();
                VisualBridgeEntityCompiler.Compile(fixture.Root, VisualBridgeEntityCompileMode.Generate);
                File.Delete(fixture.DocumentPath);

                var check = VisualBridgeEntityCompiler.Compile(fixture.Root, VisualBridgeEntityCompileMode.Check);
                Assert.That(check.StaleOutputs, Is.Not.Empty);
                Assert.That(File.Exists(fixture.ArtifactPath), Is.True);

                var generate = VisualBridgeEntityCompiler.Compile(fixture.Root, VisualBridgeEntityCompileMode.Generate);
                Assert.That(generate.StaleOutputs, Is.Not.Empty);
                Assert.That(File.Exists(fixture.ArtifactPath), Is.False);
                Assert.That(File.Exists(fixture.MappingPath), Is.False);
                Assert.That(Directory.GetFiles(fixture.OutputRoot, "*.tmp", SearchOption.AllDirectories), Is.Empty);
            }
        }

        [Test]
        public void UnknownEntityTypeFailsClosed()
        {
            using (var fixture = new EntityCompilerFixture())
            {
                fixture.WriteDocument("{\n  \"formatVersion\": 1,\n  \"documentId\": \"tests.entity.default\",\n  \"entityTypeId\": \"tests.missing\",\n  \"title\": \"Hero\",\n  \"properties\": {},\n  \"components\": []\n}\n");

                var exception = Assert.Throws<VisualBridgeIntegrationException>(() =>
                    VisualBridgeEntityCompiler.Compile(fixture.Root, VisualBridgeEntityCompileMode.Check));

                Assert.That(exception.Code, Is.EqualTo("compile.entityTypeUnknown"));
            }
        }

        [Test]
        public void EntityTypeMismatchFailsClosed()
        {
            using (var fixture = new EntityCompilerFixture())
            {
                fixture.WriteDocument("{\n  \"formatVersion\": 1,\n  \"documentId\": \"tests.entity.default\",\n  \"entityTypeId\": \"tests.enemy\",\n  \"title\": \"Enemy\",\n  \"properties\": {},\n  \"components\": []\n}\n");

                var exception = Assert.Throws<VisualBridgeIntegrationException>(() =>
                    VisualBridgeEntityCompiler.Compile(fixture.Root, VisualBridgeEntityCompileMode.Check));

                Assert.That(exception.Code, Is.EqualTo("compile.entityTypeMismatch"));
            }
        }

        [Test]
        public void UnknownFieldFailsClosed()
        {
            using (var fixture = new EntityCompilerFixture())
            {
                fixture.WriteDocument("{\n  \"formatVersion\": 1,\n  \"documentId\": \"tests.entity.default\",\n  \"entityTypeId\": \"tests.hero\",\n  \"title\": \"Hero\",\n  \"properties\": { \"name\": \"configured\", \"unknown\": true },\n  \"components\": []\n}\n");

                var exception = Assert.Throws<VisualBridgeIntegrationException>(() =>
                    VisualBridgeEntityCompiler.Compile(fixture.Root, VisualBridgeEntityCompileMode.Check));

                Assert.That(exception.Code, Is.EqualTo("compile.unknownField"));
            }
        }

        [Test]
        public void TypeMismatchFailsClosed()
        {
            using (var fixture = new EntityCompilerFixture())
            {
                fixture.WriteDocument("{\n  \"formatVersion\": 1,\n  \"documentId\": \"tests.entity.default\",\n  \"entityTypeId\": \"tests.hero\",\n  \"title\": \"Hero\",\n  \"properties\": { \"name\": 5 },\n  \"components\": []\n}\n");

                var exception = Assert.Throws<VisualBridgeIntegrationException>(() =>
                    VisualBridgeEntityCompiler.Compile(fixture.Root, VisualBridgeEntityCompileMode.Check));

                Assert.That(exception.Code, Is.EqualTo("compile.typeMismatch"));
            }
        }

        [Test]
        public void ComponentGroupNotAllowedFailsClosed()
        {
            using (var fixture = new EntityCompilerFixture())
            {
                fixture.WriteDocument(
                    "{\n  \"formatVersion\": 1,\n  \"documentId\": \"tests.entity.default\",\n  \"entityTypeId\": \"tests.hero\",\n  \"title\": \"Hero\",\n"
                    + "  \"properties\": {},\n"
                    + "  \"components\": [ { \"id\": \"mark\", \"componentTypeId\": \"tests.mark\", \"enabled\": true, \"properties\": {} } ]\n"
                    + "}\n");

                var exception = Assert.Throws<VisualBridgeIntegrationException>(() =>
                    VisualBridgeEntityCompiler.Compile(fixture.Root, VisualBridgeEntityCompileMode.Check));

                Assert.That(exception.Code, Is.EqualTo("compile.componentGroupNotAllowed"));
            }
        }

        [Test]
        public void DuplicateComponentIdFailsClosed()
        {
            using (var fixture = new EntityCompilerFixture())
            {
                fixture.WriteDocument(
                    "{\n  \"formatVersion\": 1,\n  \"documentId\": \"tests.entity.default\",\n  \"entityTypeId\": \"tests.hero\",\n  \"title\": \"Hero\",\n"
                    + "  \"properties\": {},\n"
                    + "  \"components\": [\n"
                    + "    { \"id\": \"health\", \"componentTypeId\": \"tests.health\", \"enabled\": true, \"properties\": {} },\n"
                    + "    { \"id\": \"health\", \"componentTypeId\": \"tests.movement\", \"enabled\": false, \"properties\": {} }\n"
                    + "  ]\n}\n");

                var exception = Assert.Throws<VisualBridgeIntegrationException>(() =>
                    VisualBridgeEntityCompiler.Compile(fixture.Root, VisualBridgeEntityCompileMode.Check));

                Assert.That(exception.Code, Is.EqualTo("compile.componentIdentityConflict"));
            }
        }

        [Test]
        public void FailedGeneratePreservesLastValidOutputsAndAuthoringBytes()
        {
            using (var fixture = new EntityCompilerFixture())
            {
                fixture.WriteValidDocument();
                var generated = VisualBridgeEntityCompiler.Compile(fixture.Root, VisualBridgeEntityCompileMode.Generate);
                var before = generated.Outputs.ToDictionary(output => output.Path, output => File.ReadAllBytes(output.Path));
                var invalid = Utf8WithoutBom.GetBytes(
                    "{\n  \"formatVersion\": 1,\n  \"documentId\": \"tests.entity.default\",\n  \"entityTypeId\": \"tests.hero\",\n  \"title\": \"Hero\",\n  \"properties\": { \"name\": 5 },\n  \"components\": []\n}\n");
                File.WriteAllBytes(fixture.DocumentPath, invalid);

                Assert.Throws<VisualBridgeIntegrationException>(() =>
                    VisualBridgeEntityCompiler.Compile(fixture.Root, VisualBridgeEntityCompileMode.Generate));

                Assert.That(before.All(entry => File.ReadAllBytes(entry.Key).SequenceEqual(entry.Value)), Is.True);
                Assert.That(File.ReadAllBytes(fixture.DocumentPath), Is.EqualTo(invalid));
            }
        }

        [Test]
        public void AmbiguousRouteFailsClosed()
        {
            using (var fixture = new EntityCompilerFixture(documentTypes: new[]
            {
                EntityCompilerFixture.EntityDocumentType("tests.hero", "Entities/**/*.vbentity"),
                EntityCompilerFixture.EntityDocumentType("tests.enemy", "Entities/**/*.vbentity"),
            }))
            {
                fixture.WriteValidDocument();

                var exception = Assert.Throws<VisualBridgeIntegrationException>(() =>
                    VisualBridgeEntityCompiler.Compile(fixture.Root, VisualBridgeEntityCompileMode.Check));

                Assert.That(exception.Code, Is.EqualTo("compile.ambiguousRoute"));
            }
        }

        [Test]
        public void FieldAliasCanonicalizesOutput()
        {
            using (var fixture = new EntityCompilerFixture())
            {
                fixture.WriteDocument("{\n  \"formatVersion\": 1,\n  \"documentId\": \"tests.entity.default\",\n  \"entityTypeId\": \"tests.hero\",\n  \"title\": \"Hero\",\n  \"properties\": { \"label\": \"alias-name\" },\n  \"components\": []\n}\n");

                VisualBridgeEntityCompiler.Compile(fixture.Root, VisualBridgeEntityCompileMode.Generate);

                var artifact = JObject.Parse(File.ReadAllText(fixture.ArtifactPath));
                Assert.That(artifact["data"]["properties"]["name"].Value<string>(), Is.EqualTo("alias-name"));
                Assert.That(((JObject)artifact["data"]["properties"]).Property("label"), Is.Null);
            }
        }

        [Test]
        public void StructuredAndEntityCompilersCoexist()
        {
            using (var fixture = new EntityCompilerFixture(structuredRegisteredType: typeof(CompilerTestSettings).AssemblyQualifiedName))
            {
                var structuredDocumentPath = Path.Combine(fixture.Root, "Authoring", "Config", "Settings.json");
                File.WriteAllText(
                    structuredDocumentPath,
                    "{\n  \"formatVersion\": 1,\n  \"documentId\": \"tests.compiler.default\",\n  \"properties\": { \"name\": \"configured\" }\n}\n",
                    Utf8WithoutBom);
                fixture.WriteValidDocument();

                var structured = VisualBridgeStructuredCompiler.Compile(fixture.Root, VisualBridgeStructuredCompileMode.Generate);
                var entity = VisualBridgeEntityCompiler.Compile(fixture.Root, VisualBridgeEntityCompileMode.Generate);

                Assert.That(structured.DriftDetected, Is.True);
                Assert.That(entity.DriftDetected, Is.True);
                Assert.That(File.Exists(Path.Combine(fixture.OutputRoot, "manifest.json")), Is.True);
                Assert.That(File.Exists(fixture.ManifestPath), Is.True);
                Assert.That(File.Exists(fixture.ArtifactPath), Is.True);
                Assert.That(File.Exists(Path.Combine(
                    fixture.OutputRoot,
                    "documents",
                    EntityCompilerFixture.ProjectId,
                    "tests.compiler.settings",
                    "tests.compiler.default.vbcompiled.json")), Is.True);

                var structuredCheck = VisualBridgeStructuredCompiler.Compile(fixture.Root, VisualBridgeStructuredCompileMode.Check);
                var entityCheck = VisualBridgeEntityCompiler.Compile(fixture.Root, VisualBridgeEntityCompileMode.Check);
                Assert.That(structuredCheck.DriftDetected, Is.False);
                Assert.That(entityCheck.DriftDetected, Is.False);
            }
        }

        private sealed class EntityCompilerFixture : IDisposable
        {
            public const string ProjectId = "tests.entity.project";

            public EntityCompilerFixture(
                IReadOnlyList<string> documentTypes = null,
                IReadOnlyList<string> registeredTypes = null,
                string structuredRegisteredType = null)
            {
                Root = Path.Combine(Path.GetTempPath(), "VisualBridgeEntityCompilerTests", Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(Path.Combine(Root, "ProjectSettings"));
                Directory.CreateDirectory(Path.Combine(Root, "Authoring", "Catalog"));
                Directory.CreateDirectory(Path.Combine(Root, "Authoring", "Entities"));
                WriteProfile(registeredTypes ?? DefaultRegisteredTypes(), structuredRegisteredType);
                var types = new List<string>(documentTypes ?? new[] { EntityDocumentType("tests.hero", "Entities/**/*.vbentity") });
                if (structuredRegisteredType != null)
                {
                    Directory.CreateDirectory(Path.Combine(Root, "Authoring", "Config"));
                    types.Add("{\"id\":\"tests.compiler.settings\",\"editor\":\"structured\",\"include\":[\"Config/**/*.json\"],\"exclude\":[],\"catalogs\":[\"Catalog/Compiler.vbstructuredcatalog\"]}");
                }

                WriteProject(types, structuredRegisteredType != null);
                VisualBridgeEntityCatalogExporter.Export(Root, VisualBridgeCatalogExportMode.Generate);
                if (structuredRegisteredType != null)
                {
                    VisualBridgeStructuredCatalogExporter.Export(Root, VisualBridgeCatalogExportMode.Generate);
                }
            }

            public string Root { get; }

            public string OutputRoot => Path.Combine(Root, "Library", "VisualBridge", "Compiled");

            public string DocumentPath => Path.Combine(Root, "Authoring", "Entities", "Hero.vbentity");

            public string ArtifactPath => Path.Combine(OutputRoot, "documents", ProjectId, "tests.hero", "tests.entity.default.vbcompiled.json");

            public string MappingPath => Path.Combine(OutputRoot, "mappings", ProjectId, "tests.hero", "tests.entity.default.vbsource.json");

            public string ManifestPath => Path.Combine(OutputRoot, "manifest.entity.json");

            public static string EntityDocumentType(string id, string include)
            {
                return "{\"id\":\"" + id + "\",\"editor\":\"entity\",\"include\":[\"" + include + "\"],\"exclude\":[],\"catalogs\":[\"Catalog/Test.vbentitycatalog\"]}";
            }

            public void WriteValidDocument()
            {
                WriteDocument(
                    "{\n  \"formatVersion\": 1,\n  \"documentId\": \"tests.entity.default\",\n  \"entityTypeId\": \"tests.hero\",\n  \"title\": \"Hero\",\n"
                    + "  \"properties\": { \"name\": \"configured\" },\n"
                    + "  \"components\": [\n"
                    + "    { \"id\": \"health\", \"componentTypeId\": \"tests.health\", \"enabled\": true, \"properties\": { \"maxHealth\": 250 } },\n"
                    + "    { \"id\": \"move\", \"componentTypeId\": \"tests.movement\", \"enabled\": true, \"properties\": {} }\n"
                    + "  ]\n}\n");
            }

            public void WriteDocument(string text)
            {
                File.WriteAllText(DocumentPath, text, Utf8WithoutBom);
            }

            public void WriteProject(IReadOnlyList<string> documentTypes, bool includeConfigRoot)
            {
                var roots = includeConfigRoot ? "\"Config\", \"Entities\"" : "\"Entities\"";
                File.WriteAllText(
                    Path.Combine(Root, "Authoring", "VisualBridge.project.vbjson"),
                    "{\n  \"formatVersion\": 1,\n  \"projectId\": \"" + ProjectId + "\",\n  \"documentRoots\": [" + roots + "],\n  \"documentTypes\": [" + string.Join(",", documentTypes) + "]\n}\n",
                    Utf8WithoutBom);
            }

            public void Dispose()
            {
                if (Directory.Exists(Root))
                {
                    Directory.Delete(Root, true);
                }
            }

            private static IReadOnlyList<string> DefaultRegisteredTypes()
            {
                return new[]
                {
                    typeof(EntityCompilerHeroType).AssemblyQualifiedName,
                    typeof(EntityExporterEnemyType).AssemblyQualifiedName,
                    typeof(EntityExporterHealthComponent).AssemblyQualifiedName,
                    typeof(EntityExporterMovementComponent).AssemblyQualifiedName,
                    typeof(EntityCompilerUnusedGroupComponent).AssemblyQualifiedName,
                };
            }

            private void WriteProfile(IEnumerable<string> registeredTypes, string structuredRegisteredType)
            {
                var types = string.Join(",", registeredTypes.Select(JsonConvert.ToString));
                var exports = "{\"catalogId\": \"tests.visualbridge.entity\""
                    + ", \"title\": \"VisualBridge Entity Exporter Tests\", \"output\": \"Authoring/Catalog/Test.vbentitycatalog\", \"types\": [" + types + "]}";
                if (structuredRegisteredType != null)
                {
                    exports += ", {\"catalogId\": \"tests.visualbridge.compiler.catalog\""
                        + ", \"title\": \"VisualBridge Compiler Tests\", \"output\": \"Authoring/Catalog/Compiler.vbstructuredcatalog\", \"types\": ["
                        + JsonConvert.ToString(structuredRegisteredType) + "]}";
                }

                File.WriteAllText(
                    Path.Combine(Root, "ProjectSettings", "VisualBridgeIntegration.json"),
                    "{\n  \"formatVersion\": 1,\n  \"authoringProject\": \"Authoring/VisualBridge.project.vbjson\",\n  \"catalogExports\": [" + exports + "],\n  \"compileOutputRoot\": \"Library/VisualBridge/Compiled\"\n}\n",
                    Utf8WithoutBom);
            }
        }
    }
}
