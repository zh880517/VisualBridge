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

[assembly: VisualBridgeEntityCatalog("tests.visualbridge.entity", "VisualBridge Entity Exporter Tests")]
[assembly: VisualBridgeEntityComponentGroup("tests.visualbridge.entity", "tests.group.combat", "Combat")]
[assembly: VisualBridgeEntityComponentGroup("tests.visualbridge.entity", "tests.group.movement", "Movement")]
[assembly: VisualBridgeEntityComponentGroup("tests.visualbridge.entity", "tests.group.unused", "Unused", Aliases = new[] { "tests.group.legacy" })]

namespace VisualBridge.Editor.Tests
{
    [VisualBridgeEntityType("tests.visualbridge.entity", "tests.hero", "Hero", Aliases = new[] { "tests.hero.legacy" })]
    public sealed class EntityExporterHeroType
    {
        [VisualBridgeField("name", "Name", Order = 0, DefaultJson = "\"Hero\"", Editor = VisualBridgeEditorKind.Text)]
        public string Name;

        [VisualBridgeField("level", "Level", Order = 1, DefaultJson = "1", Editor = VisualBridgeEditorKind.Number, Integer = true)]
        public int Level;
    }

    [VisualBridgeEntityType("tests.visualbridge.entity", "tests.hero", "Duplicate Hero")]
    public sealed class EntityExporterDuplicateHeroType
    {
        [VisualBridgeField("name", "Name", DefaultJson = "\"Hero\"", Editor = VisualBridgeEditorKind.Text)]
        public string Name;
    }

    [VisualBridgeEntityType(
        "tests.visualbridge.entity",
        "tests.enemy",
        "Enemy",
        AllowedComponentGroupIds = new[] { "tests.group.combat", "tests.group.movement" })]
    public sealed class EntityExporterEnemyType
    {
        [VisualBridgeField("name", "Name", Order = 0, DefaultJson = "\"Enemy\"", Editor = VisualBridgeEditorKind.Text)]
        public string Name;
    }

    [VisualBridgeEntityType("tests.visualbridge.entity", "tests.unknown-group", "Unknown Group", AllowedComponentGroupIds = new[] { "tests.group.missing" })]
    public sealed class EntityExporterUnknownGroupType
    {
        [VisualBridgeField("name", "Name", DefaultJson = "\"x\"", Editor = VisualBridgeEditorKind.Text)]
        public string Name;
    }

    [VisualBridgeEntityType("tests.visualbridge.entity", "tests.both", "Both")]
    [VisualBridgeEntityComponent("tests.visualbridge.entity", "tests.both", "Both", "tests.group.combat")]
    public sealed class EntityExporterBothMetadataType
    {
        [VisualBridgeField("name", "Name", DefaultJson = "\"x\"", Editor = VisualBridgeEditorKind.Text)]
        public string Name;
    }

    public sealed class EntityExporterMissingMetadataType
    {
    }

    [VisualBridgeEntityComponent("tests.visualbridge.entity", "tests.health", "Health", "tests.group.combat", MenuPath = new[] { "Combat", "Health" })]
    public sealed class EntityExporterHealthComponent
    {
        [VisualBridgeField("maxHealth", "Max Health", Order = 0, DefaultJson = "100", Editor = VisualBridgeEditorKind.Number, Integer = true)]
        public int MaxHealth;

        [VisualBridgeField("regen", "Regen", Order = 1, DefaultJson = "0.5", Editor = VisualBridgeEditorKind.Number, Step = 0.1)]
        public float Regen;
    }

    [VisualBridgeEntityComponent("tests.visualbridge.entity", "tests.movement", "Movement", "tests.group.movement")]
    public struct EntityExporterMovementComponent
    {
        [VisualBridgeField("speed", "Speed", DefaultJson = "3.5", Editor = VisualBridgeEditorKind.Number)]
        public float Speed;
    }

    [VisualBridgeEntityComponent("tests.visualbridge.entity", "tests.unknown-component-group", "Unknown Group", "tests.group.missing")]
    public sealed class EntityExporterUnknownGroupComponent
    {
        [VisualBridgeField("value", "Value", DefaultJson = "1", Editor = VisualBridgeEditorKind.Number)]
        public float Value;
    }

