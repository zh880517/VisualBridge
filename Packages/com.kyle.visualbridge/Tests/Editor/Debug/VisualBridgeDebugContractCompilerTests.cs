using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using VisualBridge.Debug;
using VisualBridge.Editor.Tests.DebugFixtures;

namespace VisualBridge.Editor.Tests.DebugFixtures
{
    public enum SampleMode
    {
        None = 0,
        Alpha = 1,
        Beta = 2,
    }

    [VisualBridgeDebuger(
        "graph",
        GeneratedDirectory = "Assets/Generated/Event",
        InstanceParameter = "uid",
        FrameParameter = "frameIndex")]
    public interface ISampleGraphDebuger
    {
        void ExecutionStarted(string uid, string graphName);

        void NodeStart(string uid, string nodeId, int frameIndex);

        void EdgeValueChanged(
            string uid,
            [VisualBridgeDebugTag(10)] string nodeId,
            int outputIndex,
            string value,
            int frameIndex);

        void ModeChanged(
            string uid,
            SampleMode mode,
            byte level,
            uint stamp,
            char letter,
            double weight,
            ulong total,
            bool enabled,
            byte[] payload);
    }

    [VisualBridgeDebuger(
        "graph",
        Kind = VisualBridgeDebugerKind.Query,
        GeneratedDirectory = "Assets/Generated/Query",
        InstanceParameter = "uid")]
    public interface ISampleGraphQueryDebuger
    {
        void GetSnapshot(string uid, string requestId);

        void FindNode(string uid, string requestId, string nodeId);
    }

    [VisualBridgeDebuger("bad", GeneratedDirectory = "Assets/Generated/Bad")]
    public interface IUnsupportedTypeDebuger
    {
        void Bad(object value);
    }

    [VisualBridgeDebuger("bad", GeneratedDirectory = "Assets/Generated/Bad")]
    public interface INonVoidDebuger
    {
        int Value();
    }

    [VisualBridgeDebuger("bad", GeneratedDirectory = "Assets/Generated/Bad")]
    public interface IGenericDebuger<T>
    {
        void Run(string value);
    }

    [VisualBridgeDebuger("bad", GeneratedDirectory = "Assets/Generated/Bad")]
    public interface IOverloadDebuger
    {
        void Run(string value);

        void Run(int value);
    }

    [VisualBridgeDebuger("bad", GeneratedDirectory = "Assets/Generated/Bad")]
    public interface ITagOrderDebuger
    {
        void Run([VisualBridgeDebugTag(5)] string first, [VisualBridgeDebugTag(5)] string second);
    }

    [VisualBridgeDebuger("bad", GeneratedDirectory = "Assets/Generated/Bad")]
    internal interface IInternalDebuger
    {
        void Run();
    }

    [VisualBridgeDebuger("bad", GeneratedDirectory = "Assets/Generated/Bad")]
    public interface IRefDebuger
    {
        void Run(ref int value);
    }

    [VisualBridgeDebuger("bad", GeneratedDirectory = "Assets/Generated/Bad")]
    public interface IOptionalDebuger
    {
        void Run(int value = 0);
    }

    [VisualBridgeDebuger("bad", GeneratedDirectory = "Assets/Generated/Bad")]
    public interface IParamsDebuger
    {
        void Run(params int[] values);
    }

    [VisualBridgeDebuger("bad")]
    public interface IMissingDirectoryDebuger
    {
        void Run();
    }

    [VisualBridgeDebuger("bad", GeneratedDirectory = "Game/Generated")]
    public interface IOutsideDirectoryDebuger
    {
        void Run();
    }

    [VisualBridgeDebuger(
        "bad",
        GeneratedDirectory = "Assets/Generated/Bad",
        InstanceParameter = "uid")]
    public interface IInvalidInstanceDebuger
    {
        void Run(int uid);
    }

    [VisualBridgeDebuger(
        "bad",
        GeneratedDirectory = "Assets/Generated/Bad",
        FrameParameter = "frame")]
    public interface IInvalidFrameDebuger
    {
        void Run(string frame);
    }

