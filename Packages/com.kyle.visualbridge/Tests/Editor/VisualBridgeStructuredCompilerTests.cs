using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using VisualBridge.Runtime;
using Newtonsoft.Json.Linq;
using NUnit.Framework;

[assembly: VisualBridgeStructuredCatalog("tests.visualbridge.compiler.catalog", "VisualBridge Compiler Tests")]

namespace VisualBridge.Editor.Tests
{
    public enum CompilerTestMode
    {
        Alpha,
        Beta,
    }

    public sealed class CompilerTestNested
    {
        public static int ConstructorCallCount;

        public CompilerTestNested()
        {
            ConstructorCallCount++;
        }

        [VisualBridgeField("value", "Value", Aliases = new[] { "legacyValue" }, DefaultJson = "\"nested-default\"")]
        public string Value;
    }

    [VisualBridgeStructuredConfig(
        "tests.visualbridge.compiler.catalog",
        "tests.compiler.settings",
        "Compiler Settings",
        Aliases = new[] { "tests.compiler.legacy" })]
    public sealed class CompilerTestSettings
    {
        public static int ConstructorCallCount;

        public CompilerTestSettings()
        {
            ConstructorCallCount++;
        }

        [VisualBridgeField("name", "Name", Aliases = new[] { "label" }, DefaultJson = "\"metadata-default\"")]
        public string Name;

        [VisualBridgeField("enabled", "Enabled", DefaultJson = "true")]
        public bool Enabled;

        [VisualBridgeField("count", "Count", DefaultJson = "7", Editor = VisualBridgeEditorKind.Number, Integer = true)]
        public int Count;

        [VisualBridgeField("mode", "Mode", DefaultJson = "\"Beta\"")]
        public CompilerTestMode Mode;

        [VisualBridgeField("nested", "Nested")]
        public CompilerTestNested Nested;

        [VisualBridgeField("values", "Values", DefaultJson = "[1,2]")]
        public List<int> Values;
    }

    [VisualBridgeStructuredConfig("tests.visualbridge.compiler.catalog", "tests.compiler.other", "Other Settings")]
    public sealed class CompilerOtherSettings
    {
        [VisualBridgeField("value", "Value", DefaultJson = "\"other\"")]
        public string Value;
    }

    public sealed class VisualBridgeStructuredCompilerTests
    {
        private static readonly UTF8Encoding Utf8WithoutBom = new UTF8Encoding(false);

        [Test]
        public void GenerateMaterializesDefaultsWithoutBusinessConstructorsAndIsDeterministic()
        {
            using (var fixture = new CompilerFixture())
            {
                CompilerTestSettings.ConstructorCallCount = 0;
                CompilerTestNested.ConstructorCallCount = 0;
                fixture.WriteDocument("{\n  \"formatVersion\": 1,\n  \"documentId\": \"tests.compiler.default\",\n  \"properties\": {}\n}\n");

                var first = VisualBridgeStructuredCompiler.Compile(fixture.Root, VisualBridgeStructuredCompileMode.Generate);
                var firstSnapshot = first.Outputs.ToDictionary(output => output.Path, output => File.ReadAllBytes(output.Path));
                var second = VisualBridgeStructuredCompiler.Compile(fixture.Root, VisualBridgeStructuredCompileMode.Generate);

                Assert.That(first.DriftDetected, Is.True);
                Assert.That(second.DriftDetected, Is.False);
                Assert.That(second.Outputs.All(output => File.ReadAllBytes(output.Path).SequenceEqual(firstSnapshot[output.Path])), Is.True);
                Assert.That(CompilerTestSettings.ConstructorCallCount, Is.Zero);
                Assert.That(CompilerTestNested.ConstructorCallCount, Is.Zero);

                var artifact = JObject.Parse(File.ReadAllText(fixture.ArtifactPath));
                Assert.That(artifact.Value<string>("configTypeId"), Is.EqualTo("tests.compiler.settings"));
                Assert.That(artifact["data"]["name"].Value<string>(), Is.EqualTo("metadata-default"));
                Assert.That(artifact["data"]["enabled"].Value<bool>(), Is.True);
                Assert.That(artifact["data"]["count"].Value<int>(), Is.EqualTo(7));
                Assert.That(artifact["data"]["mode"].Value<string>(), Is.EqualTo("Beta"));
                Assert.That(artifact["data"]["nested"]["value"].Value<string>(), Is.EqualTo("nested-default"));
                Assert.That(artifact["data"]["values"].Values<int>(), Is.EqualTo(new[] { 1, 2 }));
                Assert.That(File.ReadAllBytes(fixture.ArtifactPath).Last(), Is.EqualTo((byte)'\n'));
            }
        }

