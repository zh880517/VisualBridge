using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using VisualBridge.Runtime;
using VisualBridge.Editor;
using NUnit.Framework;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;

[assembly: VisualBridgeStructuredCatalog("tests.visualbridge.catalog", "VisualBridge Exporter Tests")]

namespace VisualBridge.Editor.Tests
{
    public enum ExporterTestMode
    {
        Alpha,
        Beta,
    }

    public struct ExporterTestNested
    {
        [VisualBridgeField("name", "Name", DefaultJson = "\"nested\"", Editor = VisualBridgeEditorKind.Text)]
        public string Name;
    }

    [VisualBridgeStructuredConfig("tests.visualbridge.catalog", "tests.settings", "Test Settings")]
    public sealed class ExporterTestSettings
    {
        public static int ConstructorCallCount;

        public ExporterTestSettings()
        {
            ConstructorCallCount++;
        }

        [VisualBridgeField("count", "Count", Order = 0, DefaultJson = "2", Editor = VisualBridgeEditorKind.Number, Integer = true)]
        public int Count;

        [VisualBridgeField("mode", "Mode", Order = 1, DefaultJson = "\"Beta\"")]
        public ExporterTestMode Mode;

        [VisualBridgeField("nested", "Nested", Order = 2, DataTypeId = "tests.nested")]
        public ExporterTestNested Nested;

        [VisualBridgeField("values", "Values", Order = 3, DataTypeId = "list.int", DefaultJson = "[1,2]")]
        public List<int> Values;
    }

    public sealed class ExporterMissingMetadataSettings
    {
    }

    [VisualBridgeStructuredConfig("tests.visualbridge.catalog", "tests.bad-select", "Bad Select")]
    public sealed class ExporterBadSelectSettings
    {
        [VisualBridgeField("name", "Name", DefaultJson = "\"value\"", Editor = VisualBridgeEditorKind.Select)]
        public string Name;
    }

    [VisualBridgeStructuredConfig("tests.visualbridge.catalog", "tests.secondary", "Secondary Settings")]
    public sealed class ExporterSecondarySettings
    {
        [VisualBridgeField("enabled", "Enabled", DefaultJson = "true", Editor = VisualBridgeEditorKind.Checkbox)]
        public bool Enabled;
    }

    [VisualBridgeStructuredConfig("tests.visualbridge.catalog", "tests.auto-numeric", "Auto Numeric")]
    public sealed class ExporterAutoNumericSettings
    {
        [VisualBridgeField("count", "Count", DefaultJson = "2")]
        public int Count;

        [VisualBridgeField("ratio", "Ratio", DefaultJson = "0.5")]
        public float Ratio;

        [VisualBridgeField("name", "Name", DefaultJson = "\"read only\"", ReadOnly = true)]
        public string Name;
    }

    [VisualBridgeStructuredConfig("tests.visualbridge.catalog", "tests.decimal", "Decimal")]
    public sealed class ExporterDecimalSettings
    {
        [VisualBridgeField("value", "Value", DefaultJson = "1.5")]
        public decimal Value;
    }

    [VisualBridgeStructuredConfig("tests.visualbridge.catalog", "tests.fractional-int", "Fractional Int")]
    public sealed class ExporterFractionalIntSettings
    {
        [VisualBridgeField("value", "Value", DefaultJson = "1.5")]
        public int Value;
    }

    [VisualBridgeStructuredConfig("tests.visualbridge.catalog", "tests.byte-range", "Byte Range")]
    public sealed class ExporterByteRangeSettings
    {
        [VisualBridgeField("value", "Value", DefaultJson = "256")]
        public byte Value;
    }

    [VisualBridgeStructuredConfig("tests.visualbridge.catalog", "tests.list-fractional", "List Fractional")]
    public sealed class ExporterListFractionalSettings
    {
        [VisualBridgeField("values", "Values", DefaultJson = "[1,1.5]")]
        public List<int> Values;
    }