    [VisualBridgeDebuger("bad", GeneratedDirectory = "Assets/Generated/Bad")]
    public interface IConflictedDebuger
    {
        void Run();
    }

    [VisualBridgeDebuger("bad", GeneratedDirectory = "Assets/Generated/Other")]
    public interface ConflictedDebuger
    {
        void Run();
    }

    public interface IPlainDebuger
    {
        void Run();
    }

    public static class NestedDebugFixtures
    {
        [VisualBridgeDebuger("bad", GeneratedDirectory = "Assets/Generated/Bad")]
        public interface INestedDebuger
        {
            void Run();
        }
    }
}

namespace VisualBridge.Editor.Tests.DebugFixtures.Other
{
    [VisualBridgeDebuger("bad", GeneratedDirectory = "Assets/Generated/Bad")]
    public interface IConflictedDebuger
    {
        void Run();
    }
}

namespace VisualBridge.Editor.Tests
{
    public sealed class VisualBridgeDebugContractCompilerTests
    {
        private const string FixtureNamespace = "VisualBridge.Editor.Tests.DebugFixtures";

        [Test]
        public void BuildUsesDocumentedFileNames()
        {
            var files = VisualBridgeDebugContractCompiler.Build(
                new[] { typeof(ISampleGraphDebuger) });

            string[] paths = files.Select(file => file.RelativePath).ToArray();
            Assert.That(paths, Does.Contain("Assets/Generated/Event/SampleGraphDebuger.g.cs"));
            Assert.That(
                paths,
                Does.Contain("Assets/Generated/Event/VisualBridgeGeneratedSampleGraphDebuger.g.cs"));
            Assert.That(paths, Does.Contain("Assets/Generated/Event/debug-contracts.json"));
        }

        [Test]
        public void EventFacadeMatchesTemplate()
        {
            string content = GetContent(
                VisualBridgeDebugContractCompiler.Build(new[] { typeof(ISampleGraphDebuger) }),
                "SampleGraphDebuger.g.cs");

            Assert.That(content.StartsWith("// <auto-generated />\n", StringComparison.Ordinal), Is.True);
            Assert.That(content, Does.Contain("namespace " + FixtureNamespace));
            Assert.That(content, Does.Contain("public static class SampleGraphDebuger"));
            Assert.That(content, Does.Contain("private static ISampleGraphDebuger s_impl;"));
            Assert.That(
                content,
                Does.Contain("public static void NodeStart(string uid, string nodeId, int frameIndex)"));
            Assert.That(
                content,
                Does.Contain("if (!global::VisualBridge.Debug.VisualBridgeDebug.isDebugBuild"));
            Assert.That(
                content,
                Does.Contain("    || !global::VisualBridge.Debug.VisualBridgeDebug.isConnected)"));
            Assert.That(
                content,
                Does.Contain(
                    "(s_impl ??= new VisualBridgeGeneratedSampleGraphDebuger()).NodeStart(uid, nodeId, frameIndex);"));
            Assert.That(
                content,
                Does.Contain("public static void DescribeInstance(string uid, string label, params string[] keywords)"));
        }

        [Test]
        public void EventImplementationUsesInstanceFrameAndTags()
        {
            string content = GetContent(
                VisualBridgeDebugContractCompiler.Build(new[] { typeof(ISampleGraphDebuger) }),
                "VisualBridgeGeneratedSampleGraphDebuger.g.cs");

            Assert.That(
                content,
                Does.Contain(
                    "\"graph\", 1, \"" + FixtureNamespace + ".ISampleGraphDebuger\", \"NodeStart\", uid, null, frameIndex);"));
            Assert.That(
                content,
                Does.Contain(
                    "global::VisualBridge.Debug.VisualBridgeDebug.PushParam(\"uid\", 0, uid);"));
            Assert.That(
                content,
                Does.Contain(
                    "global::VisualBridge.Debug.VisualBridgeDebug.PushParam(\"nodeId\", 10, nodeId);"));
            Assert.That(
                content,
                Does.Contain(
                    "global::VisualBridge.Debug.VisualBridgeDebug.PushParam(\"outputIndex\", 11, outputIndex);"));
            Assert.That(
                content,
                Does.Contain(
                    "global::VisualBridge.Debug.VisualBridgeDebug.PushParam(\"frameIndex\", 13, frameIndex);"));
        }