        [Test]
        public void CatalogAndCompilerBatchExitCodesShareOneContract()
        {
            Assert.That(VisualBridgeStructuredCatalogBatch.SuccessExitCode, Is.EqualTo(0));
            Assert.That(VisualBridgeStructuredCatalogBatch.FailureExitCode, Is.EqualTo(1));
            Assert.That(VisualBridgeStructuredCatalogBatch.DriftExitCode, Is.EqualTo(2));
            Assert.That(VisualBridgeStructuredCompilerBatch.SuccessExitCode, Is.EqualTo(VisualBridgeStructuredCatalogBatch.SuccessExitCode));
            Assert.That(VisualBridgeStructuredCompilerBatch.FailureExitCode, Is.EqualTo(VisualBridgeStructuredCatalogBatch.FailureExitCode));
            Assert.That(VisualBridgeStructuredCompilerBatch.DriftExitCode, Is.EqualTo(VisualBridgeStructuredCatalogBatch.DriftExitCode));
        }

        [Test]
        public void CheckDetectsDriftWithoutWriting()
        {
            using (var fixture = new CompilerFixture())
            {
                fixture.WriteValidDocument();
                VisualBridgeStructuredCompiler.Compile(fixture.Root, VisualBridgeStructuredCompileMode.Generate);
                var drift = Utf8WithoutBom.GetBytes("{}\n");
                File.WriteAllBytes(fixture.ArtifactPath, drift);

                var result = VisualBridgeStructuredCompiler.Compile(fixture.Root, VisualBridgeStructuredCompileMode.Check);

                Assert.That(result.DriftDetected, Is.True);
                Assert.That(File.ReadAllBytes(fixture.ArtifactPath), Is.EqualTo(drift));
                Assert.That(Directory.GetFiles(fixture.OutputRoot, "*.tmp", SearchOption.AllDirectories), Is.Empty);
            }
        }

        [Test]
        public void RouteMustBeUnique()
        {
            using (var fixture = new CompilerFixture(includeOtherType: true))
            {
                fixture.WriteProject(new[]
                {
                    CompilerFixture.DocumentType("tests.compiler.settings", "Config/**/*.json"),
                    CompilerFixture.DocumentType("tests.compiler.other", "Config/**/*.json"),
                });
                fixture.WriteValidDocument();

                var exception = Assert.Throws<VisualBridgeIntegrationException>(() =>
                    VisualBridgeStructuredCompiler.Compile(fixture.Root, VisualBridgeStructuredCompileMode.Check));

                Assert.That(exception.Code, Is.EqualTo("compile.ambiguousRoute"));
            }
        }

        [Test]
        public void ConfigAndFieldAliasesResolveUniquelyAndCanonicalizeOutput()
        {
            using (var fixture = new CompilerFixture(documentTypeId: "tests.compiler.legacy"))
            {
                fixture.WriteDocument("{\n  \"formatVersion\": 1,\n  \"documentId\": \"tests.compiler.default\",\n  \"properties\": {\n    \"label\": \"legacy-name\",\n    \"nested\": { \"legacyValue\": \"legacy-nested\" }\n  }\n}\n");

                VisualBridgeStructuredCompiler.Compile(fixture.Root, VisualBridgeStructuredCompileMode.Generate);

                var artifact = JObject.Parse(File.ReadAllText(fixture.ArtifactPath));
                Assert.That(artifact.Value<string>("documentTypeId"), Is.EqualTo("tests.compiler.legacy"));
                Assert.That(artifact.Value<string>("configTypeId"), Is.EqualTo("tests.compiler.settings"));
                Assert.That(artifact["data"]["name"].Value<string>(), Is.EqualTo("legacy-name"));
                Assert.That(artifact["data"]["nested"]["value"].Value<string>(), Is.EqualTo("legacy-nested"));
                Assert.That(((JObject)artifact["data"]).Property("label"), Is.Null);
            }
        }