    [VisualBridgeStructuredConfig("tests.visualbridge.catalog", "tests.reference-editor", "Reference Editor")]
    public sealed class ExporterReferenceEditorWithoutMetadataSettings
    {
        [VisualBridgeField("target", "Target", DefaultJson = "1", Editor = VisualBridgeEditorKind.Reference)]
        public int Target;
    }

    [VisualBridgeStructuredConfig("tests.visualbridge.catalog", "tests.reference-metadata", "Reference Metadata")]
    public sealed class ExporterReferenceMetadataWithoutEditorSettings
    {
        [VisualBridgeField("target", "Target", DefaultJson = "1", ReferenceKind = "table.row", ReferenceTargetJson = "{\"tableTypeId\":\"tests\"}")]
        public int Target;
    }

    [VisualBridgeStructuredConfig("tests.visualbridge.catalog", "tests.allow-missing", "Allow Missing")]
    public sealed class ExporterAllowMissingWithoutReferenceSettings
    {
        [VisualBridgeField("target", "Target", DefaultJson = "1", AllowMissingReference = true)]
        public int Target;
    }

    [VisualBridgeStructuredConfig("tests.visualbridge.catalog", "tests.color", "Color")]
    public sealed class ExporterColorSettings
    {
        [VisualBridgeField("rgb", "RGB", DefaultJson = "\"#A1B2C3\"", Editor = VisualBridgeEditorKind.Color)]
        public string Rgb;

        [VisualBridgeField("rgba", "RGBA", DefaultJson = "\"#A1B2C3D4\"", Editor = VisualBridgeEditorKind.Color)]
        public string Rgba;
    }

    [VisualBridgeStructuredConfig("tests.visualbridge.catalog", "tests.bad-color", "Bad Color")]
    public sealed class ExporterBadColorSettings
    {
        [VisualBridgeField("color", "Color", DefaultJson = "\"red\"", Editor = VisualBridgeEditorKind.Color)]
        public string Color;
    }

    [VisualBridgeStructuredConfig("tests.visualbridge.catalog", "tests.enum-default", "Enum Default")]
    public sealed class ExporterEnumWithoutDefaultSettings
    {
        [VisualBridgeField("mode", "Mode")]
        public ExporterTestMode Mode;
    }

    public sealed class VisualBridgeStructuredCatalogExporterTests
    {
        private static readonly UTF8Encoding Utf8WithoutBom = new UTF8Encoding(false);

        [Test]
        public void GenerateIsDeterministicAndDoesNotConstructConfigType()
        {
            using (var fixture = new ExportFixture(typeof(ExporterTestSettings).AssemblyQualifiedName))
            {
                ExporterTestSettings.ConstructorCallCount = 0;
                var first = VisualBridgeStructuredCatalogExporter.Export(fixture.Root, VisualBridgeCatalogExportMode.Generate);
                var firstBytes = File.ReadAllBytes(fixture.OutputPath);
                var second = VisualBridgeStructuredCatalogExporter.Export(fixture.Root, VisualBridgeCatalogExportMode.Generate);
                var secondBytes = File.ReadAllBytes(fixture.OutputPath);

                Assert.That(first.DriftDetected, Is.True);
                Assert.That(second.DriftDetected, Is.False);
                Assert.That(secondBytes, Is.EqualTo(firstBytes));
                Assert.That(ExporterTestSettings.ConstructorCallCount, Is.Zero);
            }
        }