        [Test]
        public void EventImplementationNarrowsSupportedTypes()
        {
            string content = GetContent(
                VisualBridgeDebugContractCompiler.Build(new[] { typeof(ISampleGraphDebuger) }),
                "VisualBridgeGeneratedSampleGraphDebuger.g.cs");

            Assert.That(content, Does.Contain("PushParam(\"level\", 2, (int)level);"));
            Assert.That(content, Does.Contain("PushParam(\"stamp\", 3, (long)stamp);"));
            Assert.That(content, Does.Contain("PushParam(\"letter\", 4, (int)letter);"));
            Assert.That(content, Does.Contain("PushParam(\"weight\", 5, weight);"));
            Assert.That(content, Does.Contain("PushParam(\"total\", 6, total);"));
            Assert.That(content, Does.Contain("PushParam(\"enabled\", 7, enabled);"));
            Assert.That(content, Does.Contain("PushParam(\"payload\", 8, payload);"));
        }

        [Test]
        public void ContractJsonContainsStableShapeAndEnums()
        {
            string content = GetContent(
                VisualBridgeDebugContractCompiler.Build(new[] { typeof(ISampleGraphDebuger) }),
                "debug-contracts.json");
            var root = JObject.Parse(content);

            Assert.That((int)root["schemaVersion"], Is.EqualTo(1));
            var entry = (JObject)root["interfaces"][0];
            Assert.That((string)entry["id"], Is.EqualTo(FixtureNamespace + ".ISampleGraphDebuger"));
            Assert.That((string)entry["category"], Is.EqualTo("graph"));
            Assert.That((int)entry["version"], Is.EqualTo(1));
            Assert.That((string)entry["kind"], Is.EqualTo("event"));
            Assert.That((string)entry["instanceParam"], Is.EqualTo("uid"));
            Assert.That((string)entry["frameParam"], Is.EqualTo("frameIndex"));

            var modeMethod = (JObject)entry["methods"]
                .First(value => (string)value["name"] == "ModeChanged");
            var modeParam = (JObject)modeMethod["params"][1];
            Assert.That((string)modeParam["name"], Is.EqualTo("mode"));
            Assert.That((int)modeParam["tag"], Is.EqualTo(1));
            Assert.That((string)modeParam["type"], Is.EqualTo("enum"));
            Assert.That(
                (string)modeParam["enumId"],
                Is.EqualTo(FixtureNamespace + ".SampleMode"));

            var enums = (JArray)root["enums"];
            Assert.That(enums.Count, Is.EqualTo(1));
            Assert.That((string)enums[0]["id"], Is.EqualTo(FixtureNamespace + ".SampleMode"));
            Assert.That((string)enums[0]["members"][0]["name"], Is.EqualTo("None"));
            Assert.That((int)enums[0]["members"][0]["value"], Is.EqualTo(0));
        }

        [Test]
        public void QueryFacadeContainsRegistrationAndResultSenders()
        {
            string content = GetContent(
                VisualBridgeDebugContractCompiler.Build(new[] { typeof(ISampleGraphQueryDebuger) }),
                "SampleGraphQueryDebuger.g.cs");

            Assert.That(
                content,
                Does.Contain("public static void Register(ISampleGraphQueryDebuger implementation)"));
            Assert.That(content, Does.Contain("public static void Unregister()"));
            Assert.That(
                content,
                Does.Contain("public static void SendGetSnapshotResult(string uid, string requestId)"));
            Assert.That(
                content,
                Does.Contain(
                    "public static void SendFindNodeResult(string uid, string requestId, string nodeId)"));
            Assert.That(
                content,
                Does.Contain(
                    "private static void Dispatch(global::VisualBridge.Debug.VisualBridgeDebugRequest request)"));
        }

