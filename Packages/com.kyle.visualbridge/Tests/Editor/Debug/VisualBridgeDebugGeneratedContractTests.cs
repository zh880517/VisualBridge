using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.CompilerServices;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using VisualBridge.Editor.Tests.DebugFixtures;

namespace VisualBridge.Editor.Tests
{
    /// <summary>验证 Graph 样例契约生成的产物形状、确定性与磁盘快照一致。</summary>
    public sealed class VisualBridgeDebugGeneratedContractTests
    {
        private const string GeneratedDirectory =
            "Packages/com.kyle.visualbridge/Tests/Editor/Debug/Generated";

        private static readonly string[] ExpectedFileNames =
        {
            "GraphDebuger.g.cs",
            "VisualBridgeGeneratedGraphDebuger.g.cs",
            "GraphQueryDebuger.g.cs",
            "VisualBridgeGeneratedGraphQueryDebugerDispatcher.g.cs",
            "debug-contracts.json",
        };

        private static IReadOnlyList<VisualBridgeDebugGeneratedFile> BuildGraphContracts()
        {
            return VisualBridgeDebugContractCompiler.Build(
                new[] { typeof(IGraphDebuger), typeof(IGraphQueryDebuger) });
        }

        private static string ContentOf(
            IReadOnlyList<VisualBridgeDebugGeneratedFile> files,
            string fileName)
        {
            VisualBridgeDebugGeneratedFile file = files
                .SingleOrDefault(value => string.Equals(
                    Path.GetFileName(value.RelativePath),
                    fileName,
                    StringComparison.Ordinal));
            Assert.That(file, Is.Not.Null, "Missing generated file: " + fileName);
            return file.Content;
        }

        private static string MethodBody(string content, string signature)
        {
            int start = content.IndexOf(signature, StringComparison.Ordinal);
            Assert.That(start, Is.GreaterThanOrEqualTo(0), "Missing method: " + signature);
            int open = content.IndexOf('{', start);
            Assert.That(open, Is.GreaterThanOrEqualTo(0), "Missing method body: " + signature);
            int depth = 0;
            for (int i = open; i < content.Length; i++)
            {
                if (content[i] == '{')
                {
                    depth++;
                }
                else if (content[i] == '}')
                {
                    depth--;
                    if (depth == 0)
                    {
                        return content.Substring(open, i - open + 1);
                    }
                }
            }

            Assert.Fail("Unbalanced method body: " + signature);
            return null;
        }

        private static string FindRepositoryRoot([CallerFilePath] string sourceFile = "")
        {
            DirectoryInfo directory = new DirectoryInfo(Path.GetDirectoryName(sourceFile));
            while (directory != null)
            {
                if (Directory.Exists(Path.Combine(
                        directory.FullName,
                        "Packages",
                        "com.kyle.visualbridge")))
                {
                    return directory.FullName;
                }

                directory = directory.Parent;
            }

            Assert.Fail("Could not locate the repository root from " + sourceFile);
            return null;
        }

        [Test]
        public void BuildEmitsDocumentedFileNames()
        {
            IReadOnlyList<VisualBridgeDebugGeneratedFile> files = BuildGraphContracts();

            Assert.That(
                files.Select(file => Path.GetFileName(file.RelativePath)),
                Is.EquivalentTo(ExpectedFileNames));
        }

        [Test]
        public void AllGeneratedPathsStayUnderConfiguredDirectory()
        {
            IReadOnlyList<VisualBridgeDebugGeneratedFile> files = BuildGraphContracts();

            Assert.That(files, Is.Not.Empty);
            foreach (VisualBridgeDebugGeneratedFile file in files)
            {
                Assert.That(
                    file.RelativePath,
                    Does.StartWith(GeneratedDirectory + "/"),
                    "Unexpected generated path: " + file.RelativePath);
                Assert.That(file.RelativePath, Does.Not.Contain(".."));
                Assert.That(file.RelativePath, Does.Not.Contain("\\"));
            }
        }

        [Test]
        public void EventImplementationPushesNodeStartParameters()
        {
            IReadOnlyList<VisualBridgeDebugGeneratedFile> files = BuildGraphContracts();
            string implementation = ContentOf(files, "VisualBridgeGeneratedGraphDebuger.g.cs");
            string body = MethodBody(implementation, "public void NodeStart(");

            Assert.That(body, Does.Contain("PushParam(\"uid\", 0, uid);"));
            Assert.That(body, Does.Contain("PushParam(\"nodeId\", 1, nodeId);"));
            Assert.That(body, Does.Contain("PushParam(\"frameIndex\", 2, frameIndex);"));
            Assert.That(body, Does.Contain("\"NodeStart\", uid, null, frameIndex);"));
        }