        [Test]
        public void CanonicalAndAliasFieldTogetherFailClosed()
        {
            using (var fixture = new CompilerFixture())
            {
                fixture.WriteDocument("{\n  \"formatVersion\": 1,\n  \"documentId\": \"tests.compiler.default\",\n  \"properties\": { \"name\": \"canonical\", \"label\": \"alias\" }\n}\n");

                var exception = Assert.Throws<VisualBridgeIntegrationException>(() =>
                    VisualBridgeStructuredCompiler.Compile(fixture.Root, VisualBridgeStructuredCompileMode.Check));

                Assert.That(exception.Code, Is.EqualTo("compile.fieldIdentityConflict"));
            }
        }

        [Test]
        public void UnknownConfigAndTypeMismatchFailClosed()
        {
            using (var fixture = new CompilerFixture())
            {
                fixture.WriteProject(new[] { CompilerFixture.DocumentType("tests.compiler.unknown", "Config/**/*.json") });
                fixture.WriteValidDocument();
                Assert.That(
                    Assert.Throws<VisualBridgeIntegrationException>(() =>
                        VisualBridgeStructuredCompiler.Compile(fixture.Root, VisualBridgeStructuredCompileMode.Check)).Code,
                    Is.EqualTo("profile.catalogDocumentTypeUnbound"));

                fixture.WriteProject(new[] { CompilerFixture.DocumentType("tests.compiler.settings", "Config/**/*.json") });
                fixture.WriteDocument("{\n  \"formatVersion\": 1,\n  \"documentId\": \"tests.compiler.default\",\n  \"properties\": { \"count\": \"seven\" }\n}\n");
                Assert.That(
                    Assert.Throws<VisualBridgeIntegrationException>(() =>
                        VisualBridgeStructuredCompiler.Compile(fixture.Root, VisualBridgeStructuredCompileMode.Check)).Code,
                    Is.EqualTo("compile.typeMismatch"));
            }
        }

        [TestCase("../Outside")]
        [TestCase("Config\\Bad")]
        public void ProjectRejectsOutsideOrNonCanonicalRoots(string documentRoot)
        {
            using (var fixture = new CompilerFixture())
            {
                var encodedRoot = documentRoot.Replace("\\", "\\\\").Replace("\"", "\\\"");
                fixture.WriteRawProject("{\n  \"formatVersion\": 1,\n  \"projectId\": \"tests.compiler.project\",\n  \"documentRoots\": [\"" + encodedRoot + "\"],\n  \"documentTypes\": []\n}\n");

                Assert.That(
                    Assert.Throws<VisualBridgeIntegrationException>(() =>
                        VisualBridgeAuthoringProjectParser.Parse(Path.Combine(fixture.Root, "Authoring", "VisualBridge.project.vbjson"))).Code,
                    Is.EqualTo("compile.projectInvalidPath"));
            }
        }

        [Test]
        public void ProjectParserRejectsWhitespaceGlobAndProviderReferenceKindConflicts()
        {
            using (var fixture = new CompilerFixture())
            {
                fixture.WriteRawProject("{\n  \"formatVersion\": 1,\n  \"projectId\": \"tests.compiler.project\",\n  \"documentRoots\": [\"Config\"],\n  \"documentTypes\": [{\"id\":\"tests.compiler.settings\",\"editor\":\"structured\",\"include\":[\" Config/**/*.json\"]}]\n}\n");
                Assert.That(
                    Assert.Throws<VisualBridgeIntegrationException>(() =>
                        VisualBridgeAuthoringProjectParser.Parse(Path.Combine(fixture.Root, "Authoring", "VisualBridge.project.vbjson"))).Code,
                    Is.EqualTo("compile.projectInvalidGlob"));

                fixture.WriteRawProject("{\n  \"formatVersion\": 1,\n  \"projectId\": \"tests.compiler.project\",\n  \"documentRoots\": [\"Config\"],\n  \"documentTypes\": [{\"id\":\"tests.compiler.settings\",\"editor\":\"structured\",\"include\":[\"Config/**/*.json\"]}],\n  \"providers\": [{\"id\":\"tests.provider\",\"entry\":\"Providers/test.mjs\",\"args\":[],\"capabilities\":{\"reference\":{\"kinds\":[\"document\"]}}}]\n}\n");
                Assert.That(
                    Assert.Throws<VisualBridgeIntegrationException>(() =>
                        VisualBridgeAuthoringProjectParser.Parse(Path.Combine(fixture.Root, "Authoring", "VisualBridge.project.vbjson"))).Code,
                    Is.EqualTo("compile.projectReferenceKindConflict"));
            }
        }