        [Test]
        public void QueryDispatcherUsesParameterIndices()
        {
            string content = GetContent(
                VisualBridgeDebugContractCompiler.Build(new[] { typeof(ISampleGraphQueryDebuger) }),
                "VisualBridgeGeneratedSampleGraphQueryDebugerDispatcher.g.cs");

            Assert.That(content, Does.Contain("request.TryGetArg(0, out string uid)"));
            Assert.That(content, Does.Contain("request.TryGetArg(1, out string requestId)"));
            Assert.That(content, Does.Contain("implementation.GetSnapshot(uid, requestId);"));
            Assert.That(
                content,
                Does.Contain(
                    "global::VisualBridge.Debug.VisualBridgeDebug.OnRequestArgumentError(request);"));
        }

        [Test]
        public void BuildIsDeterministic()
        {
            var first = VisualBridgeDebugContractCompiler.Build(new[] { typeof(ISampleGraphDebuger) });
            var second = VisualBridgeDebugContractCompiler.Build(new[] { typeof(ISampleGraphDebuger) });

            Assert.That(
                first.Select(file => file.RelativePath),
                Is.EqualTo(second.Select(file => file.RelativePath)));
            for (int i = 0; i < first.Count; i++)
            {
                Assert.That(first[i].Content, Is.EqualTo(second[i].Content));
            }
        }

        [Test]
        public void GeneratedContentUsesLfAndEndsWithNewLine()
        {
            foreach (var file in VisualBridgeDebugContractCompiler.Build(
                         new[] { typeof(ISampleGraphDebuger), typeof(ISampleGraphQueryDebuger) }))
            {
                Assert.That(file.Content, Does.Not.Contain("\r"), file.RelativePath);
                Assert.That(file.Content.EndsWith("\n", StringComparison.Ordinal), Is.True, file.RelativePath);
            }
        }

        [Test]
        public void BuildThrowsWhenValidationFails()
        {
            Assert.Throws<InvalidOperationException>(
                () => VisualBridgeDebugContractCompiler.Build(new[] { typeof(IUnsupportedTypeDebuger) }));
        }

        [Test]
        public void ValidateAcceptsValidFixtures()
        {
            var errors = VisualBridgeDebugContractCompiler.Validate(
                new[] { typeof(ISampleGraphDebuger), typeof(ISampleGraphQueryDebuger) });

            Assert.That(errors, Is.Empty);
        }

        [Test]
        public void ValidateReportsUnsupportedParameterType()
        {
            AssertDiagnostic("VBDBG001", typeof(IUnsupportedTypeDebuger));
        }

        [Test]
        public void ValidateReportsNonVoidReturn()
        {
            AssertDiagnostic("VBDBG002", typeof(INonVoidDebuger));
        }

        [Test]
        public void ValidateReportsGenericInterface()
        {
            AssertDiagnostic("VBDBG003", typeof(IGenericDebuger<>));
        }

        [Test]
        public void ValidateReportsNestedInterface()
        {
            AssertDiagnostic("VBDBG004", typeof(NestedDebugFixtures.INestedDebuger));
        }

        [Test]
        public void ValidateReportsOverload()
        {
            AssertDiagnostic("VBDBG005", typeof(IOverloadDebuger));
        }

        [Test]
        public void ValidateReportsNonIncreasingTags()
        {
            AssertDiagnostic("VBDBG006", typeof(ITagOrderDebuger));
        }

        [Test]
        public void ValidateReportsClassNameConflict()
        {
            var errors = VisualBridgeDebugContractCompiler.Validate(
                new[] { typeof(IConflictedDebuger), typeof(ConflictedDebuger) });

            Assert.That(errors, Has.Some.StartsWith("VBDBG007"));
        }