        [Test]
        public void ProfileTypeOrderDoesNotChangeCatalogBytesOrSourceHash()
        {
            var firstOrder = new[]
            {
                typeof(ExporterTestSettings).AssemblyQualifiedName,
                typeof(ExporterSecondarySettings).AssemblyQualifiedName,
            };
            var secondOrder = firstOrder.Reverse().ToArray();
            using (var first = new ExportFixture(firstOrder))
            using (var second = new ExportFixture(secondOrder))
            {
                VisualBridgeStructuredCatalogExporter.Export(first.Root, VisualBridgeCatalogExportMode.Generate);
                VisualBridgeStructuredCatalogExporter.Export(second.Root, VisualBridgeCatalogExportMode.Generate);
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
            using (var fixture = new ExportFixture(typeof(ExporterTestSettings).AssemblyQualifiedName))
            {
                VisualBridgeStructuredCatalogExporter.Export(fixture.Root, VisualBridgeCatalogExportMode.Generate);
                var drift = Utf8WithoutBom.GetBytes("{}\n");
                File.WriteAllBytes(fixture.OutputPath, drift);

                var result = VisualBridgeStructuredCatalogExporter.Export(fixture.Root, VisualBridgeCatalogExportMode.Check);

                Assert.That(result.DriftDetected, Is.True);
                Assert.That(File.ReadAllBytes(fixture.OutputPath), Is.EqualTo(drift));
            }
        }

        [TestCase("Missing.Type, Missing.Assembly", "catalog.typeNotFound")]
        [TestCase(null, "catalog.metadataMissing")]
        public void InvalidRegisteredTypeFailsClosed(string registeredType, string expectedCode)
        {
            registeredType = registeredType ?? typeof(ExporterMissingMetadataSettings).AssemblyQualifiedName;
            using (var fixture = new ExportFixture(registeredType))
            {
                var exception = Assert.Throws<VisualBridgeIntegrationException>(() =>
                    VisualBridgeStructuredCatalogExporter.Export(fixture.Root, VisualBridgeCatalogExportMode.Check));
                Assert.That(exception.Code, Is.EqualTo(expectedCode));
            }
        }

        [Test]
        public void InvalidSelectMetadataFailsClosed()
        {
            using (var fixture = new ExportFixture(typeof(ExporterBadSelectSettings).AssemblyQualifiedName))
            {
                var exception = Assert.Throws<VisualBridgeIntegrationException>(() =>
                    VisualBridgeStructuredCatalogExporter.Export(fixture.Root, VisualBridgeCatalogExportMode.Check));
                Assert.That(exception.Code, Is.EqualTo("catalog.invalidEditor"));
            }
        }

        [Test]
        public void AutoNumberEditorsPreserveClrNumericSemanticsAndReadOnly()
        {
            using (var fixture = new ExportFixture(typeof(ExporterAutoNumericSettings).AssemblyQualifiedName))
            {
                VisualBridgeStructuredCatalogExporter.Export(fixture.Root, VisualBridgeCatalogExportMode.Generate);
                var properties = ((JArray)JObject.Parse(File.ReadAllText(fixture.OutputPath))["configTypes"]?[0]?["properties"])
                    .Cast<JObject>()
                    .ToDictionary(property => property.Value<string>("id"), StringComparer.Ordinal);

                Assert.That(properties["count"]["editor"]?["kind"]?.Value<string>(), Is.EqualTo("number"));
                Assert.That(properties["count"]["editor"]?["integer"]?.Value<bool>(), Is.True);
                Assert.That(properties["count"]["editor"]?["min"]?.Value<long>(), Is.EqualTo(int.MinValue));
                Assert.That(properties["count"]["editor"]?["max"]?.Value<long>(), Is.EqualTo(int.MaxValue));
                Assert.That(properties["ratio"]["editor"]?["kind"]?.Value<string>(), Is.EqualTo("number"));
                Assert.That(properties["ratio"]["editor"]?["integer"]?.Value<bool>(), Is.False);
                Assert.That(properties["name"]["editor"]?["kind"]?.Value<string>(), Is.EqualTo("text"));
                Assert.That(properties["name"]["editor"]?["readOnly"]?.Value<bool>(), Is.True);
            }
        }

        [TestCase(typeof(ExporterDecimalSettings), "catalog.typeUnsupported")]
        [TestCase(typeof(ExporterFractionalIntSettings), "catalog.invalidDefault")]
        [TestCase(typeof(ExporterByteRangeSettings), "catalog.invalidDefault")]
        [TestCase(typeof(ExporterListFractionalSettings), "catalog.invalidDefault")]
        [TestCase(typeof(ExporterReferenceEditorWithoutMetadataSettings), "catalog.invalidReference")]
        [TestCase(typeof(ExporterReferenceMetadataWithoutEditorSettings), "catalog.invalidReference")]
        [TestCase(typeof(ExporterAllowMissingWithoutReferenceSettings), "catalog.invalidReference")]
        [TestCase(typeof(ExporterBadColorSettings), "catalog.invalidColorDefault")]
        [TestCase(typeof(ExporterEnumWithoutDefaultSettings), "catalog.enumDefaultRequired")]
        public void InvalidFieldSemanticsFailClosed(Type type, string expectedCode)
        {
            using (var fixture = new ExportFixture(type.AssemblyQualifiedName))
            {
                var exception = Assert.Throws<VisualBridgeIntegrationException>(() =>
                    VisualBridgeStructuredCatalogExporter.Export(fixture.Root, VisualBridgeCatalogExportMode.Check));
                Assert.That(exception.Code, Is.EqualTo(expectedCode));
            }
        }

        [Test]
        public void RgbAndRgbaColorDefaultsAreAccepted()
        {
            using (var fixture = new ExportFixture(typeof(ExporterColorSettings).AssemblyQualifiedName))
            {
                Assert.DoesNotThrow(() =>
                    VisualBridgeStructuredCatalogExporter.Export(fixture.Root, VisualBridgeCatalogExportMode.Check));
            }
        }

        [TestCase("../outside.vbjson")]
        [TestCase("C:/outside.vbjson")]
        [TestCase("Authoring/project.vbjson:stream")]
        public void ProfileRejectsUnsafePaths(string authoringProject)
        {
            using (var fixture = new ExportFixture(typeof(ExporterTestSettings).AssemblyQualifiedName, authoringProject))
            {
                var exception = Assert.Throws<VisualBridgeIntegrationException>(() =>
                    VisualBridgeIntegrationProfileLoader.Load(fixture.Root));
                Assert.That(exception.Code, Is.EqualTo("profile.invalidPath"));
            }
        }

        [TestCase(" Type.Name, Test.Assembly")]
        [TestCase("Type.Name,   ")]
        public void ProfileRejectsNonCanonicalAssemblyQualifiedTypeNames(string registeredType)
        {
            using (var fixture = new ExportFixture(registeredType))
            {
                var exception = Assert.Throws<VisualBridgeIntegrationException>(() =>
                    VisualBridgeIntegrationProfileLoader.Load(fixture.Root));
                Assert.That(exception.Code, Is.EqualTo("profile.invalidType"));
            }
        }

        [Test]
        public void ProfileRejectsNonAsciiIdentifier()
        {
            using (var fixture = new ExportFixture(typeof(ExporterTestSettings).AssemblyQualifiedName))
            {
                var profilePath = Path.Combine(fixture.Root, "ProjectSettings", "VisualBridgeIntegration.json");
                File.WriteAllText(
                    profilePath,
                    File.ReadAllText(profilePath).Replace("tests.visualbridge.catalog", "tests.配置.catalog"),
                    Utf8WithoutBom);
                var exception = Assert.Throws<VisualBridgeIntegrationException>(() =>
                    VisualBridgeIntegrationProfileLoader.Load(fixture.Root));
                Assert.That(exception.Code, Is.EqualTo("profile.invalidIdentifier"));
            }
        }

        [Test]
        public void ProfileRejectsUnknownKeysAndUnsupportedVersion()
        {
            using (var fixture = new ExportFixture(typeof(ExporterTestSettings).AssemblyQualifiedName))
            {
                var profilePath = Path.Combine(fixture.Root, "ProjectSettings", "VisualBridgeIntegration.json");
                var original = File.ReadAllText(profilePath);
                File.WriteAllText(profilePath, original.Replace("{\n", "{\n  \"unexpected\": true,\n"), Utf8WithoutBom);
                Assert.That(
                    Assert.Throws<VisualBridgeIntegrationException>(() => VisualBridgeIntegrationProfileLoader.Load(fixture.Root)).Code,
                    Is.EqualTo("profile.unknownProperty"));

                File.WriteAllText(profilePath, original.Replace("\"formatVersion\": 1", "\"formatVersion\": 2"), Utf8WithoutBom);
                Assert.That(
                    Assert.Throws<VisualBridgeIntegrationException>(() => VisualBridgeIntegrationProfileLoader.Load(fixture.Root)).Code,
                    Is.EqualTo("profile.unsupportedVersion"));
            }
        }

        [Test]
        public void ProfileSchemaAndLoaderShareParityFixture()
        {
            var fixtureAsset = AssetDatabase.LoadAssetAtPath<TextAsset>(
                "Packages/com.kyle.visualbridge/Tests/Fixtures/visualbridge-unity-integration-profile-cases.json");
            Assert.That(fixtureAsset, Is.Not.Null);
            var cases = (JArray)JObject.Parse(fixtureAsset.text)["cases"];
            foreach (var testCase in cases.Cast<JObject>())
            {
                using (var fixture = new ExportFixture(typeof(ExporterTestSettings).AssemblyQualifiedName))
                {
                    File.WriteAllText(fixture.ProfilePath, testCase["value"].ToString(Formatting.Indented) + "\n", Utf8WithoutBom);
                    if (testCase.Value<bool>("valid"))
                    {
                        Assert.DoesNotThrow(
                            () => VisualBridgeIntegrationProfileLoader.Load(fixture.Root),
                            testCase.Value<string>("label"));
                    }
                    else
                    {
                        var exception = Assert.Throws<VisualBridgeIntegrationException>(
                            () => VisualBridgeIntegrationProfileLoader.Load(fixture.Root),
                            testCase.Value<string>("label"));
                        Assert.That(exception.Code, Is.EqualTo(testCase.Value<string>("loaderCode")), testCase.Value<string>("label"));
                    }
                }
            }
        }

        [Test]
        public void ProfileRejectsExistingHardLinkedOutputAliases()
        {
            if (Environment.OSVersion.Platform != PlatformID.Win32NT)
            {
                Assert.Ignore("Hard-link file identity coverage is Windows-specific.");
            }

            using (var fixture = new ExportFixture(typeof(ExporterTestSettings).AssemblyQualifiedName))
            {
                var catalogDirectory = Path.GetDirectoryName(fixture.OutputPath);
                Directory.CreateDirectory(catalogDirectory);
                var aliasPath = Path.Combine(catalogDirectory, "Alias.vbstructuredcatalog");
                File.WriteAllText(fixture.OutputPath, "{}\n", Utf8WithoutBom);
                if (!CreateHardLink(aliasPath, fixture.OutputPath, IntPtr.Zero))
                {
                    Assert.Fail("CreateHardLink failed with Win32 " + Marshal.GetLastWin32Error());
                }

                var typeName = JsonConvert.ToString(typeof(ExporterTestSettings).AssemblyQualifiedName);
                File.WriteAllText(
                    fixture.ProfilePath,
                    "{\n"
                    + "  \"formatVersion\": 1,\n"
                    + "  \"authoringProject\": \"Authoring/VisualBridge.project.vbjson\",\n"
                    + "  \"catalogExports\": [\n"
                    + "    {\"catalogId\": \"tests.catalog.a\", \"title\": \"A\", \"output\": \"Authoring/Catalog/Test.vbstructuredcatalog\", \"types\": [" + typeName + "]},\n"
                    + "    {\"catalogId\": \"tests.catalog.b\", \"title\": \"B\", \"output\": \"Authoring/Catalog/Alias.vbstructuredcatalog\", \"types\": [" + typeName + "]}\n"
                    + "  ],\n"
                    + "  \"compileOutputRoot\": \"Library/VisualBridge\"\n"
                    + "}\n",
                    Utf8WithoutBom);

                var exception = Assert.Throws<VisualBridgeIntegrationException>(() =>
                    VisualBridgeIntegrationProfileLoader.Load(fixture.Root));
                Assert.That(exception.Code, Is.EqualTo("profile.duplicatePhysicalOutput"));
            }
        }

        [Test]
        public void CatalogValidatorRejectsUnknownUnionShapeAndSelectOptions()
        {
            var catalog = Newtonsoft.Json.Linq.JObject.Parse("{\"formatVersion\":1,\"catalogId\":\"tests.catalog\",\"title\":\"Tests\",\"source\":{\"status\":\"current\",\"providerId\":\"unity.csharp\"},\"configTypes\":[]}");
            Assert.That(
                Assert.Throws<VisualBridgeIntegrationException>(() => VisualBridgeStructuredCatalogValidator.Validate(catalog)).Code,
                Is.EqualTo("catalog.missingProperty"));

            catalog = Newtonsoft.Json.Linq.JObject.Parse("{\"formatVersion\":1,\"catalogId\":\"tests.catalog\",\"title\":\"Tests\",\"source\":{\"status\":\"unknown\",\"extra\":true},\"configTypes\":[{\"id\":\"tests.settings\",\"title\":\"Settings\",\"aliases\":[],\"properties\":[]}]}");
            Assert.That(
                Assert.Throws<VisualBridgeIntegrationException>(() => VisualBridgeStructuredCatalogValidator.Validate(catalog)).Code,
                Is.EqualTo("catalog.unknownProperty"));

            catalog = Newtonsoft.Json.Linq.JObject.Parse("{\"formatVersion\":1,\"catalogId\":\"tests.catalog\",\"title\":\"Tests\",\"source\":{\"status\":\"unknown\"},\"configTypes\":[{\"id\":\"tests.settings\",\"title\":\"Settings\",\"aliases\":[],\"properties\":[{\"id\":\"field\",\"title\":\"Field\",\"valueType\":\"string\",\"defaultValue\":\"x\",\"item\":{\"valueType\":\"string\",\"defaultValue\":\"\"}}]}]}");
            Assert.That(
                Assert.Throws<VisualBridgeIntegrationException>(() => VisualBridgeStructuredCatalogValidator.Validate(catalog)).Code,
                Is.EqualTo("catalog.invalidValueShape"));

            catalog = Newtonsoft.Json.Linq.JObject.Parse("{\"formatVersion\":1,\"catalogId\":\"tests.catalog\",\"title\":\"Tests\",\"source\":{\"status\":\"unknown\"},\"configTypes\":[{\"id\":\"tests.settings\",\"title\":\"Settings\",\"aliases\":[],\"properties\":[{\"id\":\"field\",\"title\":\"Field\",\"valueType\":\"string\",\"defaultValue\":\"x\",\"editor\":{\"kind\":\"select\"}}]}]}");
            Assert.That(
                Assert.Throws<VisualBridgeIntegrationException>(() => VisualBridgeStructuredCatalogValidator.Validate(catalog)).Code,
                Is.EqualTo("catalog.invalidArray"));
        }

        [Test]
        public void ExporterUsesStrictProjectParserAndRejectsUnboundDocumentTypes()
        {
            using (var fixture = new ExportFixture(typeof(ExporterTestSettings).AssemblyQualifiedName))
            {
                var projectPath = Path.Combine(fixture.Root, "Authoring", "VisualBridge.project.vbjson");
                var project = JObject.Parse(File.ReadAllText(projectPath));
                project["unexpected"] = true;
                File.WriteAllText(projectPath, project.ToString(Formatting.Indented) + "\n", Utf8WithoutBom);
                Assert.That(
                    Assert.Throws<VisualBridgeIntegrationException>(() =>
                        VisualBridgeStructuredCatalogExporter.Export(fixture.Root, VisualBridgeCatalogExportMode.Check)).Code,
                    Is.EqualTo("compile.projectUnknownProperty"));

                project.Remove("unexpected");
                project["documentTypes"][0]["id"] = "tests.unknown";
                File.WriteAllText(projectPath, project.ToString(Formatting.Indented) + "\n", Utf8WithoutBom);
                Assert.That(
                    Assert.Throws<VisualBridgeIntegrationException>(() =>
                        VisualBridgeStructuredCatalogExporter.Export(fixture.Root, VisualBridgeCatalogExportMode.Check)).Code,
                    Is.EqualTo("profile.catalogDocumentTypeUnbound"));
            }
        }

        [Test]
        public void ExporterRequiresEveryConfigTypeToHaveOneDocumentType()
        {
            using (var fixture = new ExportFixture(new[]
            {
                typeof(ExporterTestSettings).AssemblyQualifiedName,
                typeof(ExporterSecondarySettings).AssemblyQualifiedName,
            }))
            {
                var projectPath = Path.Combine(fixture.Root, "Authoring", "VisualBridge.project.vbjson");
                var project = JObject.Parse(File.ReadAllText(projectPath));
                ((JArray)project["documentTypes"]).RemoveAt(1);
                File.WriteAllText(projectPath, project.ToString(Formatting.Indented) + "\n", Utf8WithoutBom);

                Assert.That(
                    Assert.Throws<VisualBridgeIntegrationException>(() =>
                        VisualBridgeStructuredCatalogExporter.Export(fixture.Root, VisualBridgeCatalogExportMode.Check)).Code,
                    Is.EqualTo("profile.configDocumentTypeMissing"));
            }
        }

        private sealed class ExportFixture : IDisposable
        {
            public ExportFixture(string registeredType, string authoringProject = "Authoring/VisualBridge.project.vbjson")
                : this(new[] { registeredType }, authoringProject)
            {
            }

            public ExportFixture(IReadOnlyList<string> registeredTypes, string authoringProject = "Authoring/VisualBridge.project.vbjson")
            {
                Root = Path.Combine(Path.GetTempPath(), "VisualBridgeExporterTests", Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(Path.Combine(Root, "ProjectSettings"));
                Directory.CreateDirectory(Path.Combine(Root, "Authoring"));
                var documentTypeIds = registeredTypes
                    .Select(registeredType => Type.GetType(registeredType, false, false))
                    .Where(type => type != null)
                    .Select(type => type.GetCustomAttributes(typeof(VisualBridgeStructuredConfigAttribute), false)
                        .OfType<VisualBridgeStructuredConfigAttribute>()
                        .SingleOrDefault()?.Id)
                    .Where(id => id != null)
                    .Distinct(StringComparer.Ordinal)
                    .ToArray();
                if (documentTypeIds.Length == 0)
                {
                    documentTypeIds = new[] { "tests.settings" };
                }

                var documentTypes = string.Join(",", documentTypeIds.Select((id, index) =>
                    "{\"id\": " + JsonConvert.ToString(id)
                        + ", \"editor\": \"structured\", \"include\": [\"Config/**/*." + index
                        + ".json\"], \"catalogs\": [\"Catalog/Test.vbstructuredcatalog\"]}"));
                File.WriteAllText(
                    Path.Combine(Root, "Authoring", "VisualBridge.project.vbjson"),
                    "{\n  \"formatVersion\": 1,\n  \"projectId\": \"tests.project\",\n  \"documentRoots\": [\"Config\"],\n  \"documentTypes\": [" + documentTypes + "]\n}\n",
                    Utf8WithoutBom);
                var serializedTypes = string.Join(", ", registeredTypes.Select(JsonConvert.ToString));
                var escapedProject = authoringProject.Replace("\\", "\\\\").Replace("\"", "\\\"");
                ProfilePath = Path.Combine(Root, "ProjectSettings", "VisualBridgeIntegration.json");
                File.WriteAllText(
                    ProfilePath,
                    "{\n  \"formatVersion\": 1,\n  \"authoringProject\": \"" + escapedProject + "\",\n  \"catalogExports\": [{\"catalogId\": \"tests.visualbridge.catalog\", \"title\": \"VisualBridge Exporter Tests\", \"output\": \"Authoring/Catalog/Test.vbstructuredcatalog\", \"types\": [" + serializedTypes + "]}],\n  \"compileOutputRoot\": \"Library/VisualBridge\"\n}\n",
                    Utf8WithoutBom);
                OutputPath = Path.Combine(Root, "Authoring", "Catalog", "Test.vbstructuredcatalog");
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

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateHardLinkW")]
        private static extern bool CreateHardLink(string newFileName, string existingFileName, IntPtr securityAttributes);
    }
}