        [Test]
        public void FailedGeneratePreservesLastValidOutputsAndAuthoringBytes()
        {
            using (var fixture = new CompilerFixture())
            {
                fixture.WriteValidDocument();
                var generated = VisualBridgeStructuredCompiler.Compile(fixture.Root, VisualBridgeStructuredCompileMode.Generate);
                var before = generated.Outputs.ToDictionary(output => output.Path, output => File.ReadAllBytes(output.Path));
                var invalid = Utf8WithoutBom.GetBytes("{\n  \"formatVersion\": 1,\n  \"documentId\": \"tests.compiler.default\",\n  \"properties\": { \"count\": \"invalid\" }\n}\n");
                File.WriteAllBytes(fixture.DocumentPath, invalid);

                Assert.Throws<VisualBridgeIntegrationException>(() =>
                    VisualBridgeStructuredCompiler.Compile(fixture.Root, VisualBridgeStructuredCompileMode.Generate));

                Assert.That(before.All(entry => File.ReadAllBytes(entry.Key).SequenceEqual(entry.Value)), Is.True);
                Assert.That(File.ReadAllBytes(fixture.DocumentPath), Is.EqualTo(invalid));
            }
        }

        [Test]
        public void ExistingHardLinkedManagedOutputFailsClosedWithoutChangingEitherLink()
        {
            if (Environment.OSVersion.Platform != PlatformID.Win32NT)
            {
                Assert.Ignore("Hard-link output safety coverage is Windows-specific.");
            }

            using (var fixture = new CompilerFixture())
            {
                fixture.WriteValidDocument();
                VisualBridgeStructuredCompiler.Compile(fixture.Root, VisualBridgeStructuredCompileMode.Generate);
                var before = File.ReadAllBytes(fixture.ArtifactPath);
                var externalAlias = Path.Combine(fixture.Root, "ExternalCompiledArtifact.json");
                if (!CreateHardLink(externalAlias, fixture.ArtifactPath, IntPtr.Zero))
                {
                    Assert.Fail("CreateHardLink failed with Win32 " + Marshal.GetLastWin32Error());
                }

                fixture.WriteDocument("{\n  \"formatVersion\": 1,\n  \"documentId\": \"tests.compiler.default\",\n  \"properties\": {\"name\": \"changed\"}\n}\n");
                var exception = Assert.Throws<VisualBridgeIntegrationException>(() =>
                    VisualBridgeStructuredCompiler.Compile(fixture.Root, VisualBridgeStructuredCompileMode.Generate));

                Assert.That(exception.Code, Is.EqualTo("compile.outputHardLinkForbidden"));
                Assert.That(File.ReadAllBytes(fixture.ArtifactPath), Is.EqualTo(before));
                Assert.That(File.ReadAllBytes(externalAlias), Is.EqualTo(before));
            }
        }

        [Test]
        public void ReparsePointCompileOutputRootFailsClosed()
        {
            if (Environment.OSVersion.Platform != PlatformID.Win32NT)
            {
                Assert.Ignore("Junction output safety coverage is Windows-specific.");
            }

            using (var fixture = new CompilerFixture())
            {
                fixture.WriteValidDocument();
                VisualBridgeStructuredCompiler.Compile(fixture.Root, VisualBridgeStructuredCompileMode.Generate);
                var realOutputRoot = Path.Combine(fixture.Root, "RealCompiledOutput");
                Directory.Move(fixture.OutputRoot, realOutputRoot);
                if (!CreateJunction(fixture.OutputRoot, realOutputRoot))
                {
                    Directory.Move(realOutputRoot, fixture.OutputRoot);
                    Assert.Ignore("Unable to create a Windows junction for output safety coverage.");
                }

                try
                {
                    var exception = Assert.Throws<VisualBridgeIntegrationException>(() =>
                        VisualBridgeStructuredCompiler.Compile(fixture.Root, VisualBridgeStructuredCompileMode.Check));
                    Assert.That(new[] { "profile.symlinkForbidden", "compile.outputAliasForbidden" }, Does.Contain(exception.Code));
                }
                finally
                {
                    Directory.Delete(fixture.OutputRoot);
                    Directory.Move(realOutputRoot, fixture.OutputRoot);
                }
            }
        }