        [Test]
        public void ValidateReportsGeneratedFileConflict()
        {
            var errors = VisualBridgeDebugContractCompiler.Validate(
                new[]
                {
                    typeof(IConflictedDebuger),
                    typeof(VisualBridge.Editor.Tests.DebugFixtures.Other.IConflictedDebuger),
                });

            Assert.That(errors, Has.Some.StartsWith("VBDBG007"));
        }

        [Test]
        public void ValidateReportsNonPublicInterface()
        {
            AssertDiagnostic("VBDBG008", typeof(IInternalDebuger));
        }

        [Test]
        public void ValidateReportsRefParameter()
        {
            AssertDiagnostic("VBDBG009", typeof(IRefDebuger));
        }

        [Test]
        public void ValidateReportsOptionalParameter()
        {
            AssertDiagnostic("VBDBG009", typeof(IOptionalDebuger));
        }

        [Test]
        public void ValidateReportsParamsParameter()
        {
            AssertDiagnostic("VBDBG009", typeof(IParamsDebuger));
        }

        [Test]
        public void ValidateReportsOutsideGeneratedDirectory()
        {
            AssertDiagnostic("VBDBG011", typeof(IOutsideDirectoryDebuger));
        }

        [Test]
        public void ValidateReportsMissingGeneratedDirectory()
        {
            AssertDiagnostic("VBDBG012", typeof(IMissingDirectoryDebuger));
        }

        [Test]
        public void ValidateReportsInvalidInstanceParameter()
        {
            AssertDiagnostic("VBDBG013", typeof(IInvalidInstanceDebuger));
        }

        [Test]
        public void ValidateReportsInvalidFrameParameter()
        {
            AssertDiagnostic("VBDBG014", typeof(IInvalidFrameDebuger));
        }

        [Test]
        public void ValidateReportsNonInterface()
        {
            AssertDiagnostic("VBDBG015", typeof(string));
        }

        [Test]
        public void ValidateReportsInterfaceWithoutAttribute()
        {
            AssertDiagnostic("VBDBG015", typeof(IPlainDebuger));
        }

        [Test]
        public void StaticClassNameDropsInterfacePrefix()
        {
            Assert.That(
                VisualBridgeDebugContractCompiler.Build(new[] { typeof(ISampleGraphDebuger) })
                    .Any(file => file.RelativePath.EndsWith(
                        "/SampleGraphDebuger.g.cs",
                        StringComparison.Ordinal)),
                Is.True);
        }

        [Test]
        public void PredefinedAssembliesAreRecognized()
        {
            Assert.That(VisualBridgeDebugContractCompiler.IsPredefinedAssembly("Assembly-CSharp"), Is.True);
            Assert.That(
                VisualBridgeDebugContractCompiler.IsPredefinedAssembly("Assembly-CSharp-Editor"),
                Is.True);
            Assert.That(VisualBridgeDebugContractCompiler.IsPredefinedAssembly("Game.Debug"), Is.False);
            Assert.That(VisualBridgeDebugContractCompiler.IsPredefinedAssembly(null), Is.False);
        }

        [Test]
        public void GenerateWritesFilesAndIsIdempotent()
        {
            string root = CreateProjectRoot();
            try
            {
                var first = VisualBridgeDebugContractCompiler.Compile(
                    root,
                    VisualBridgeDebugContractCompileMode.Generate,
                    new[] { typeof(ISampleGraphDebuger) });

                Assert.That(first.Errors, Is.Empty);
                Assert.That(first.DriftPaths, Is.Empty);
                Assert.That(first.WrittenPaths, Is.Not.Empty);
                string facadePath = Path.Combine(root, "Assets", "Generated", "Event", "SampleGraphDebuger.g.cs");
                Assert.That(File.Exists(facadePath), Is.True);
                byte[] firstBytes = File.ReadAllBytes(facadePath);

                var second = VisualBridgeDebugContractCompiler.Compile(
                    root,
                    VisualBridgeDebugContractCompileMode.Generate,
                    new[] { typeof(ISampleGraphDebuger) });

                Assert.That(second.Errors, Is.Empty);
                Assert.That(second.WrittenPaths, Is.Empty);
                Assert.That(File.ReadAllBytes(facadePath), Is.EqualTo(firstBytes));
            }
            finally
            {
                Directory.Delete(root, true);
            }
        }