    public sealed class VisualBridgeEntityCatalogExporterTests
    {
        private static readonly UTF8Encoding Utf8WithoutBom = new UTF8Encoding(false);

        [Test]
        public void GenerateIsDeterministic()
        {
            using (var fixture = new EntityExportFixture(new[]
            {
                typeof(EntityExporterHeroType).AssemblyQualifiedName,
                typeof(EntityExporterHealthComponent).AssemblyQualifiedName,
                typeof(EntityExporterMovementComponent).AssemblyQualifiedName,
            }))
            {
                var first = VisualBridgeEntityCatalogExporter.Export(fixture.Root, VisualBridgeCatalogExportMode.Generate);
                var firstBytes = File.ReadAllBytes(fixture.OutputPath);
                var second = VisualBridgeEntityCatalogExporter.Export(fixture.Root, VisualBridgeCatalogExportMode.Generate);
                var secondBytes = File.ReadAllBytes(fixture.OutputPath);

                Assert.That(first.DriftDetected, Is.True);
                Assert.That(second.DriftDetected, Is.False);
                Assert.That(secondBytes, Is.EqualTo(firstBytes));
            }
        }

        [Test]
        public void TypeOrderDoesNotChangeCatalogBytesOrSourceHash()
        {
            var firstOrder = new[]
            {
                typeof(EntityExporterHeroType).AssemblyQualifiedName,
                typeof(EntityExporterHealthComponent).AssemblyQualifiedName,
            };
            var secondOrder = firstOrder.Reverse().ToArray();
            using (var first = new EntityExportFixture(firstOrder))
            using (var second = new EntityExportFixture(secondOrder))
            {
                VisualBridgeEntityCatalogExporter.Export(first.Root, VisualBridgeCatalogExportMode.Generate);
                VisualBridgeEntityCatalogExporter.Export(second.Root, VisualBridgeCatalogExportMode.Generate);
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
            using (var fixture = new EntityExportFixture(typeof(EntityExporterHeroType).AssemblyQualifiedName))
            {
                VisualBridgeEntityCatalogExporter.Export(fixture.Root, VisualBridgeCatalogExportMode.Generate);
                var drift = Utf8WithoutBom.GetBytes("{}\n");
                File.WriteAllBytes(fixture.OutputPath, drift);

                var result = VisualBridgeEntityCatalogExporter.Export(fixture.Root, VisualBridgeCatalogExportMode.Check);

                Assert.That(result.DriftDetected, Is.True);
                Assert.That(File.ReadAllBytes(fixture.OutputPath), Is.EqualTo(drift));
            }
        }

        [Test]
        public void CatalogContainsGroupsEntityTypesAndComponentTypes()
        {
            using (var fixture = new EntityExportFixture(new[]
            {
                typeof(EntityExporterHeroType).AssemblyQualifiedName,
                typeof(EntityExporterEnemyType).AssemblyQualifiedName,
                typeof(EntityExporterHealthComponent).AssemblyQualifiedName,
                typeof(EntityExporterMovementComponent).AssemblyQualifiedName,
            }))
            {
                VisualBridgeEntityCatalogExporter.Export(fixture.Root, VisualBridgeCatalogExportMode.Generate);
                var catalog = JObject.Parse(File.ReadAllText(fixture.OutputPath));

                Assert.That(catalog["formatVersion"]?.Value<int>(), Is.EqualTo(1));
                Assert.That(catalog["catalogId"]?.Value<string>(), Is.EqualTo("tests.visualbridge.entity"));
                Assert.That(catalog["source"]?["status"]?.Value<string>(), Is.EqualTo("current"));
                Assert.That(catalog["source"]?["providerId"]?.Value<string>(), Is.EqualTo("unity.csharp"));
                Assert.That(catalog["source"]?["sourceHash"]?.Value<string>().Length, Is.EqualTo(64));

                var groups = ((JArray)catalog["componentGroups"]).Cast<JObject>().ToList();
                Assert.That(groups.Select(group => group.Value<string>("id")).ToArray(), Is.EqualTo(new[]
                {
                    "tests.group.combat",
                    "tests.group.movement",
                    "tests.group.unused",
                }));
                Assert.That(groups[2]["aliases"]?.Values<string>(), Is.EqualTo(new[] { "tests.group.legacy" }));

                var entityTypes = ((JArray)catalog["entityTypes"]).Cast<JObject>().ToList();
                Assert.That(entityTypes.Select(entityType => entityType.Value<string>("id")).ToArray(), Is.EqualTo(new[]
                {
                    "tests.enemy",
                    "tests.hero",
                }));
                Assert.That(entityTypes[1]["aliases"]?.Values<string>(), Is.EqualTo(new[] { "tests.hero.legacy" }));
                Assert.That(entityTypes[0]["allowedComponentGroupIds"]?.Values<string>(), Is.EqualTo(new[]
                {
                    "tests.group.combat",
                    "tests.group.movement",
                }));
                Assert.That(entityTypes[1]["properties"]?[0]?["editor"]?["kind"]?.Value<string>(), Is.EqualTo("text"));

                var componentTypes = ((JArray)catalog["componentTypes"]).Cast<JObject>().ToList();
                Assert.That(componentTypes.Select(componentType => componentType.Value<string>("id")).ToArray(), Is.EqualTo(new[]
                {
                    "tests.health",
                    "tests.movement",
                }));
                Assert.That(componentTypes[0]["groupId"]?.Value<string>(), Is.EqualTo("tests.group.combat"));
                Assert.That(componentTypes[0]["menuPath"]?.Values<string>(), Is.EqualTo(new[] { "Combat", "Health" }));
                Assert.That(componentTypes[0]["source"]?["providerId"]?.Value<string>(), Is.EqualTo("unity.csharp"));
                Assert.That(componentTypes[0]["source"]?["typeName"]?.Value<string>(), Is.EqualTo(typeof(EntityExporterHealthComponent).AssemblyQualifiedName));
                Assert.That(componentTypes[0]["properties"]?[0]?["editor"]?["integer"]?.Value<bool>(), Is.True);
            }
        }

        [TestCase("Missing.Type, Missing.Assembly", "catalog.typeNotFound")]
        [TestCase(null, "catalog.metadataMissing")]
        public void InvalidRegisteredTypeFailsClosed(string registeredType, string expectedCode)
        {
            registeredType = registeredType ?? typeof(EntityExporterMissingMetadataType).AssemblyQualifiedName;
            using (var fixture = new EntityExportFixture(registeredType))
            {
                var exception = Assert.Throws<VisualBridgeIntegrationException>(() =>
                    VisualBridgeEntityCatalogExporter.Export(fixture.Root, VisualBridgeCatalogExportMode.Check));
                Assert.That(exception.Code, Is.EqualTo(expectedCode));
            }
        }

        [TestCase(typeof(EntityExporterDuplicateHeroType), "catalog.identityConflict")]
        [TestCase(typeof(EntityExporterUnknownGroupType), "catalog.invalidReference")]
        [TestCase(typeof(EntityExporterBothMetadataType), "catalog.duplicateMetadata")]
        [TestCase(typeof(EntityExporterUnknownGroupComponent), "catalog.invalidReference")]
        public void InvalidEntitySemanticsFailClosed(Type type, string expectedCode)
        {
            var registeredTypes = type == typeof(EntityExporterDuplicateHeroType)
                ? new[]
                {
                    typeof(EntityExporterHeroType).AssemblyQualifiedName,
                    typeof(EntityExporterDuplicateHeroType).AssemblyQualifiedName,
                }
                : new[] { type.AssemblyQualifiedName };
            using (var fixture = new EntityExportFixture(registeredTypes))
            {
                var exception = Assert.Throws<VisualBridgeIntegrationException>(() =>
                    VisualBridgeEntityCatalogExporter.Export(fixture.Root, VisualBridgeCatalogExportMode.Check));
                Assert.That(exception.Code, Is.EqualTo(expectedCode));
            }
        }

        [Test]
        public void StructuredExporterSkipsEntityOutputsAndViceVersa()
        {
            using (var fixture = new EntityExportFixture(new[]
            {
                typeof(EntityExporterHeroType).AssemblyQualifiedName,
                typeof(EntityExporterHealthComponent).AssemblyQualifiedName,
            }))
            {
                var structuredResult = VisualBridgeStructuredCatalogExporter.Export(fixture.Root, VisualBridgeCatalogExportMode.Check);
                Assert.That(structuredResult.Outputs, Is.Empty);

                var entityResult = VisualBridgeEntityCatalogExporter.Export(fixture.Root, VisualBridgeCatalogExportMode.Generate);
                Assert.That(entityResult.Outputs.Count, Is.EqualTo(1));
                Assert.That(entityResult.Outputs[0].Path, Is.EqualTo(fixture.OutputPath));
            }
        }

        [Test]
        public void MixedProfileRoutesEachExportToItsExporter()
        {
            using (var fixture = new EntityExportFixture(
                new[] { typeof(EntityExporterHeroType).AssemblyQualifiedName },
                typeof(ExporterTestSettings).AssemblyQualifiedName))
            {
                var structuredResult = VisualBridgeStructuredCatalogExporter.Export(fixture.Root, VisualBridgeCatalogExportMode.Generate);
                var entityResult = VisualBridgeEntityCatalogExporter.Export(fixture.Root, VisualBridgeCatalogExportMode.Generate);

                Assert.That(structuredResult.Outputs.Count, Is.EqualTo(1));
                Assert.That(structuredResult.Outputs[0].Path, Is.EqualTo(fixture.StructuredOutputPath));
                Assert.That(entityResult.Outputs.Count, Is.EqualTo(1));
                Assert.That(entityResult.Outputs[0].Path, Is.EqualTo(fixture.OutputPath));
                Assert.That(File.Exists(fixture.StructuredOutputPath), Is.True);
                Assert.That(File.Exists(fixture.OutputPath), Is.True);
            }
        }

        [Test]
        public void EntityCatalogMustBeDeclaredByEntityDocumentType()
        {
            using (var fixture = new EntityExportFixture(typeof(EntityExporterHeroType).AssemblyQualifiedName))
            {
                var projectPath = Path.Combine(fixture.Root, "Authoring", "VisualBridge.project.vbjson");
                var project = JObject.Parse(File.ReadAllText(projectPath));
                project["documentTypes"][0]["catalogs"] = new JArray("Catalog/Other.vbentitycatalog");
                File.WriteAllText(projectPath, project.ToString(Formatting.Indented) + "\n", Utf8WithoutBom);

                var exception = Assert.Throws<VisualBridgeIntegrationException>(() =>
                    VisualBridgeEntityCatalogExporter.Export(fixture.Root, VisualBridgeCatalogExportMode.Check));
                Assert.That(exception.Code, Is.EqualTo("profile.catalogNotDeclared"));
            }
        }

        [Test]
        public void ValidatorRejectsUnknownPropertiesAndMissingGroups()
        {
            var catalog = JObject.Parse("{\"formatVersion\":1,\"catalogId\":\"tests.entity\",\"title\":\"Tests\",\"source\":{\"status\":\"current\",\"providerId\":\"unity.csharp\"},\"componentGroups\":[],\"entityTypes\":[],\"componentTypes\":[]}");
            Assert.That(
                Assert.Throws<VisualBridgeIntegrationException>(() => VisualBridgeEntityCatalogValidator.Validate(catalog)).Code,
                Is.EqualTo("catalog.missingProperty"));

            catalog = JObject.Parse("{\"formatVersion\":1,\"catalogId\":\"tests.entity\",\"title\":\"Tests\",\"source\":{\"status\":\"unknown\",\"unexpected\":true},\"componentGroups\":[],\"entityTypes\":[],\"componentTypes\":[]}");
            Assert.That(
                Assert.Throws<VisualBridgeIntegrationException>(() => VisualBridgeEntityCatalogValidator.Validate(catalog)).Code,
                Is.EqualTo("catalog.unknownProperty"));

            catalog = JObject.Parse("{\"formatVersion\":1,\"catalogId\":\"tests.entity\",\"title\":\"Tests\",\"source\":{\"status\":\"unknown\"},\"componentGroups\":[{\"id\":\"tests.group\",\"title\":\"Group\",\"aliases\":[]}],\"entityTypes\":[],\"componentTypes\":[{\"id\":\"tests.health\",\"title\":\"Health\",\"aliases\":[],\"groupId\":\"tests.missing\",\"menuPath\":[],\"properties\":[]}]}");
            Assert.That(
                Assert.Throws<VisualBridgeIntegrationException>(() => VisualBridgeEntityCatalogValidator.Validate(catalog)).Code,
                Is.EqualTo("catalog.invalidReference"));

            catalog = JObject.Parse("{\"formatVersion\":1,\"catalogId\":\"tests.entity\",\"title\":\"Tests\",\"source\":{\"status\":\"unknown\"},\"componentGroups\":[{\"id\":\"tests.group\",\"title\":\"Group\",\"aliases\":[]}],\"entityTypes\":[{\"id\":\"tests.hero\",\"title\":\"Hero\",\"aliases\":[],\"allowedComponentGroupIds\":[\"tests.missing\"],\"properties\":[]}],\"componentTypes\":[]}");
            Assert.That(
                Assert.Throws<VisualBridgeIntegrationException>(() => VisualBridgeEntityCatalogValidator.Validate(catalog)).Code,
                Is.EqualTo("catalog.invalidReference"));
        }

        private sealed class EntityExportFixture : IDisposable
        {
            public EntityExportFixture(string registeredType, string structuredRegisteredType = null)
                : this(new[] { registeredType }, structuredRegisteredType)
            {
            }

            public EntityExportFixture(IReadOnlyList<string> registeredTypes, string structuredRegisteredType = null)
            {
                Root = Path.Combine(Path.GetTempPath(), "VisualBridgeEntityExporterTests", Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(Path.Combine(Root, "ProjectSettings"));
                Directory.CreateDirectory(Path.Combine(Root, "Authoring"));

                var documentTypes = new List<string>
                {
                    "{\"id\": \"tests.entities\", \"editor\": \"entity\", \"include\": [\"Entities/**/*.character\"], \"catalogs\": [\"Catalog/Test.vbentitycatalog\"]}",
                };
                if (structuredRegisteredType != null)
                {
                    documentTypes.Add("{\"id\": \"tests.settings\", \"editor\": \"structured\", \"include\": [\"Config/**/*.json\"], \"catalogs\": [\"Catalog/Test.vbstructuredcatalog\"]}");
                }

                File.WriteAllText(
                    Path.Combine(Root, "Authoring", "VisualBridge.project.vbjson"),
                    "{\n  \"formatVersion\": 1,\n  \"projectId\": \"tests.project\",\n  \"documentRoots\": [\"Config\", \"Entities\"],\n  \"documentTypes\": [" + string.Join(",", documentTypes) + "]\n}\n",
                    Utf8WithoutBom);

                var serializedTypes = string.Join(", ", registeredTypes.Select(JsonConvert.ToString));
                var exports = "{\"catalogId\": \"tests.visualbridge.entity\""
                    + ", \"title\": \"VisualBridge Entity Exporter Tests\", \"output\": \"Authoring/Catalog/Test.vbentitycatalog\", \"types\": [" + serializedTypes + "]}";
                if (structuredRegisteredType != null)
                {
                    exports += ", {\"catalogId\": \"tests.visualbridge.catalog\", \"title\": \"VisualBridge Exporter Tests\", \"output\": \"Authoring/Catalog/Test.vbstructuredcatalog\", \"types\": ["
                        + JsonConvert.ToString(structuredRegisteredType) + "]}";
                }

                ProfilePath = Path.Combine(Root, "ProjectSettings", "VisualBridgeIntegration.json");
                File.WriteAllText(
                    ProfilePath,
                    "{\n  \"formatVersion\": 1,\n  \"authoringProject\": \"Authoring/VisualBridge.project.vbjson\",\n  \"catalogExports\": [" + exports + "],\n  \"compileOutputRoot\": \"Library/VisualBridge\"\n}\n",
                    Utf8WithoutBom);
                OutputPath = Path.Combine(Root, "Authoring", "Catalog", "Test.vbentitycatalog");
                StructuredOutputPath = Path.Combine(Root, "Authoring", "Catalog", "Test.vbstructuredcatalog");
            }

            public string Root { get; }

            public string OutputPath { get; }

            public string StructuredOutputPath { get; }

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