        private static bool CreateJunction(string junctionPath, string targetPath)
        {
            using (var process = Process.Start(new ProcessStartInfo
            {
                FileName = "cmd.exe",
                Arguments = "/d /c mklink /J \"" + junctionPath + "\" \"" + targetPath + "\"",
                CreateNoWindow = true,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            }))
            {
                process.WaitForExit();
                return process.ExitCode == 0 && Directory.Exists(junctionPath);
            }
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateHardLinkW")]
        private static extern bool CreateHardLink(string newFileName, string existingFileName, IntPtr securityAttributes);

        private sealed class CompilerFixture : IDisposable
        {
            private readonly string documentTypeId;
            private readonly bool includeOtherType;

            public CompilerFixture(string documentTypeId = "tests.compiler.settings", bool includeOtherType = false)
            {
                this.documentTypeId = documentTypeId;
                this.includeOtherType = includeOtherType;
                Root = Path.Combine(Path.GetTempPath(), "VisualBridgeCompilerTests", Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(Path.Combine(Root, "ProjectSettings"));
                Directory.CreateDirectory(Path.Combine(Root, "Authoring", "Catalog"));
                Directory.CreateDirectory(Path.Combine(Root, "Authoring", "Config"));
                var typeNames = new List<string> { typeof(CompilerTestSettings).AssemblyQualifiedName };
                if (includeOtherType) typeNames.Add(typeof(CompilerOtherSettings).AssemblyQualifiedName);
                WriteProfile(typeNames);
                WriteProject(includeOtherType
                    ? new[]
                    {
                        DocumentType(documentTypeId, "Config/**/*.json"),
                        DocumentType("tests.compiler.other", "Config/**/*.other"),
                    }
                    : new[] { DocumentType(documentTypeId, "Config/**/*.json") });
                VisualBridgeStructuredCatalogExporter.Export(Root, VisualBridgeCatalogExportMode.Generate);
            }

            public string Root { get; }

            public string OutputRoot => Path.Combine(Root, "Library", "VisualBridge", "Compiled");

            public string DocumentPath => Path.Combine(Root, "Authoring", "Config", "Settings.json");

            public string ArtifactPath => Path.Combine(OutputRoot, "documents", "tests.compiler.project", documentTypeId, "tests.compiler.default.vbcompiled.json");

            public static string DocumentType(string id, string include)
            {
                return "{\"id\":\"" + id + "\",\"editor\":\"structured\",\"include\":[\"" + include + "\"],\"exclude\":[],\"catalogs\":[\"Catalog/Compiler.vbstructuredcatalog\"]}";
            }

            public void WriteValidDocument()
            {
                WriteDocument("{\n  \"formatVersion\": 1,\n  \"documentId\": \"tests.compiler.default\",\n  \"properties\": {\n    \"name\": \"configured\",\n    \"enabled\": false,\n    \"count\": 3,\n    \"mode\": \"Alpha\",\n    \"nested\": { \"value\": \"nested\" },\n    \"values\": [3, 4]\n  }\n}\n");
            }

            public void WriteDocument(string text)
            {
                File.WriteAllText(DocumentPath, text, Utf8WithoutBom);
            }

            public void WriteProject(IEnumerable<string> documentTypes)
            {
                WriteRawProject("{\n  \"formatVersion\": 1,\n  \"projectId\": \"tests.compiler.project\",\n  \"documentRoots\": [\"Config\"],\n  \"documentTypes\": [" + string.Join(",", documentTypes) + "]\n}\n");
            }

            public void WriteRawProject(string text)
            {
                File.WriteAllText(Path.Combine(Root, "Authoring", "VisualBridge.project.vbjson"), text, Utf8WithoutBom);
            }

            public void Dispose()
            {
                if (Directory.Exists(Root)) Directory.Delete(Root, true);
            }

            private void WriteProfile(IEnumerable<string> typeNames)
            {
                var types = string.Join(",", typeNames.Select(name => "\"" + name.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\""));
                File.WriteAllText(
                    Path.Combine(Root, "ProjectSettings", "VisualBridgeIntegration.json"),
                    "{\n  \"formatVersion\": 1,\n  \"authoringProject\": \"Authoring/VisualBridge.project.vbjson\",\n  \"catalogExports\": [{\"catalogId\": \"tests.visualbridge.compiler.catalog\", \"title\": \"VisualBridge Compiler Tests\", \"output\": \"Authoring/Catalog/Compiler.vbstructuredcatalog\", \"types\": [" + types + "]}],\n  \"compileOutputRoot\": \"Library/VisualBridge/Compiled\"\n}\n",
                    Utf8WithoutBom);
            }
        }
    }
}