        [Test]
        public void GenerateWritesAsmdefForAsmdefAssembly()
        {
            string root = CreateProjectRoot();
            try
            {
                var result = VisualBridgeDebugContractCompiler.Compile(
                    root,
                    VisualBridgeDebugContractCompileMode.Generate,
                    new[] { typeof(ISampleGraphDebuger) });
                string assemblyName = typeof(ISampleGraphDebuger).Assembly.GetName().Name;
                string asmdefName = assemblyName + ".VisualBridgeGenerated.graph";
                string asmdefPath = Path.Combine(
                    root,
                    "Assets",
                    "Generated",
                    "Event",
                    asmdefName + ".asmdef");

                Assert.That(result.Errors, Is.Empty);
                Assert.That(File.Exists(asmdefPath), Is.True);
                var json = JObject.Parse(File.ReadAllText(asmdefPath));
                Assert.That((string)json["name"], Is.EqualTo(asmdefName));
                Assert.That(
                    ((JArray)json["references"]).Select(value => (string)value),
                    Is.EqualTo(new[] { assemblyName, "VisualBridge.Debug" }));
            }
            finally
            {
                Directory.Delete(root, true);
            }
        }

        [Test]
        public void ExistingAsmdefMismatchFailsWithoutOverwrite()
        {
            string root = CreateProjectRoot();
            try
            {
                string assemblyName = typeof(ISampleGraphDebuger).Assembly.GetName().Name;
                string asmdefName = assemblyName + ".VisualBridgeGenerated.graph";
                string directory = Path.Combine(root, "Assets", "Generated", "Event");
                Directory.CreateDirectory(directory);
                string asmdefPath = Path.Combine(directory, asmdefName + ".asmdef");
                File.WriteAllText(asmdefPath, "{}");

                var result = VisualBridgeDebugContractCompiler.Compile(
                    root,
                    VisualBridgeDebugContractCompileMode.Generate,
                    new[] { typeof(ISampleGraphDebuger) });

                Assert.That(result.Errors, Has.Some.StartsWith("VBDBG011"));
                Assert.That(File.ReadAllText(asmdefPath), Is.EqualTo("{}"));
                Assert.That(result.WrittenPaths, Is.Empty);
            }
            finally
            {
                Directory.Delete(root, true);
            }
        }

        [Test]
        public void AncestorAsmdefSuppressesGeneratedAsmdef()
        {
            string root = CreateProjectRoot();
            try
            {
                string directory = Path.Combine(root, "Assets", "Generated");
                Directory.CreateDirectory(directory);
                File.WriteAllText(Path.Combine(directory, "Existing.asmdef"), "{}");

                var result = VisualBridgeDebugContractCompiler.Compile(
                    root,
                    VisualBridgeDebugContractCompileMode.Generate,
                    new[] { typeof(ISampleGraphDebuger) });

                Assert.That(result.Errors, Is.Empty);
                Assert.That(
                    Directory.GetFiles(Path.Combine(directory, "Event"), "*.asmdef"),
                    Is.Empty);
            }
            finally
            {
                Directory.Delete(root, true);
            }
        }