        [Test]
        public void EdgeValueChangedUsesExplicitAndIncrementedTags()
        {
            IReadOnlyList<VisualBridgeDebugGeneratedFile> files = BuildGraphContracts();
            string implementation = ContentOf(files, "VisualBridgeGeneratedGraphDebuger.g.cs");
            string body = MethodBody(implementation, "public void EdgeValueChanged(");

            Assert.That(body, Does.Contain("PushParam(\"uid\", 0, uid);"));
            Assert.That(body, Does.Contain("PushParam(\"nodeId\", 10, nodeId);"));
            Assert.That(body, Does.Contain("PushParam(\"outputIndex\", 11, outputIndex);"));
            Assert.That(body, Does.Contain("PushParam(\"value\", 12, value);"));
            Assert.That(body, Does.Contain("PushParam(\"frameIndex\", 13, frameIndex);"));
        }

        [Test]
        public void QueryResultSenderHasFixedSignature()
        {
            IReadOnlyList<VisualBridgeDebugGeneratedFile> files = BuildGraphContracts();
            string facade = ContentOf(files, "GraphQueryDebuger.g.cs");

            Assert.That(
                facade,
                Does.Contain(
                    "public static void SendGetSnapshotResult(string uid, string requestId, string payload)"));
        }

        [Test]
        public void ContractJsonIsParsableAndDescribesBothInterfaces()
        {
            IReadOnlyList<VisualBridgeDebugGeneratedFile> files = BuildGraphContracts();
            JObject json = JObject.Parse(ContentOf(files, "debug-contracts.json"));

            Assert.That((int)json["schemaVersion"], Is.EqualTo(1));
            var interfaces = (JArray)json["interfaces"];
            Assert.That(interfaces, Is.Not.Null);

            JObject eventContract = interfaces
                .Single(value => (string)value["id"] == typeof(IGraphDebuger).FullName) as JObject;
            Assert.That(eventContract, Is.Not.Null, "Missing event contract");
            Assert.That((string)eventContract["category"], Is.EqualTo("graph"));
            Assert.That((int)eventContract["version"], Is.EqualTo(1));
            Assert.That((string)eventContract["kind"], Is.EqualTo("event"));
            Assert.That((string)eventContract["instanceParam"], Is.EqualTo("uid"));
            Assert.That((string)eventContract["frameParam"], Is.EqualTo("frameIndex"));

            JObject queryContract = interfaces
                .Single(value => (string)value["id"] == typeof(IGraphQueryDebuger).FullName) as JObject;
            Assert.That(queryContract, Is.Not.Null, "Missing query contract");
            Assert.That((string)queryContract["category"], Is.EqualTo("graph"));
            Assert.That((string)queryContract["kind"], Is.EqualTo("query"));
            Assert.That((string)queryContract["instanceParam"], Is.EqualTo("uid"));
            Assert.That(queryContract["frameParam"], Is.Null);
        }

        [Test]
        public void BuildIsByteForByteDeterministic()
        {
            IReadOnlyList<VisualBridgeDebugGeneratedFile> first = BuildGraphContracts();
            IReadOnlyList<VisualBridgeDebugGeneratedFile> second = BuildGraphContracts();

            Assert.That(second.Count, Is.EqualTo(first.Count));
            for (int i = 0; i < first.Count; i++)
            {
                Assert.That(second[i].RelativePath, Is.EqualTo(first[i].RelativePath));
                Assert.That(second[i].Content, Is.EqualTo(first[i].Content));
            }
        }

        [Test]
        public void GeneratedFilesStartWithAutoGeneratedHeaderAndUseLf()
        {
            IReadOnlyList<VisualBridgeDebugGeneratedFile> files = BuildGraphContracts();

            foreach (VisualBridgeDebugGeneratedFile file in files)
            {
                Assert.That(file.Content, Does.Not.Contain("\r"));
                Assert.That(file.Content, Does.EndWith("\n"));
                if (file.RelativePath.EndsWith(".g.cs", StringComparison.Ordinal))
                {
                    Assert.That(file.Content, Does.StartWith("// <auto-generated />"));
                }
            }
        }

        [Test]
        public void CommittedGeneratedFilesMatchBuildOutput()
        {
            string repositoryRoot = FindRepositoryRoot();
            IReadOnlyList<VisualBridgeDebugGeneratedFile> files = BuildGraphContracts();

            foreach (VisualBridgeDebugGeneratedFile file in files)
            {
                string fullPath = Path.Combine(
                    repositoryRoot,
                    file.RelativePath.Replace('/', Path.DirectorySeparatorChar));
                Assert.That(File.Exists(fullPath), Is.True, "Missing committed file: " + fullPath);
                Assert.That(
                    File.ReadAllText(fullPath),
                    Is.EqualTo(file.Content),
                    "Committed file is stale: " + file.RelativePath);
            }
        }
    }
}
