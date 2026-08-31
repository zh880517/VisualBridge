using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using VisualBridge.Editor;
using NUnit.Framework;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace VisualBridge.Editor.Tests
{
    public sealed class VisualBridgeTableCompilerTests
    {
        private static readonly UTF8Encoding Utf8WithoutBom = new UTF8Encoding(false);

        [Test]
        public void GenerateMaterializesDefaultsAndIsDeterministic()
        {
            using (var fixture = new TableCompilerFixture())
            {
                fixture.WriteCsv("Skills_Main.csv", "Skill List\nId\tName\tPower\n101\tFireball\n102\tIce Bolt\t30\n");

                var first = VisualBridgeTableCompiler.Compile(fixture.Root, VisualBridgeTableCompileMode.Generate);
                var firstSnapshot = first.Outputs.ToDictionary(output => output.Path, output => File.ReadAllBytes(output.Path));
                var second = VisualBridgeTableCompiler.Compile(fixture.Root, VisualBridgeTableCompileMode.Generate);

                Assert.That(first.DriftDetected, Is.True);
                Assert.That(second.DriftDetected, Is.False);
                Assert.That(second.Outputs.All(output => File.ReadAllBytes(output.Path).SequenceEqual(firstSnapshot[output.Path])), Is.True);

                var artifact = JObject.Parse(File.ReadAllText(fixture.ArtifactPath));
                Assert.That(artifact.Value<string>("kind"), Is.EqualTo("visualbridge.table.compiled"));
                Assert.That(artifact.Value<string>("tableTypeId"), Is.EqualTo("tests.skills"));
                var sheet = (JObject)artifact["data"]["sheets"][0];
                Assert.That(sheet.Value<string>("definitionId"), Is.EqualTo("skills"));
                var rows = ((JArray)sheet["rows"]).Cast<JObject>().ToList();
                Assert.That(rows.Count, Is.EqualTo(2));
                Assert.That(rows[0].Value<string>("rowId"), Is.EqualTo("skills:Skills_Main:key-101"));
                Assert.That(rows[1].Value<string>("rowId"), Is.EqualTo("skills:Skills_Main:key-102"));
                Assert.That(rows[0]["cells"]["id"].Value<int>(), Is.EqualTo(101));
                Assert.That(rows[0]["cells"]["name"].Value<string>(), Is.EqualTo("Fireball"));
                Assert.That(rows[0]["cells"]["power"].Value<int>(), Is.EqualTo(0));
                Assert.That(rows[1]["cells"]["power"].Value<int>(), Is.EqualTo(30));
                // cells 按 canonical 列 ID 排序。
                Assert.That(
                    ((JObject)rows[0]["cells"]).Properties().Select(property => property.Name).ToArray(),
                    Is.EqualTo(new[] { "id", "name", "power" }));
                Assert.That(File.ReadAllBytes(fixture.ArtifactPath).Last(), Is.EqualTo((byte)'\n'));

                var mapping = JObject.Parse(File.ReadAllText(fixture.MappingPath));
                Assert.That(mapping.Value<string>("kind"), Is.EqualTo("visualbridge.table.sourceMapping"));
                Assert.That(mapping["artifact"]["path"].Value<string>(), Is.EqualTo("documents/tests.table.project/tests.skills/tests.skills.vbcompiled.json"));
                var sources = ((JArray)mapping["sources"]).Cast<JObject>().ToList();
                Assert.That(sources.Count, Is.EqualTo(1));
                Assert.That(sources[0].Value<string>("path"), Is.EqualTo("Tables/Skills_Main.csv"));
                var mappingEntries = ((JArray)mapping["mappings"]).Cast<JObject>()
                    .ToDictionary(entry => entry.Value<string>("artifactPath"));
                Assert.That(mappingEntries["data.sheets[0].rows[0].cells.id"].Value<string>("origin"), Is.EqualTo("document"));
                Assert.That(mappingEntries["data.sheets[0].rows[0].cells.id"].Value<string>("sourcePath"), Is.EqualTo("Tables/Skills_Main.csv#R3.id"));
                Assert.That(mappingEntries["data.sheets[0].rows[0].cells.power"].Value<string>("origin"), Is.EqualTo("metadataDefault"));
                Assert.That(mappingEntries["data.sheets[0].rows[0].cells.power"].Property("sourcePath"), Is.Null);
                var artifactPaths = ((JArray)mapping["mappings"]).Cast<JObject>()
                    .Select(entry => entry.Value<string>("artifactPath"))
                    .ToList();
                Assert.That(artifactPaths, Is.EqualTo(artifactPaths.OrderBy(value => value, StringComparer.Ordinal).ToList()));

                var manifest = JObject.Parse(File.ReadAllText(fixture.ManifestPath));
                Assert.That(manifest.Value<string>("kind"), Is.EqualTo("visualbridge.table.compileManifest"));
            }
        }

        [Test]
        public void BatchExitCodesShareOneContract()
        {
            Assert.That(VisualBridgeTableCompilerBatch.SuccessExitCode, Is.EqualTo(0));
            Assert.That(VisualBridgeTableCompilerBatch.FailureExitCode, Is.EqualTo(1));
            Assert.That(VisualBridgeTableCompilerBatch.DriftExitCode, Is.EqualTo(2));
            Assert.That(VisualBridgeTableCompilerBatch.SuccessExitCode, Is.EqualTo(VisualBridgeStructuredCompilerBatch.SuccessExitCode));
            Assert.That(VisualBridgeTableCompilerBatch.FailureExitCode, Is.EqualTo(VisualBridgeStructuredCompilerBatch.FailureExitCode));
            Assert.That(VisualBridgeTableCompilerBatch.DriftExitCode, Is.EqualTo(VisualBridgeStructuredCompilerBatch.DriftExitCode));
            Assert.That(VisualBridgeTableCompilerBatch.SuccessExitCode, Is.EqualTo(VisualBridgeEntityCompilerBatch.SuccessExitCode));
            Assert.That(VisualBridgeTableCompilerBatch.FailureExitCode, Is.EqualTo(VisualBridgeEntityCompilerBatch.FailureExitCode));
            Assert.That(VisualBridgeTableCompilerBatch.DriftExitCode, Is.EqualTo(VisualBridgeEntityCompilerBatch.DriftExitCode));
        }

        [Test]
        public void CheckDetectsDriftWithoutWriting()
        {
            using (var fixture = new TableCompilerFixture())
            {
                fixture.WriteCsv("Skills_Main.csv", "Skill List\nId\tName\tPower\n101\tFireball\n");
                VisualBridgeTableCompiler.Compile(fixture.Root, VisualBridgeTableCompileMode.Generate);
                var drift = Utf8WithoutBom.GetBytes("{}\n");
                File.WriteAllBytes(fixture.ArtifactPath, drift);

                var result = VisualBridgeTableCompiler.Compile(fixture.Root, VisualBridgeTableCompileMode.Check);

                Assert.That(result.DriftDetected, Is.True);
                Assert.That(File.ReadAllBytes(fixture.ArtifactPath), Is.EqualTo(drift));
                Assert.That(Directory.GetFiles(fixture.OutputRoot, "*.tmp", SearchOption.AllDirectories), Is.Empty);
            }
        }

        [Test]
        public void StaleOutputsAreRemovedOnGenerateAndKeptOnCheck()
        {
            using (var fixture = new TableCompilerFixture())
            {
                fixture.WriteCsv("Skills_Main.csv", "Skill List\nId\tName\tPower\n101\tFireball\n");
                VisualBridgeTableCompiler.Compile(fixture.Root, VisualBridgeTableCompileMode.Generate);
                File.Delete(fixture.CsvPath("Skills_Main.csv"));

                var check = VisualBridgeTableCompiler.Compile(fixture.Root, VisualBridgeTableCompileMode.Check);
                Assert.That(check.StaleOutputs, Is.Not.Empty);
                Assert.That(File.Exists(fixture.ArtifactPath), Is.True);

                var generate = VisualBridgeTableCompiler.Compile(fixture.Root, VisualBridgeTableCompileMode.Generate);
                Assert.That(generate.StaleOutputs, Is.Not.Empty);
                Assert.That(File.Exists(fixture.ArtifactPath), Is.False);
                Assert.That(File.Exists(fixture.MappingPath), Is.False);
                Assert.That(Directory.GetFiles(fixture.OutputRoot, "*.tmp", SearchOption.AllDirectories), Is.Empty);
            }
        }

        [Test]
        public void UnknownTableTypeFailsClosed()
        {
            using (var fixture = new TableCompilerFixture(documentTypeId: "tests.missing"))
            {
                fixture.WriteCsv("Skills_Main.csv", "Skill List\nId\tName\tPower\n101\tFireball\n");

                var exception = Assert.Throws<VisualBridgeIntegrationException>(() =>
                    VisualBridgeTableCompiler.Compile(fixture.Root, VisualBridgeTableCompileMode.Check));

                Assert.That(exception.Code, Is.EqualTo("compile.tableTypeUnknown"));
            }
        }

        [Test]
        public void MissingColumnFailsClosed()
        {
            using (var fixture = new TableCompilerFixture())
            {
                fixture.WriteCsv("Skills_Main.csv", "Skill List\nId\tName\n101\tFireball\n");

                var exception = Assert.Throws<VisualBridgeIntegrationException>(() =>
                    VisualBridgeTableCompiler.Compile(fixture.Root, VisualBridgeTableCompileMode.Check));

                Assert.That(exception.Code, Is.EqualTo("table.missingColumn"));
            }
        }

        [Test]
        public void DuplicateKeyFailsClosed()
        {
            using (var fixture = new TableCompilerFixture())
            {
                fixture.WriteCsv("Skills_Main.csv", "Skill List\nId\tName\tPower\n101\tFireball\n101\tIce Bolt\n");

                var exception = Assert.Throws<VisualBridgeIntegrationException>(() =>
                    VisualBridgeTableCompiler.Compile(fixture.Root, VisualBridgeTableCompileMode.Check));

                Assert.That(exception.Code, Is.EqualTo("table.duplicateKey"));
            }
        }

        [Test]
        public void DuplicatePartitionKeyFailsClosed()
        {
            using (var fixture = new TableCompilerFixture(duplicatePolicy: "error"))
            {
                fixture.WriteCsv("Skills_Main.csv", "Skill List\nId\tName\tPower\n101\tFireball\n");
                fixture.WriteCsv("Skills_Second.csv", "Skill List\nId\tName\tPower\n101\tFireball B\n");

                var exception = Assert.Throws<VisualBridgeIntegrationException>(() =>
                    VisualBridgeTableCompiler.Compile(fixture.Root, VisualBridgeTableCompileMode.Check));

                Assert.That(exception.Code, Is.EqualTo("table.duplicatePartitionKey"));
            }
        }

        [Test]
        public void PartitionDuplicatePolicyKeepsFirstOrLast()
        {
            using (var keepFirst = new TableCompilerFixture(duplicatePolicy: "keepFirst"))
            {
                keepFirst.WriteCsv("Skills_Main.csv", "Skill List\nId\tName\tPower\n101\tFireball\n");
                keepFirst.WriteCsv("Skills_Second.csv", "Skill List\nId\tName\tPower\n101\tFireball B\n");
                VisualBridgeTableCompiler.Compile(keepFirst.Root, VisualBridgeTableCompileMode.Generate);

                var artifact = JObject.Parse(File.ReadAllText(keepFirst.ArtifactPath));
                var rows = ((JArray)artifact["data"]["sheets"][0]["rows"]).Cast<JObject>().ToList();
                Assert.That(rows.Count, Is.EqualTo(1));
                Assert.That(rows[0].Value<string>("rowId"), Is.EqualTo("skills:Skills_Main:key-101"));
                Assert.That(rows[0]["cells"]["name"].Value<string>(), Is.EqualTo("Fireball"));
            }

            using (var keepLast = new TableCompilerFixture(duplicatePolicy: "keepLast"))
            {
                keepLast.WriteCsv("Skills_Main.csv", "Skill List\nId\tName\tPower\n101\tFireball\n");
                keepLast.WriteCsv("Skills_Second.csv", "Skill List\nId\tName\tPower\n101\tFireball B\n");
                VisualBridgeTableCompiler.Compile(keepLast.Root, VisualBridgeTableCompileMode.Generate);

                var artifact = JObject.Parse(File.ReadAllText(keepLast.ArtifactPath));
                var rows = ((JArray)artifact["data"]["sheets"][0]["rows"]).Cast<JObject>().ToList();
                Assert.That(rows.Count, Is.EqualTo(1));
                Assert.That(rows[0].Value<string>("rowId"), Is.EqualTo("skills:Skills_Second:key-101"));
                Assert.That(rows[0]["cells"]["name"].Value<string>(), Is.EqualTo("Fireball B"));
            }
        }

        [Test]
        public void XlsxUnsupportedFailsClosed()
        {
            using (var fixture = new TableCompilerFixture(include: "Tables/**"))
            {
                File.WriteAllBytes(fixture.CsvPath("Badge.xlsx"), new byte[] { 0x50, 0x4b });

                var exception = Assert.Throws<VisualBridgeIntegrationException>(() =>
                    VisualBridgeTableCompiler.Compile(fixture.Root, VisualBridgeTableCompileMode.Check));

                Assert.That(exception.Code, Is.EqualTo("table.xlsxUnsupported"));
            }
        }

        [Test]
        public void MissingTableLayoutFailsClosed()
        {
            using (var fixture = new TableCompilerFixture(includeTableLayout: false))
            {
                fixture.WriteCsv("Skills_Main.csv", "Skill List\nId\tName\tPower\n101\tFireball\n");

                var exception = Assert.Throws<VisualBridgeIntegrationException>(() =>
                    VisualBridgeTableCompiler.Compile(fixture.Root, VisualBridgeTableCompileMode.Check));

                Assert.That(exception.Code, Is.EqualTo("compile.tableLayoutMissing"));
            }
        }

        [Test]
        public void InvalidCellFailsClosed()
        {
            using (var fixture = new TableCompilerFixture())
            {
                fixture.WriteCsv("Skills_Main.csv", "Skill List\nId\tName\tPower\n101\tFireball\tabc\n");

                var exception = Assert.Throws<VisualBridgeIntegrationException>(() =>
                    VisualBridgeTableCompiler.Compile(fixture.Root, VisualBridgeTableCompileMode.Check));

                Assert.That(exception.Code, Is.EqualTo("table.invalidCell"));
            }
        }

        [Test]
        public void DelimitedCellEncodingDecodesArrays()
        {
            using (var fixture = new TableCompilerFixture(withTags: true))
            {
                fixture.WriteCsv("Skills_Main.csv", "Skill List\nId\tName\tPower\tTags\n201\tFrost\t50\ta|b\n202\tEmber\t60\t\n");
                VisualBridgeTableCompiler.Compile(fixture.Root, VisualBridgeTableCompileMode.Generate);

                var artifact = JObject.Parse(File.ReadAllText(fixture.ArtifactPath));
                var rows = ((JArray)artifact["data"]["sheets"][0]["rows"]).Cast<JObject>().ToList();
                var tags = (JArray)rows[0]["cells"]["tags"];
                Assert.That(tags.Count, Is.EqualTo(2));
                Assert.That(tags[0].Value<string>(), Is.EqualTo("a"));
                Assert.That(tags[1].Value<string>(), Is.EqualTo("b"));
                var emptyTags = (JArray)rows[1]["cells"]["tags"];
                Assert.That(emptyTags.Count, Is.EqualTo(0));

                var mapping = JObject.Parse(File.ReadAllText(fixture.MappingPath));
                var mappingEntries = ((JArray)mapping["mappings"]).Cast<JObject>()
                    .ToDictionary(entry => entry.Value<string>("artifactPath"));
                Assert.That(mappingEntries["data.sheets[0].rows[0].cells.tags"].Value<string>("origin"), Is.EqualTo("document"));
                Assert.That(mappingEntries["data.sheets[0].rows[1].cells.tags"].Value<string>("origin"), Is.EqualTo("metadataDefault"));
            }
        }

        [Test]
        public void FailedGeneratePreservesLastValidOutputsAndAuthoringBytes()
        {
            using (var fixture = new TableCompilerFixture())
            {
                fixture.WriteCsv("Skills_Main.csv", "Skill List\nId\tName\tPower\n101\tFireball\n");
                var generated = VisualBridgeTableCompiler.Compile(fixture.Root, VisualBridgeTableCompileMode.Generate);
                var before = generated.Outputs.ToDictionary(output => output.Path, output => File.ReadAllBytes(output.Path));
                var invalid = Utf8WithoutBom.GetBytes("Skill List\nId\tName\tPower\n101\tFireball\tabc\n");
                File.WriteAllBytes(fixture.CsvPath("Skills_Main.csv"), invalid);

                Assert.Throws<VisualBridgeIntegrationException>(() =>
                    VisualBridgeTableCompiler.Compile(fixture.Root, VisualBridgeTableCompileMode.Generate));

                Assert.That(before.All(entry => File.ReadAllBytes(entry.Key).SequenceEqual(entry.Value)), Is.True);
                Assert.That(File.ReadAllBytes(fixture.CsvPath("Skills_Main.csv")), Is.EqualTo(invalid));
            }
        }

        // Table Catalog 是手写提交文件（无 Exporter），fixture 直接落盘最小 catalog。
        private sealed class TableCompilerFixture : IDisposable
        {
            public const string ProjectId = "tests.table.project";
            public const string DocumentTypeId = "tests.skills";

            public TableCompilerFixture(
                string duplicatePolicy = "error",
                string documentTypeId = DocumentTypeId,
                bool includeTableLayout = true,
                bool withTags = false,
                string include = "Tables/**/*.csv")
            {
                Root = Path.Combine(Path.GetTempPath(), "VisualBridgeTableCompilerTests", Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(Path.Combine(Root, "ProjectSettings"));
                Directory.CreateDirectory(Path.Combine(Root, "Authoring", "Catalog"));
                Directory.CreateDirectory(Path.Combine(Root, "Authoring", "Tables"));
                WriteProfile();
                WriteProject(documentTypeId, include, includeTableLayout);
                File.WriteAllText(CatalogPath, BuildCatalog(duplicatePolicy, withTags), Utf8WithoutBom);
            }

            public string Root { get; }

            public string OutputRoot => Path.Combine(Root, "Library", "VisualBridge", "Compiled");

            public string CatalogPath => Path.Combine(Root, "Authoring", "Catalog", "Test.vbtablecatalog");

            public string ArtifactPath => Path.Combine(OutputRoot, "documents", ProjectId, DocumentTypeId, "tests.skills.vbcompiled.json");

            public string MappingPath => Path.Combine(OutputRoot, "mappings", ProjectId, DocumentTypeId, "tests.skills.vbsource.json");

            public string ManifestPath => Path.Combine(OutputRoot, "manifest.table.json");

            public string CsvPath(string fileName)
            {
                return Path.Combine(Root, "Authoring", "Tables", fileName);
            }

            public void WriteCsv(string fileName, string text)
            {
                File.WriteAllText(CsvPath(fileName), text, Utf8WithoutBom);
            }

            public void WriteProject(string documentTypeId, string include, bool includeTableLayout)
            {
                var tableLayout = includeTableLayout
                    ? "  \"tableLayout\": { \"nameKeyRow\": 2, \"dataStartRow\": 3 },\n"
                    : string.Empty;
                File.WriteAllText(
                    Path.Combine(Root, "Authoring", "VisualBridge.project.vbjson"),
                    "{\n  \"formatVersion\": 1,\n  \"projectId\": \"" + ProjectId + "\",\n  \"documentRoots\": [\"Tables\"],\n"
                    + tableLayout
                    + "  \"documentTypes\": [\n    { \"id\": \"" + documentTypeId + "\", \"editor\": \"table\", \"include\": [\""
                    + include + "\"], \"exclude\": [], \"catalogs\": [\"Catalog/Test.vbtablecatalog\"] }\n  ]\n}\n",
                    Utf8WithoutBom);
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
                // Profile 仍要求非空 catalogExports；Table Compiler 不消费导出闭包（无 Exporter），声明一个 Structured 单元即可。
                File.WriteAllText(
                    Path.Combine(Root, "ProjectSettings", "VisualBridgeIntegration.json"),
                    "{\n  \"formatVersion\": 1,\n  \"authoringProject\": \"Authoring/VisualBridge.project.vbjson\",\n"
                    + "  \"catalogExports\": [\n    {\n      \"catalogId\": \"tests.visualbridge.table.compiler\",\n"
                    + "      \"title\": \"VisualBridge Table Compiler Tests\",\n"
                    + "      \"output\": \"Authoring/Catalog/Compiler.vbstructuredcatalog\",\n"
                    + "      \"types\": [" + JsonConvert.ToString(typeof(VisualBridgeTableCompilerTests).AssemblyQualifiedName) + "]\n    }\n  ],\n"
                    + "  \"compileOutputRoot\": \"Library/VisualBridge/Compiled\"\n}\n",
                    Utf8WithoutBom);
            }

            private static string BuildCatalog(string duplicatePolicy, bool withTags)
            {
                var tagsColumn = withTags
                    ? ",\n            { \"id\": \"tags\", \"title\": \"Tags\", \"valueType\": \"array\", \"defaultValue\": [], \"item\": { \"valueType\": \"string\", \"defaultValue\": \"\" }, \"nameKey\": \"Tags\", \"cellEncoding\": { \"kind\": \"delimited\", \"separator\": \"|\", \"item\": { \"kind\": \"scalar\" } } }"
                    : string.Empty;
                return "{\n"
                    + "  \"formatVersion\": 1,\n"
                    + "  \"catalogId\": \"tests.visualbridge.table\",\n"
                    + "  \"title\": \"VisualBridge Table Compiler Tests\",\n"
                    + "  \"source\": { \"status\": \"unknown\" },\n"
                    + "  \"tableTypes\": [\n"
                    + "    {\n"
                    + "      \"id\": \"tests.skills\",\n"
                    + "      \"title\": \"Skills\",\n"
                    + "      \"csv\": { \"delimiter\": \"\\t\" },\n"
                    + "      \"sheets\": [\n"
                    + "        {\n"
                    + "          \"id\": \"skills\",\n"
                    + "          \"title\": \"Skills\",\n"
                    + "          \"name\": \"Skills\",\n"
                    + "          \"rowDisplayNamePattern\": \"{id}_{name}\",\n"
                    + "          \"keyColumnId\": \"id\",\n"
                    + "          \"partition\": { \"namePattern\": \"Skills_{part}\", \"deduplicateByColumnId\": \"id\", \"duplicatePolicy\": \"" + duplicatePolicy + "\" },\n"
                    + "          \"columns\": [\n"
                    + "            { \"id\": \"id\", \"title\": \"Id\", \"valueType\": \"number\", \"defaultValue\": 1, \"dataTypeId\": \"int\", \"editor\": { \"kind\": \"number\", \"integer\": true }, \"nameKey\": \"Id\", \"cellEncoding\": { \"kind\": \"scalar\" } },\n"
                    + "            { \"id\": \"name\", \"title\": \"Name\", \"valueType\": \"string\", \"defaultValue\": \"\", \"nameKey\": \"Name\", \"cellEncoding\": { \"kind\": \"scalar\" } },\n"
                    + "            { \"id\": \"power\", \"title\": \"Power\", \"valueType\": \"number\", \"defaultValue\": 0, \"dataTypeId\": \"int\", \"editor\": { \"kind\": \"number\", \"integer\": true }, \"nameKey\": \"Power\", \"cellEncoding\": { \"kind\": \"scalar\" } }"
                    + tagsColumn
                    + "\n          ]\n"
                    + "        }\n"
                    + "      ]\n"
                    + "    }\n"
                    + "  ]\n"
                    + "}\n";
            }
        }
    }
}