        [Test]
        public void CheckDetectsContentDrift()
        {
            string root = CreateProjectRoot();
            try
            {
                VisualBridgeDebugContractCompiler.Compile(
                    root,
                    VisualBridgeDebugContractCompileMode.Generate,
                    new[] { typeof(ISampleGraphDebuger) });

                var clean = VisualBridgeDebugContractCompiler.Compile(
                    root,
                    VisualBridgeDebugContractCompileMode.Check,
                    new[] { typeof(ISampleGraphDebuger) });
                Assert.That(clean.DriftPaths, Is.Empty);

                string facadePath = Path.Combine(root, "Assets", "Generated", "Event", "SampleGraphDebuger.g.cs");
                File.AppendAllText(facadePath, "// drift\n");

                var drifted = VisualBridgeDebugContractCompiler.Compile(
                    root,
                    VisualBridgeDebugContractCompileMode.Check,
                    new[] { typeof(ISampleGraphDebuger) });
                Assert.That(
                    drifted.DriftPaths,
                    Does.Contain("Assets/Generated/Event/SampleGraphDebuger.g.cs"));
            }
            finally
            {
                Directory.Delete(root, true);
            }
        }

        [Test]
        public void CheckTreatsMissingFileAsDrift()
        {
            string root = CreateProjectRoot();
            try
            {
                VisualBridgeDebugContractCompiler.Compile(
                    root,
                    VisualBridgeDebugContractCompileMode.Generate,
                    new[] { typeof(ISampleGraphDebuger) });
                File.Delete(Path.Combine(
                    root,
                    "Assets",
                    "Generated",
                    "Event",
                    "VisualBridgeGeneratedSampleGraphDebuger.g.cs"));

                var result = VisualBridgeDebugContractCompiler.Compile(
                    root,
                    VisualBridgeDebugContractCompileMode.Check,
                    new[] { typeof(ISampleGraphDebuger) });

                Assert.That(
                    result.DriftPaths,
                    Does.Contain("Assets/Generated/Event/VisualBridgeGeneratedSampleGraphDebuger.g.cs"));
            }
            finally
            {
                Directory.Delete(root, true);
            }
        }

        [Test]
        public void CheckIgnoresExtraFiles()
        {
            string root = CreateProjectRoot();
            try
            {
                VisualBridgeDebugContractCompiler.Compile(
                    root,
                    VisualBridgeDebugContractCompileMode.Generate,
                    new[] { typeof(ISampleGraphDebuger) });
                string directory = Path.Combine(root, "Assets", "Generated", "Event");
                File.WriteAllText(Path.Combine(directory, "Extra.cs"), "// extra");

                var result = VisualBridgeDebugContractCompiler.Compile(
                    root,
                    VisualBridgeDebugContractCompileMode.Check,
                    new[] { typeof(ISampleGraphDebuger) });

                Assert.That(result.Errors, Is.Empty);
                Assert.That(result.DriftPaths, Is.Empty);
                Assert.That(File.Exists(Path.Combine(directory, "Extra.cs")), Is.True);
            }
            finally
            {
                Directory.Delete(root, true);
            }
        }

        [Test]
        public void CompileWithNoInterfacesProducesNothing()
        {
            string root = CreateProjectRoot();
            try
            {
                var result = VisualBridgeDebugContractCompiler.Compile(
                    root,
                    VisualBridgeDebugContractCompileMode.Generate,
                    Array.Empty<Type>());

                Assert.That(result.Errors, Is.Empty);
                Assert.That(result.Files, Is.Empty);
                Assert.That(result.WrittenPaths, Is.Empty);
            }
            finally
            {
                Directory.Delete(root, true);
            }
        }

        private static void AssertDiagnostic(string code, Type type)
        {
            var errors = VisualBridgeDebugContractCompiler.Validate(new[] { type });
            Assert.That(errors, Has.Some.StartsWith(code), string.Join("\n", errors));
        }

        private static string GetContent(
            IReadOnlyList<VisualBridgeDebugGeneratedFile> files,
            string fileName)
        {
            VisualBridgeDebugGeneratedFile file = files.FirstOrDefault(
                value => value.RelativePath.EndsWith("/" + fileName, StringComparison.Ordinal));
            Assert.That(file, Is.Not.Null, "Missing generated file " + fileName);
            return file.Content;
        }

        private static string CreateProjectRoot()
        {
            string path = Path.Combine(
                Path.GetTempPath(),
                "vbdbg-task4-tests",
                Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(path);
            return path;
        }
    }
}
