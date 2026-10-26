using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using Newtonsoft.Json.Linq;
using NUnit.Framework;
using VisualBridge.Diagnostics;

namespace VisualBridge.Editor.Tests
{
    /// <summary>测试夹具与特性共用的目录常量（特性参数必须是编译期常量）。</summary>
    internal static class VisualBridgeDebugGeneratorTestPaths
    {
        public const string GeneratedDirectory = "Assets/Generated/DebugTests";
        public const string ArtifactsRoot = "Assets/Generated/DebugArtifacts";
        public const string PackageDirectory = "Packages/com.tests.contracts";
        public const string PackageGeneratedDirectory = "Packages/com.tests.contracts/Generated";
        public const string UncoveredDirectory = "Generated/Outside";
    }

    /// <summary>D2 生成器归一化到模型的节点枚举：覆盖枚举参数、枚举结果与枚举成员 hash。</summary>
    public enum VisualBridgeTestNodeKind
    {
        None = 0,
        Started = 1,
        Finished = 2,
    }

    /// <summary>Event 契约：命名实例参数、[VisualBridgeDebugInstance]、显式 tag 与自动 tag 混合。</summary>
    [VisualBridgeDebuger(
        "graph",
        Kind = VisualBridgeDebugerKind.Event,
        GeneratedDirectory = VisualBridgeDebugGeneratorTestPaths.GeneratedDirectory)]
    public interface IVisualBridgeTestEventDebuger
    {
        bool NodeStarted(string instanceId, int nodeId, string label = null);

        bool NodeFinished(
            [VisualBridgeDebugInstance] string target,
            [VisualBridgeDebugTag(3)] float duration,
            VisualBridgeTestNodeKind kind);
    }

    /// <summary>号段耗尽用例：同分类的额外方法。</summary>
    [VisualBridgeDebuger(
        "graph",
        Kind = VisualBridgeDebugerKind.Event,
        GeneratedDirectory = VisualBridgeDebugGeneratorTestPaths.GeneratedDirectory)]
    public interface IVisualBridgeTestGraphExtraDebuger
    {
        bool Extra(string instanceId);
    }

    /// <summary>Query 契约：bool 结果与 void 结果各一例。</summary>
    [VisualBridgeDebuger(
        "query",
        Kind = VisualBridgeDebugerKind.Query,
        GeneratedDirectory = VisualBridgeDebugGeneratorTestPaths.GeneratedDirectory)]
    public interface IVisualBridgeTestQueryDebuger
    {
        bool IsVisible(VisualBridgeDebugRequest request, int nodeId);

        void Reset(VisualBridgeDebugRequest request);
    }

    /// <summary>号段测试分类：三个方法分属三个接口，便于模拟删除后再新增。</summary>
    [VisualBridgeDebuger(
        "alpha",
        Kind = VisualBridgeDebugerKind.Event,
        GeneratedDirectory = VisualBridgeDebugGeneratorTestPaths.GeneratedDirectory)]
    public interface IVisualBridgeTestAlphaDebuger
    {
        bool Ping(string instanceId);
    }

    [VisualBridgeDebuger(
        "alpha",
        Kind = VisualBridgeDebugerKind.Event,
        GeneratedDirectory = VisualBridgeDebugGeneratorTestPaths.GeneratedDirectory)]
    public interface IVisualBridgeTestAlphaExtraDebuger
    {
        bool Pong(string instanceId);
    }

    [VisualBridgeDebuger(
        "alpha",
        Kind = VisualBridgeDebugerKind.Event,
        GeneratedDirectory = VisualBridgeDebugGeneratorTestPaths.GeneratedDirectory)]
    public interface IVisualBridgeTestAlphaThirdDebuger
    {
        bool Zap(string instanceId);
    }

    /// <summary>VBDBG014 负例：同分类同方法名。</summary>
    [VisualBridgeDebuger(
        "alpha",
        Kind = VisualBridgeDebugerKind.Event,
        GeneratedDirectory = VisualBridgeDebugGeneratorTestPaths.GeneratedDirectory)]
    public interface IVisualBridgeTestDuplicateDebuger
    {
        bool Ping(string instanceId);
    }

    /// <summary>debug.categoryDirectoryMismatch 负例：分类相同、目录不同。</summary>
    [VisualBridgeDebuger(
        "graph",
        Kind = VisualBridgeDebugerKind.Event,
        GeneratedDirectory = "Assets/Generated/OtherDirectory")]
    public interface IVisualBridgeTestGraphOtherDirectoryDebuger
    {
        bool Other(string instanceId);
    }

    /// <summary>显式 tag + 自动 tag 混合正例。</summary>
    [VisualBridgeDebuger(
        "tags",
        Kind = VisualBridgeDebugerKind.Event,
        GeneratedDirectory = VisualBridgeDebugGeneratorTestPaths.GeneratedDirectory)]
    public interface IVisualBridgeTestTaggedMixDebuger
    {
        bool Mix(string instanceId, [VisualBridgeDebugTag(1)] int first, int second);
    }

    /// <summary>debug.tagDuplicate 负例：显式 tag 重复。</summary>
    [VisualBridgeDebuger(
        "tagdup",
        Kind = VisualBridgeDebugerKind.Event,
        GeneratedDirectory = VisualBridgeDebugGeneratorTestPaths.GeneratedDirectory)]
    public interface IVisualBridgeTestTagDuplicateDebuger
    {
        bool Dup(string instanceId, [VisualBridgeDebugTag(1)] int first, [VisualBridgeDebugTag(1)] int second);
    }

    /// <summary>默认值字面量正例：uint/ulong/long 后缀与 double -0.0 的符号。</summary>
    [VisualBridgeDebuger(
        "defaults",
        Kind = VisualBridgeDebugerKind.Event,
        GeneratedDirectory = VisualBridgeDebugGeneratorTestPaths.GeneratedDirectory)]
    public interface IVisualBridgeTestDefaultsDebuger
    {
        bool Tick(string instanceId, uint count = 5, double offset = -0.0, long big = 7L, ulong huge = 9UL);
    }

    /// <summary>保留关键字参数名正例。</summary>
    [VisualBridgeDebuger(
        "keywords",
        Kind = VisualBridgeDebugerKind.Event,
        GeneratedDirectory = VisualBridgeDebugGeneratorTestPaths.GeneratedDirectory)]
    public interface IVisualBridgeTestKeywordDebuger
    {
        bool Send(string instanceId, int @class);
    }

    /// <summary>debug.genericMethodUnsupported 负例。</summary>
    [VisualBridgeDebuger(
        "generic",
        Kind = VisualBridgeDebugerKind.Event,
        GeneratedDirectory = VisualBridgeDebugGeneratorTestPaths.GeneratedDirectory)]
    public interface IVisualBridgeTestGenericMethodDebuger
    {
        T Echo<T>(string instanceId);
    }

    /// <summary>被继承的基接口（自身不标注）。</summary>
    public interface IVisualBridgeTestInheritedBase
    {
        bool BaseTick(string instanceId);
    }

    /// <summary>debug.inheritedInterfaceUnsupported 负例。</summary>
    [VisualBridgeDebuger(
        "inherited",
        Kind = VisualBridgeDebugerKind.Event,
        GeneratedDirectory = VisualBridgeDebugGeneratorTestPaths.GeneratedDirectory)]
    public interface IVisualBridgeTestInheritedDebuger : IVisualBridgeTestInheritedBase
    {
        bool Own(string instanceId);
    }

    /// <summary>debug.interfaceNotVisible 负例：internal 接口不能生成 public 门面。</summary>
    [VisualBridgeDebuger(
        "internal",
        Kind = VisualBridgeDebugerKind.Event,
        GeneratedDirectory = VisualBridgeDebugGeneratorTestPaths.GeneratedDirectory)]
    internal interface IVisualBridgeTestInternalDebuger
    {
        bool Tick(string instanceId);
    }

    /// <summary>VBDBG011 负例：GeneratedDirectory 指向工程根（"."）。</summary>
    [VisualBridgeDebuger(
        "rootdir",
        Kind = VisualBridgeDebugerKind.Event,
        GeneratedDirectory = ".")]
    public interface IVisualBridgeTestRootDirectoryDebuger
    {
        bool Tick(string instanceId);
    }

    /// <summary>VBDBG012 负例：两个 string 参数且没有 instanceId / [VisualBridgeDebugInstance]。</summary>
    [VisualBridgeDebuger(
        "badinst",
        Kind = VisualBridgeDebugerKind.Event,
        GeneratedDirectory = VisualBridgeDebugGeneratorTestPaths.GeneratedDirectory)]
    public interface IVisualBridgeTestBadInstanceDebuger
    {
        bool Bad(string first, string second);
    }

    /// <summary>VBDBG013 负例：缺 GeneratedDirectory。</summary>
    [VisualBridgeDebuger("missingdir", Kind = VisualBridgeDebugerKind.Event)]
    public interface IVisualBridgeTestMissingDirectoryDebuger
    {
        bool Tick(string instanceId);
    }

    /// <summary>VBDBG011 负例：目录在 Assets 之外且没有 asmdef 祖先。</summary>
    [VisualBridgeDebuger(
        "outside",
        Kind = VisualBridgeDebugerKind.Event,
        GeneratedDirectory = VisualBridgeDebugGeneratorTestPaths.UncoveredDirectory)]
    public interface IVisualBridgeTestOutsideDebuger
    {
        bool Tick(string instanceId);
    }

    /// <summary>VBDBG011 正例：Assets 之外但被 asmdef 覆盖的包目录放行。</summary>
    [VisualBridgeDebuger(
        "package",
        Kind = VisualBridgeDebugerKind.Event,
        GeneratedDirectory = VisualBridgeDebugGeneratorTestPaths.PackageGeneratedDirectory)]
    public interface IVisualBridgeTestPackageDebuger
    {
        bool Tick(string instanceId);
    }

    /// <summary>
    /// D2 调试生成器的 EditMode 用例：确定性、号段稳定与删除不复用、自动 tag 与发射顺序、contractHash
    /// 逐字段敏感度、Check 检出全部产物与陈旧产物、Event/Query 两类产物、VBDBG011/012/013/014/015 负例，
    /// 以及 batch 退出码映射与 VisualBridgeDebugConfig 默认值。
    /// 全部用例在系统临时目录里搭一个假 Unity 工程根，不写真实工程。
    /// </summary>
    public sealed class VisualBridgeDebugGeneratorTests
    {
        private static readonly Type[] DefaultInterfaces =
        {
            typeof(IVisualBridgeTestEventDebuger),
            typeof(IVisualBridgeTestQueryDebuger),
            typeof(IVisualBridgeTestAlphaDebuger),
            typeof(IVisualBridgeTestAlphaExtraDebuger),
        };

        [Test]
        public void GeneratesAllArtifactsDeterministicallyAndCheckIsClean()
        {
            using (var fixture = new GeneratorFixture())
            {
                var first = fixture.Generate(DefaultInterfaces);
                var snapshot = first.Outputs.ToDictionary(output => output.Path, output => File.ReadAllBytes(output.Path));

                Assert.That(first.Outputs.Count, Is.EqualTo(17),
                    "期望 4 个接口（4 门面 + 4 实现/分发器）+ 3 个分类 C# + 3 个分类 TS + 3 个全局产物，实际："
                    + string.Join(", ", first.Outputs.Select(output => Path.GetFileName(output.Path))));
                Assert.That(first.ContractHash.Length, Is.EqualTo(16));
                Assert.That(first.Outputs.All(output => output.ExpectedSha256.Length == 64), Is.True,
                    "产物哈希应是完整 SHA-256（64 位十六进制）");
                Assert.That(first.ContractHash, Is.Not.EqualTo(first.Outputs[0].ExpectedSha256));
                foreach (var output in first.Outputs)
                {
                    var text = File.ReadAllText(output.Path);
                    Assert.That(text.StartsWith("// <auto-generated />\n", StringComparison.Ordinal)
                            || text.Contains("\"//\": \"// <auto-generated />\""),
                        "产物缺少 auto-generated 标记：" + output.Path);
                    Assert.That(text.Contains("\r"), Is.False, "产物必须是 LF：" + output.Path);
                }

                var second = fixture.Generate(DefaultInterfaces.Reverse().ToArray());
                Assert.That(second.Outputs.All(output => !output.Changed), Is.True, "重复生成不应改动产物");
                Assert.That(second.StaleOutputs, Is.Empty);
                Assert.That(second.Outputs.All(output =>
                    snapshot[output.Path].SequenceEqual(File.ReadAllBytes(output.Path))), Is.True, "字节不一致");
                Assert.That(second.ContractHash, Is.EqualTo(first.ContractHash));

                var check = fixture.Check(DefaultInterfaces);
                Assert.That(check.DriftDetected, Is.False, "Generate 后立刻 Check 不应 drift");
            }
        }

        [Test]
        public void MethodIdsAreStableAndDeletedNumbersAreNotReused()
        {
            using (var fixture = new GeneratorFixture())
            {
                fixture.Generate(DefaultInterfaces);
                var ids = fixture.ReadIds();
                Assert.That(MethodId(ids, "graph", "NodeFinished"), Is.EqualTo(10));
                Assert.That(MethodId(ids, "graph", "NodeStarted"), Is.EqualTo(11));
                Assert.That(MethodId(ids, "query", "IsVisible"), Is.EqualTo(10));
                Assert.That(MethodId(ids, "query", "Reset"), Is.EqualTo(11));
                Assert.That(MethodId(ids, "alpha", "Ping"), Is.EqualTo(10));
                Assert.That(MethodId(ids, "alpha", "Pong"), Is.EqualTo(11));
                Assert.That(MethodId(ids, "alpha", "Zap"), Is.Null);

                // 删除 Pong、新增 Zap：Zap 必须接着 12，而不是复用被删掉的 11。
                var removed = fixture.Generate(new[]
                {
                    typeof(IVisualBridgeTestEventDebuger),
                    typeof(IVisualBridgeTestQueryDebuger),
                    typeof(IVisualBridgeTestAlphaDebuger),
                    typeof(IVisualBridgeTestAlphaThirdDebuger),
                });
                Assert.That(removed.StaleOutputs.Count, Is.EqualTo(2), "Pong 的门面与实现应作为陈旧产物清理");
                ids = fixture.ReadIds();
                Assert.That(MethodId(ids, "alpha", "Pong"), Is.EqualTo(11), "已删除方法的号必须保留");
                Assert.That(MethodId(ids, "alpha", "Zap"), Is.EqualTo(12), "新方法不能复用已删除方法的号");

                fixture.Generate(DefaultInterfaces);
                ids = fixture.ReadIds();
                Assert.That(MethodId(ids, "alpha", "Pong"), Is.EqualTo(11), "恢复接口后仍是原号");
                Assert.That(MethodId(ids, "alpha", "Zap"), Is.EqualTo(12));
                Assert.That(MethodId(ids, "alpha", "nextMethodId"), Is.EqualTo(13));
                Assert.That(fixture.Check(DefaultInterfaces).DriftDetected, Is.False);
            }
        }

        [Test]
        public void DuplicateNumberInPersistedIdsFailsWithVbdbg015()
        {
            using (var fixture = new GeneratorFixture())
            {
                fixture.Generate(DefaultInterfaces);
                var idsPath = fixture.ArtifactPath("debug-ids.json");
                var original = File.ReadAllText(idsPath);
                var tampered = JObject.Parse(original);
                tampered["categories"]["alpha"]["methods"]["Pong"] = 10;
                File.WriteAllText(idsPath, tampered.ToString());

                Assert.That(fixture.ExpectError(DefaultInterfaces), Is.EqualTo("VBDBG015"), "同分类同号不同名应 VBDBG015");

                tampered = JObject.Parse(original);
                tampered["categories"]["alpha"]["nextMethodId"] = 11;
                File.WriteAllText(idsPath, tampered.ToString());
                Assert.That(fixture.ExpectError(DefaultInterfaces), Is.EqualTo("VBDBG015"), "nextMethodId 冲突应 VBDBG015");
            }
        }

        [Test]
        public void ExhaustedMethodIdSentinelIsAcceptedUntilNewAllocationFails()
        {
            using (var fixture = new GeneratorFixture())
            {
                // 65536 是「号已耗尽」的合法哨兵：已有方法照常生成，新分配才失败。
                File.WriteAllText(
                    fixture.ArtifactPath("debug-ids.json"),
                    "{\n  \"categories\": {\n    \"graph\": {\n      \"nextMethodId\": 65536,\n"
                    + "      \"methods\": {\n        \"NodeFinished\": 65534,\n        \"NodeStarted\": 65535\n      }\n"
                    + "    }\n  }\n}\n",
                    new UTF8Encoding(false));

                var generated = fixture.Generate(new[] { typeof(IVisualBridgeTestEventDebuger) });
                Assert.That(generated.ContractHash.Length, Is.EqualTo(16));
                Assert.That(fixture.ReadIds()["categories"]["graph"]["nextMethodId"].Value<int>(), Is.EqualTo(65536));

                Assert.That(fixture.ExpectError(new[]
                {
                    typeof(IVisualBridgeTestEventDebuger),
                    typeof(IVisualBridgeTestGraphExtraDebuger),
                }), Is.EqualTo("debug.methodIdExhausted"));
            }
        }

        [Test]
        public void ContractHashReflectsEachContractField()
        {
            var baseline = VisualBridgeDebugContractHash.Compute(BuildHashDefinition());

            Assert.That(HashOf(BuildHashDefinition(categoryName: "hash2")), Is.Not.EqualTo(baseline), "分类名");
            Assert.That(HashOf(BuildHashDefinition(interfaceFullName: "VisualBridge.Editor.Tests.IProbeDebuger2")),
                Is.Not.EqualTo(baseline), "接口全名");
            Assert.That(HashOf(BuildHashDefinition(className: "ProbeDebuger2")), Is.Not.EqualTo(baseline), "类名");
            Assert.That(HashOf(BuildHashDefinition(kind: VisualBridgeDebugerKind.Query)), Is.Not.EqualTo(baseline), "接口类型");
            Assert.That(HashOf(BuildHashDefinition(methodName: "Probe2")), Is.Not.EqualTo(baseline), "方法名");
            Assert.That(HashOf(BuildHashDefinition(methodId: 43)), Is.Not.EqualTo(baseline), "方法号");
            Assert.That(HashOf(BuildHashDefinition(resultContractType: "void")), Is.Not.EqualTo(baseline), "结果类型");
            Assert.That(HashOf(BuildHashDefinition(parameterName: "other")), Is.Not.EqualTo(baseline), "参数名");
            Assert.That(HashOf(BuildHashDefinition(
                    parameterType: typeof(long),
                    contractType: "long",
                    castType: "long",
                    valueKind: VisualBridgeDebugValueKind.Long)), Is.Not.EqualTo(baseline), "参数类型");
            Assert.That(HashOf(BuildHashDefinition(tag: 2)), Is.Not.EqualTo(baseline), "参数 tag");
            Assert.That(HashOf(BuildHashDefinition(instance: true)), Is.Not.EqualTo(baseline), "参数角色");
            Assert.That(HashOf(BuildHashDefinition(optional: true)), Is.Not.EqualTo(baseline), "参数可选性");
            Assert.That(HashOf(BuildHashDefinition(enumFullName: "VisualBridge.Editor.Tests.OtherKind")),
                Is.Not.EqualTo(baseline), "枚举类型名");
            Assert.That(HashOf(BuildHashDefinition(enumMembers: new[] { Member("None", 0L), Member("Started", 2L) })),
                Is.Not.EqualTo(baseline), "枚举成员值");
            Assert.That(HashOf(BuildHashDefinition(enumUnderlying: "long")), Is.Not.EqualTo(baseline), "枚举底层类型");

            // 非契约输入：生成目录不进 hash；成员顺序与分类顺序也不进 hash。
            Assert.That(HashOf(BuildHashDefinition(generatedDirectory: "Assets/Generated/Elsewhere")), Is.EqualTo(baseline),
                "生成目录不是契约输入");
            Assert.That(HashOf(BuildHashDefinition(
                    enumMembers: new[] { Member("Started", 1L), Member("None", 0L) })), Is.EqualTo(baseline),
                "枚举成员顺序不应改变 hash");

            var alpha = BuildHashDefinition(categoryName: "alpha");
            var beta = BuildHashDefinition(categoryName: "beta");
            var ordered = new VisualBridgeDebugDefinitionModel(
                new[] { alpha.Categories[0], beta.Categories[0] },
                alpha.Enums.Concat(beta.Enums).ToArray());
            var reordered = new VisualBridgeDebugDefinitionModel(
                new[] { beta.Categories[0], alpha.Categories[0] },
                alpha.Enums.Concat(beta.Enums).Reverse().ToArray());
            Assert.That(VisualBridgeDebugContractHash.Compute(reordered), Is.EqualTo(VisualBridgeDebugContractHash.Compute(ordered)),
                "分类/枚举顺序不应改变 hash");
        }

        [Test]
        public void CheckDetectsManualEditsToEveryArtifact()
        {
            using (var fixture = new GeneratorFixture())
            {
                var result = fixture.Generate(DefaultInterfaces);
                Assert.That(result.Outputs.Count, Is.GreaterThanOrEqualTo(9));

                foreach (var output in result.Outputs)
                {
                    var original = File.ReadAllBytes(output.Path);
                    File.WriteAllBytes(output.Path, original.Concat(Encoding.UTF8.GetBytes("// tamper\n")).ToArray());

                    var drift = fixture.Check(DefaultInterfaces);
                    Assert.That(drift.DriftDetected, Is.True, "Check 未检出改动：" + output.Path);
                    Assert.That(drift.Outputs.Single(value => value.Path == output.Path).Changed, Is.True,
                        "Check 未把改动算作 Changed：" + output.Path);

                    fixture.Generate(DefaultInterfaces);
                    Assert.That(fixture.Check(DefaultInterfaces).DriftDetected, Is.False, "重新 Generate 后应恢复干净");
                }
            }
        }

        [Test]
        public void MissingArtifactIsReportedAsDrift()
        {
            using (var fixture = new GeneratorFixture())
            {
                var result = fixture.Generate(DefaultInterfaces);
                File.Delete(result.Outputs[0].Path);

                var check = fixture.Check(DefaultInterfaces);
                Assert.That(check.DriftDetected, Is.True);
                Assert.That(check.Outputs.Single(output => output.Path == result.Outputs[0].Path).Changed, Is.True);
                Assert.That(check.Outputs.Single(output => output.Path == result.Outputs[0].Path).PreviousSha256, Is.Null);
            }
        }

        [Test]
        public void StaleArtifactsAreReportedAsDriftAndRemovedByGenerate()
        {
            using (var fixture = new GeneratorFixture())
            {
                fixture.Generate(DefaultInterfaces);
                var ghost = Path.Combine(fixture.GeneratedDirectoryFullPath, "VisualBridgeGeneratedGhostDebuger.g.cs");
                File.WriteAllText(ghost, "// <auto-generated />\nnamespace Ghost { }\n", new UTF8Encoding(false));

                var check = fixture.Check(DefaultInterfaces);
                Assert.That(check.DriftDetected, Is.True);
                Assert.That(check.StaleOutputs, Does.Contain(ghost));

                fixture.Generate(DefaultInterfaces);
                Assert.That(File.Exists(ghost), Is.False, "Generate 应删除陈旧产物");
            }
        }

        [Test]
        public void DeletingWholeCategoryRemovesItsArtifactsAndCheckStaysClean()
        {
            using (var fixture = new GeneratorFixture())
            {
                fixture.Generate(DefaultInterfaces);
                var generatedDirectory = fixture.GeneratedDirectoryFullPath;
                Assert.That(File.Exists(Path.Combine(generatedDirectory, "VisualBridgeTestAlphaDebuger.g.cs")), Is.True);
                Assert.That(File.Exists(Path.Combine(generatedDirectory, "alpha.g.ts")), Is.True);

                // 整个 alpha 分类消失：旧产物必须按上次 Generate 的清单清理，而不是留在原地。
                var removed = fixture.Generate(new[]
                {
                    typeof(IVisualBridgeTestEventDebuger),
                    typeof(IVisualBridgeTestQueryDebuger),
                });

                Assert.That(removed.StaleOutputs, Is.Not.Empty, "删除整个分类应报告陈旧产物");
                Assert.That(removed.StaleOutputs.All(path => path.Contains("Alpha", StringComparison.Ordinal)
                    || path.EndsWith("alpha.g.ts", StringComparison.Ordinal)), Is.True,
                    "陈旧产物应只属于被删分类：" + string.Join(", ", removed.StaleOutputs));
                Assert.That(File.Exists(Path.Combine(generatedDirectory, "VisualBridgeTestAlphaDebuger.g.cs")), Is.False);
                Assert.That(File.Exists(Path.Combine(generatedDirectory, "AlphaCategory.g.cs")), Is.False);
                Assert.That(File.Exists(Path.Combine(generatedDirectory, "alpha.g.ts")), Is.False);

                Assert.That(fixture.Check(new[]
                {
                    typeof(IVisualBridgeTestEventDebuger),
                    typeof(IVisualBridgeTestQueryDebuger),
                }).DriftDetected, Is.False, "清理后 Check 不应误报");
            }
        }

        [Test]
        public void ChangingArtifactsRootRemovesPreviousGlobalArtifacts()
        {
            using (var fixture = new GeneratorFixture())
            {
                fixture.Generate(DefaultInterfaces);
                var previousContracts = fixture.ArtifactPath("debug-contracts.json");
                Assert.That(File.Exists(previousContracts), Is.True);

                const string newRoot = "Assets/Generated/DebugArtifacts2";
                var moved = fixture.GenerateWithArtifactsRoot(newRoot, DefaultInterfaces);
                Assert.That(moved.StaleOutputs, Does.Contain(previousContracts), "换 ArtifactsRoot 应清理旧全局产物");
                Assert.That(File.Exists(previousContracts), Is.False);
                Assert.That(File.Exists(Path.Combine(
                    fixture.Root,
                    newRoot.Replace('/', Path.DirectorySeparatorChar),
                    "debug-contracts.json")), Is.True);
                Assert.That(fixture.CheckWithArtifactsRoot(newRoot, DefaultInterfaces).DriftDetected, Is.False);
            }
        }

        [Test]
        public void CheckIsReadOnly()
        {
            using (var fixture = new GeneratorFixture())
            {
                fixture.Generate(DefaultInterfaces);
                var before = SnapshotTree(fixture.Root);

                var check = fixture.Check(DefaultInterfaces);
                Assert.That(check.DriftDetected, Is.False);

                var after = SnapshotTree(fixture.Root);
                Assert.That(after, Is.EqualTo(before), "Check 不得创建/修改任何文件（含 Library 下的锁与状态）");
            }
        }

        [Test]
        public void EventInterfaceGeneratesFacadeAndImplementation()
        {
            using (var fixture = new GeneratorFixture())
            {
                var result = fixture.Generate(new[] { typeof(IVisualBridgeTestEventDebuger) });
                var methodId = (int)fixture.ReadIds()["categories"]["graph"]["methods"]["NodeStarted"];
                Assert.That(result.ContractHash.Length, Is.EqualTo(16));

                var facade = File.ReadAllText(Path.Combine(fixture.GeneratedDirectoryFullPath, "VisualBridgeTestEventDebuger.g.cs"));
                Assert.That(facade, Does.Contain("public static class VisualBridgeTestEventDebuger"));
                Assert.That(facade, Does.Contain("public static bool NodeStarted(string instanceId, int nodeId, string label = null)"),
                    "门面应复制接口签名与默认值");
                Assert.That(facade, Does.Contain("#else\n            return false;\n#endif"), "宏关闭时门面只保留 return false");

                var implementation = File.ReadAllText(
                    Path.Combine(fixture.GeneratedDirectoryFullPath, "VisualBridgeGeneratedVisualBridgeTestEventDebuger.g.cs"));
                Assert.That(implementation, Does.Contain(
                    "VisualBridgeDebug.Start(instanceId, \"graph\", " + methodId + ", \"IVisualBridgeTestEventDebuger\", \"NodeStarted\")"));
                Assert.That(implementation, Does.Contain("PushParam(\"nodeId\", 1, (int)nodeId);"),
                    "未标记参数应从 1 起自动分配 tag");
                Assert.That(implementation, Does.Contain("PushParam(\"label\", 2, (string)label);"));
                Assert.That(implementation, Does.Contain("PushParam(\"kind\", 1, (global::System.Enum)kind);"),
                    "自动 tag 要跳过显式占用的号，枚举显式转换到 Enum 重载");
                Assert.That(implementation, Does.Contain("PushParam(\"duration\", 3, (float)duration);"));
                Assert.That(implementation, Does.Contain("if (!global::VisualBridge.Diagnostics.VisualBridgeDebug.Start("),
                    "Start 返回 false 后必须立即返回");

                var category = File.ReadAllText(Path.Combine(fixture.GeneratedDirectoryFullPath, "GraphCategory.g.cs"));
                Assert.That(category, Does.Contain("public static class GraphProtocol"));
                Assert.That(category, Does.Contain("public const ushort NodeStarted = " + methodId + ";"));
                Assert.That(category, Does.Contain("public const string Category = \"graph\";"));
            }
        }

        [Test]
        public void PushParamIsEmittedInTagOrder()
        {
            using (var fixture = new GeneratorFixture())
            {
                fixture.Generate(new[] { typeof(IVisualBridgeTestEventDebuger) });
                var implementation = File.ReadAllText(
                    Path.Combine(fixture.GeneratedDirectoryFullPath, "VisualBridgeGeneratedVisualBridgeTestEventDebuger.g.cs"));
                var kindIndex = implementation.IndexOf("PushParam(\"kind\", 1,", StringComparison.Ordinal);
                var durationIndex = implementation.IndexOf("PushParam(\"duration\", 3,", StringComparison.Ordinal);
                Assert.That(kindIndex, Is.GreaterThanOrEqualTo(0));
                Assert.That(durationIndex, Is.GreaterThan(kindIndex),
                    "声明顺序 duration 在 kind 之前，但必须按 tag 升序发射（kind tag1 < duration tag3）");
            }
        }

        [Test]
        public void UnmarkedParametersGetAutomaticTagsInContract()
        {
            using (var fixture = new GeneratorFixture())
            {
                fixture.Generate(new[] { typeof(IVisualBridgeTestEventDebuger) });
                var contracts = JObject.Parse(File.ReadAllText(fixture.ArtifactPath("debug-contracts.json")));
                var nodeStarted = contracts["categories"].Children<JObject>()
                    .First(value => value["name"].Value<string>() == "graph")["interfaces"].Children<JObject>()
                    .First(value => value["name"].Value<string>() == "IVisualBridgeTestEventDebuger")["methods"].Children<JObject>()
                    .First(value => value["name"].Value<string>() == "NodeStarted");
                var parameters = nodeStarted["parameters"].Children<JObject>().ToArray();
                Assert.That(parameters[0]["role"].Value<string>(), Is.EqualTo("instance"));
                Assert.That(parameters[0]["tag"], Is.Null, "实例参数不进入载荷，不应有 tag");
                Assert.That((int)parameters[1]["tag"], Is.EqualTo(1));
                Assert.That((int)parameters[2]["tag"], Is.EqualTo(2));
            }
        }

        [Test]
        public void MixedExplicitAndAutomaticTagsStayUnique()
        {
            using (var fixture = new GeneratorFixture())
            {
                fixture.Generate(new[] { typeof(IVisualBridgeTestTaggedMixDebuger) });
                var implementation = File.ReadAllText(
                    Path.Combine(fixture.GeneratedDirectoryFullPath, "VisualBridgeGeneratedVisualBridgeTestTaggedMixDebuger.g.cs"));
                Assert.That(implementation, Does.Contain("PushParam(\"first\", 1, (int)first);"));
                Assert.That(implementation, Does.Contain("PushParam(\"second\", 2, (int)second);"),
                    "未标记参数要跳过显式占用的 1，拿到 2");
            }
        }

        [Test]
        public void DuplicateExplicitTagsAreRejected()
        {
            using (var fixture = new GeneratorFixture())
            {
                Assert.That(fixture.ExpectError(new[] { typeof(IVisualBridgeTestTagDuplicateDebuger) }),
                    Is.EqualTo("debug.tagDuplicate"));
            }
        }

        [Test]
        public void DefaultValueLiteralsAreTypeCorrect()
        {
            Assert.That(LiteralOf<uint>(7, VisualBridgeDebugValueKind.Long, "long"), Is.EqualTo("7u"));
            Assert.That(LiteralOf<ulong>(9, VisualBridgeDebugValueKind.Ulong, "ulong"), Is.EqualTo("9UL"));
            Assert.That(LiteralOf<long>(11, VisualBridgeDebugValueKind.Long, "long"), Is.EqualTo("11L"));
            Assert.That(LiteralOf<int>(3, VisualBridgeDebugValueKind.Int, "int"), Is.EqualTo("3"));
            Assert.That(LiteralOf<double>(-0.0, VisualBridgeDebugValueKind.Double, "double"), Is.EqualTo("-0.0"));
            Assert.That(LiteralOf<float>(-0.0f, VisualBridgeDebugValueKind.Float, "float"), Is.EqualTo("-0.0f"));
            Assert.That(LiteralOf(VisualBridgeTestNodeKind.Finished, VisualBridgeDebugValueKind.Enum, "enum"),
                Is.EqualTo("(global::VisualBridge.Editor.Tests.VisualBridgeTestNodeKind)2"));
        }

        [Test]
        public void KeywordParameterNamesAreEscaped()
        {
            using (var fixture = new GeneratorFixture())
            {
                fixture.Generate(new[] { typeof(IVisualBridgeTestKeywordDebuger) });
                var facade = File.ReadAllText(
                    Path.Combine(fixture.GeneratedDirectoryFullPath, "VisualBridgeTestKeywordDebuger.g.cs"));
                Assert.That(facade, Does.Contain("int @class"));
                var implementation = File.ReadAllText(
                    Path.Combine(fixture.GeneratedDirectoryFullPath, "VisualBridgeGeneratedVisualBridgeTestKeywordDebuger.g.cs"));
                Assert.That(implementation, Does.Contain("PushParam(\"class\", 1, (int)@class);"));
            }
        }

        [Test]
        public void QueryInterfaceGeneratesDispatcherAndResultFacade()
        {
            using (var fixture = new GeneratorFixture())
            {
                fixture.Generate(new[] { typeof(IVisualBridgeTestQueryDebuger) });

                var facade = File.ReadAllText(Path.Combine(fixture.GeneratedDirectoryFullPath, "VisualBridgeTestQueryDebuger.g.cs"));
                Assert.That(facade, Does.Contain("public static void Register(global::VisualBridge.Editor.Tests.IVisualBridgeTestQueryDebuger implementation)"));
                Assert.That(facade, Does.Contain("public static bool SendIsVisibleResult(global::VisualBridge.Diagnostics.VisualBridgeDebugRequest request, bool result)"));
                Assert.That(facade, Does.Contain("public static bool SendResetResult(global::VisualBridge.Diagnostics.VisualBridgeDebugRequest request)"));

                var dispatcher = File.ReadAllText(
                    Path.Combine(fixture.GeneratedDirectoryFullPath, "VisualBridgeGeneratedVisualBridgeTestQueryDebugerDispatcher.g.cs"));
                // 附录 B.2.3：Dispatcher 用 7 参构造直接携带 category / iface / method，运行期不再反射补齐归属。
                Assert.That(dispatcher, Does.Contain(
                    "return DispatchIsVisible(CreateRequest(instanceId, instanceSlot, methodId, requestSeq, \"IsVisible\"), parameters);"),
                    "Dispatcher 必须按方法号构造携带归属的请求句柄（附录 B.2.3）");
                Assert.That(dispatcher, Does.Contain(
                    "return new global::VisualBridge.Diagnostics.VisualBridgeDebugRequest(instanceId, instanceSlot, methodId, requestSeq,"));
                Assert.That(dispatcher, Does.Contain("\"query\", \"IVisualBridgeTestQueryDebuger\", method);"));
                Assert.That(dispatcher, Does.Contain("RegisterRequestHandler("));
                Assert.That(dispatcher, Does.Contain("VisualBridgeDebugRequestDispatcher(Dispatch)"),
                    "运行期用统一委托直接调用，避免 DynamicInvoke");
                Assert.That(dispatcher, Does.Contain("VisualBridgeDebugRequestParameterDecoder(TryGetParameters)"),
                    "Dispatcher 应提供解码参数表");
                Assert.That(dispatcher, Does.Contain("public static bool TryGetMethodName(ushort methodId, out string methodName)"),
                    "TryGetMethodName 是附录 B.5 登记的诊断产物，必须存在且不再被运行期依赖");
                Assert.That(dispatcher, Does.Not.Contain("DispatchHandler"),
                    "不应再生成各接口自带的委托类型（D4 改为运行期委托）");
                Assert.That(dispatcher, Does.Contain("RejectRequest(request, \"handler-exception: \""));
                Assert.That(dispatcher, Does.Contain("case 10:"), "方法号应从 10 起");
            }
        }

        [Test]
        public void TypeScriptProductMatchesContractOptionality()
        {
            using (var fixture = new GeneratorFixture())
            {
                fixture.Generate(new[] { typeof(IVisualBridgeTestEventDebuger) });
                var ts = File.ReadAllText(Path.Combine(fixture.GeneratedDirectoryFullPath, "graph.g.ts"));
                Assert.That(ts, Does.Contain("export const debugCategory = \"graph\" as const;"));
                Assert.That(ts, Does.Contain("label?: string;"), "有默认值的参数在 TS 里应是可选的");
                Assert.That(ts, Does.Contain("nodeId: number;"), "无默认值的参数在 TS 里是必填的");
                Assert.That(ts, Does.Contain("\"NodeStarted\": "), "TS 应带方法号常量");
            }
        }

        [Test]
        public void SystemMethodNumbersAndGlobalArtifactsAreEmitted()
        {
            using (var fixture = new GeneratorFixture())
            {
                var result = fixture.Generate(DefaultInterfaces);
                var global = File.ReadAllText(fixture.ArtifactPath("VisualBridgeDebugContract.g.cs"));
                Assert.That(global, Does.Contain("public static class VisualBridgeDebugContract"));
                Assert.That(global, Does.Contain("public const string Hash = \"" + result.ContractHash + "\";"));
                Assert.That(global, Does.Contain("public enum VisualBridgeDebugSystemMethod : ushort"));
                Assert.That(global, Does.Contain("Create = 1,"));
                Assert.That(global, Does.Contain("Finish = 2,"));

                var contracts = JObject.Parse(File.ReadAllText(fixture.ArtifactPath("debug-contracts.json")));
                Assert.That((int)contracts["manifest"]["schemaVersion"], Is.EqualTo(2), "manifest.schemaVersion = 2");
                Assert.That(contracts["contractHash"].Value<string>(), Is.EqualTo(result.ContractHash));
                Assert.That(contracts["categories"].Children<JObject>().Count(), Is.EqualTo(3));
                Assert.That(contracts["categories"].Children<JObject>().SelectMany(value => value["interfaces"].Children<JObject>())
                    .SelectMany(value => value["methods"].Children<JObject>())
                    .All(value => (int)value["id"] >= 10), Is.True, "业务方法号必须从 10 起");
                Assert.That(contracts["enums"].Children<JObject>().Single()["underlyingType"].Value<string>(), Is.EqualTo("int"),
                    "枚举底层类型要写进契约");

                Assert.That(File.Exists(fixture.ArtifactPath("debug-ids.json")), Is.True);
                Assert.That(File.Exists(fixture.ArtifactPath("debug-contracts.json")), Is.True);
                Assert.That(Directory.GetFiles(fixture.Root, "debug-contracts.json", SearchOption.AllDirectories).Length,
                    Is.EqualTo(1), "全局产物只出现在 ArtifactsRoot");
            }
        }

        [Test]
        public void MissingInstanceParameterFailsWithVbdbg012()
        {
            using (var fixture = new GeneratorFixture())
            {
                Assert.That(fixture.ExpectError(new[] { typeof(IVisualBridgeTestBadInstanceDebuger) }), Is.EqualTo("VBDBG012"));
                Assert.That(Directory.GetFiles(fixture.GeneratedDirectoryFullPath).Length, Is.EqualTo(0),
                    "失败不应产生半份产物");
            }
        }

        [Test]
        public void MissingGeneratedDirectoryFailsWithVbdbg013()
        {
            using (var fixture = new GeneratorFixture())
            {
                Assert.That(fixture.ExpectError(new[] { typeof(IVisualBridgeTestMissingDirectoryDebuger) }), Is.EqualTo("VBDBG013"));
            }
        }

        [Test]
        public void UncoveredGeneratedDirectoryFailsWithVbdbg011AndWritesNothing()
        {
            using (var fixture = new GeneratorFixture())
            {
                Assert.That(fixture.ExpectError(new[] { typeof(IVisualBridgeTestOutsideDebuger) }), Is.EqualTo("VBDBG011"));
                Assert.That(Directory.Exists(Path.Combine(fixture.Root, "Generated")), Is.False, "VBDBG011 不应创建目录");
                Assert.That(fixture.ReadAllArtifactFiles(), Is.Empty);

                Assert.That(fixture.ExpectError(new[] { typeof(IVisualBridgeTestEventDebuger) }, "Generated/Artifacts"),
                    Is.EqualTo("VBDBG011"), "ArtifactsRoot 未被覆盖时应 VBDBG011");

                // P2-8：工程根（"."）不是合法目标，不能产出以 "/" 开头、可能写到工程外的路径。
                Assert.That(fixture.ExpectError(new[] { typeof(IVisualBridgeTestRootDirectoryDebuger) }), Is.EqualTo("VBDBG011"));
                Assert.That(fixture.ExpectError(new[] { typeof(IVisualBridgeTestEventDebuger) }, "."),
                    Is.EqualTo("debug.artifactsRootInvalid"));
            }
        }

        [Test]
        public void AsmdefCoveredPackageDirectoryIsAcceptedAndAssetsUsesPredefinedAssembly()
        {
            using (var fixture = new GeneratorFixture())
            {
                // Assets 之外的目录必须有 asmdef 祖先（附录 B.5）；Assets 下的预定义程序集放行由其余用例覆盖。
                Assert.That(fixture.Generate(new[] { typeof(IVisualBridgeTestPackageDebuger) }).ContractHash.Length, Is.EqualTo(16));
                Assert.That(File.Exists(Path.Combine(
                    fixture.Root,
                    VisualBridgeDebugGeneratorTestPaths.PackageGeneratedDirectory.Replace('/', Path.DirectorySeparatorChar),
                    "PackageCategory.g.cs")), Is.True, "被 asmdef 覆盖的包目录应接受");
            }
        }

        [Test]
        public void DuplicateMethodNameInSameCategoryFailsWithVbdbg014()
        {
            using (var fixture = new GeneratorFixture())
            {
                Assert.That(fixture.ExpectError(new[]
                {
                    typeof(IVisualBridgeTestAlphaDebuger),
                    typeof(IVisualBridgeTestDuplicateDebuger),
                }), Is.EqualTo("VBDBG014"));
            }
        }

        [Test]
        public void CategoryWithDifferentDirectoriesFails()
        {
            using (var fixture = new GeneratorFixture())
            {
                Assert.That(fixture.ExpectError(new[]
                {
                    typeof(IVisualBridgeTestEventDebuger),
                    typeof(IVisualBridgeTestGraphOtherDirectoryDebuger),
                }), Is.EqualTo("debug.categoryDirectoryMismatch"));
            }
        }

        [Test]
        public void UnsupportedInterfaceShapesAreRejected()
        {
            using (var fixture = new GeneratorFixture())
            {
                Assert.That(fixture.ExpectError(new[] { typeof(IVisualBridgeTestGenericMethodDebuger) }),
                    Is.EqualTo("debug.genericMethodUnsupported"));
                Assert.That(fixture.ExpectError(new[] { typeof(IVisualBridgeTestInheritedDebuger) }),
                    Is.EqualTo("debug.inheritedInterfaceUnsupported"));
                Assert.That(fixture.ExpectError(new[] { typeof(IVisualBridgeTestInternalDebuger) }),
                    Is.EqualTo("debug.interfaceNotVisible"));
            }
        }

        [Test]
        public void BatchExitCodeMapsDriftToTwo()
        {
            var changed = Output(changed: true);
            var clean = Output(changed: false);

            Assert.That(VisualBridgeDebugGeneratorBatch.SuccessExitCode, Is.EqualTo(0));
            Assert.That(VisualBridgeDebugGeneratorBatch.FailureExitCode, Is.EqualTo(1), "失败路径（异常）固定 1");
            Assert.That(VisualBridgeDebugGeneratorBatch.DriftExitCode, Is.EqualTo(2));
            Assert.That(VisualBridgeDebugGeneratorBatch.ExitCode(
                VisualBridgeDebugGenerateMode.Generate, Result(VisualBridgeDebugGenerateMode.Generate, changed)), Is.EqualTo(0),
                "Generate 写出产物不算 drift");
            Assert.That(VisualBridgeDebugGeneratorBatch.ExitCode(
                VisualBridgeDebugGenerateMode.Check, Result(VisualBridgeDebugGenerateMode.Check, clean)), Is.EqualTo(0));
            Assert.That(VisualBridgeDebugGeneratorBatch.ExitCode(
                VisualBridgeDebugGenerateMode.Check, Result(VisualBridgeDebugGenerateMode.Check, changed)), Is.EqualTo(2));

            var stale = Result(VisualBridgeDebugGenerateMode.Check, clean, "C:/stale.g.cs");
            Assert.That(VisualBridgeDebugGeneratorBatch.ExitCode(VisualBridgeDebugGenerateMode.Check, stale), Is.EqualTo(2),
                "只剩陈旧产物时 Check 也必须 2");
        }

        [Test]
        public void ConfigDefaultsCanBeConfigured()
        {
            var config = UnityEngine.ScriptableObject.CreateInstance<VisualBridgeDebugConfig>();
            Assert.That(config.ArtifactsRoot, Is.EqualTo(VisualBridgeDebugGeneratorSettings.DefaultArtifactsRoot));
            Assert.That(config.GeneratedDirectory, Is.EqualTo(VisualBridgeDebugGeneratorSettings.DefaultGeneratedDirectory));

            config.Configure("Assets/Custom/Artifacts", "Assets/Custom/Generated");
            Assert.That(config.ArtifactsRoot, Is.EqualTo("Assets/Custom/Artifacts"));
            Assert.That(config.GeneratedDirectory, Is.EqualTo("Assets/Custom/Generated"));

            config.Configure("  ", null);
            Assert.That(config.ArtifactsRoot, Is.EqualTo(VisualBridgeDebugGeneratorSettings.DefaultArtifactsRoot));
            Assert.That(config.GeneratedDirectory, Is.EqualTo(VisualBridgeDebugGeneratorSettings.DefaultGeneratedDirectory));

            Assert.That(VisualBridgeDebugConfig.LoadOrDefault(), Is.Not.Null);
        }

        [Test]
        public void DiscoverySkipsTestAssemblies()
        {
            var discovered = VisualBridgeDebugGenerator.DiscoverInterfaces();
            Assert.That(discovered.Any(type => type.Assembly == typeof(IVisualBridgeTestEventDebuger).Assembly), Is.False,
                "测试程序集不参与批量生成发现，避免夹具污染");
        }

        private static string HashOf(VisualBridgeDebugDefinitionModel definition)
        {
            return VisualBridgeDebugContractHash.Compute(definition);
        }

        private static KeyValuePair<string, long> Member(string name, long value)
        {
            return new KeyValuePair<string, long>(name, value);
        }

        private static VisualBridgeDebugCompileOutput Output(bool changed)
        {
            return new VisualBridgeDebugCompileOutput(
                "C:/out.g.cs", "expectedhash", changed ? "previoushash" : "expectedhash", changed);
        }

        private static VisualBridgeDebugCompileResult Result(
            VisualBridgeDebugGenerateMode mode,
            params VisualBridgeDebugCompileOutput[] outputs)
        {
            return new VisualBridgeDebugCompileResult(mode, outputs, Array.Empty<string>(), "0123456789abcdef");
        }

        private static VisualBridgeDebugCompileResult Result(
            VisualBridgeDebugGenerateMode mode,
            VisualBridgeDebugCompileOutput output,
            string stale)
        {
            return new VisualBridgeDebugCompileResult(mode, new[] { output }, new[] { stale }, "0123456789abcdef");
        }

        private static string LiteralOf<T>(T value, VisualBridgeDebugValueKind kind, string contractType)
        {
            var parameter = new VisualBridgeDebugParameterModel(
                "value",
                typeof(T),
                contractType,
                1,
                false,
                false,
                true,
                kind,
                contractType,
                "number",
                value,
                true);
            return VisualBridgeDebugTypeMapping.CSharpDefaultLiteral(parameter);
        }

        /// <summary>只造一个「一个分类、一个接口、一个方法、一个参数、一个枚举」的模型，用于逐字段隔离 hash 敏感度。</summary>
        private static VisualBridgeDebugDefinitionModel BuildHashDefinition(
            string categoryName = "hash",
            string interfaceFullName = "VisualBridge.Editor.Tests.IProbeDebuger",
            string className = "ProbeDebuger",
            string generatedNamespace = "VisualBridge.Editor.Tests",
            string generatedDirectory = VisualBridgeDebugGeneratorTestPaths.GeneratedDirectory,
            VisualBridgeDebugerKind kind = VisualBridgeDebugerKind.Event,
            string methodName = "Probe",
            ushort methodId = 42,
            string resultContractType = "bool",
            string parameterName = "value",
            Type parameterType = null,
            string contractType = "int",
            string castType = "int",
            VisualBridgeDebugValueKind valueKind = VisualBridgeDebugValueKind.Int,
            ushort tag = 1,
            bool instance = false,
            bool optional = false,
            string enumFullName = "VisualBridge.Editor.Tests.VisualBridgeTestNodeKind",
            string enumUnderlying = "int",
            IReadOnlyList<KeyValuePair<string, long>> enumMembers = null)
        {
            var parameter = new VisualBridgeDebugParameterModel(
                parameterName,
                parameterType ?? typeof(int),
                contractType,
                tag,
                instance,
                false,
                optional,
                valueKind,
                castType,
                "number",
                optional ? (object)0 : null,
                optional);
            var method = new VisualBridgeDebugMethodModel(
                methodName,
                new[] { parameter },
                instance ? parameter : null,
                null,
                null,
                resultContractType,
                false);
            method.MethodId = methodId;
            var contractInterface = new VisualBridgeDebugInterfaceModel(
                typeof(IVisualBridgeTestEventDebuger),
                interfaceFullName,
                categoryName,
                kind,
                generatedDirectory,
                className,
                generatedNamespace,
                new[] { method });
            var fileBase = char.ToUpperInvariant(categoryName[0]) + categoryName.Substring(1);
            var category = new VisualBridgeDebugCategoryModel(
                categoryName,
                fileBase + "Protocol",
                fileBase,
                generatedDirectory,
                new[] { contractInterface });
            var contractEnum = new VisualBridgeDebugEnumModel(
                enumFullName,
                enumUnderlying,
                enumFullName.Replace('.', '_'),
                enumMembers ?? new[] { Member("None", 0L), Member("Started", 1L) });
            return new VisualBridgeDebugDefinitionModel(new[] { category }, new[] { contractEnum });
        }

        private static int? MethodId(JObject ids, string category, string name)
        {
            var entry = ids["categories"][category] as JObject;
            if (entry == null)
            {
                return null;
            }

            if (string.Equals(name, "nextMethodId", StringComparison.Ordinal))
            {
                var next = entry["nextMethodId"];
                return next == null ? (int?)null : next.Value<int>();
            }

            var methods = entry["methods"] as JObject;
            var token = methods == null ? null : methods[name];
            return token == null ? (int?)null : token.Value<int>();
        }

        private static string[] SnapshotTree(string root)
        {
            return Directory.GetFileSystemEntries(root, "*", SearchOption.AllDirectories)
                .OrderBy(path => path, StringComparer.Ordinal)
                .ToArray();
        }

        /// <summary>每个用例一套假 Unity 工程根 + 便捷调用；用完删除，不触碰真实工程。</summary>
        private sealed class GeneratorFixture : IDisposable
        {
            public GeneratorFixture()
            {
                Root = Path.Combine(Path.GetTempPath(), "VisualBridgeDebugGeneratorTests", Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(GeneratedDirectoryFullPath);
                Directory.CreateDirectory(ArtifactsDirectory);
                Directory.CreateDirectory(Path.Combine(Root, "ProjectSettings"));
                var packageDirectory = Path.Combine(
                    Root,
                    VisualBridgeDebugGeneratorTestPaths.PackageDirectory.Replace('/', Path.DirectorySeparatorChar));
                Directory.CreateDirectory(packageDirectory);
                File.WriteAllText(
                    Path.Combine(packageDirectory, "Probe.asmdef"),
                    "{\n  \"name\": \"Probe.Contracts\",\n  \"references\": [\"VisualBridge.Debug\"]\n}\n",
                    new UTF8Encoding(false));
            }

            public string Root { get; }

            public string GeneratedDirectoryFullPath => Path.Combine(
                Root,
                VisualBridgeDebugGeneratorTestPaths.GeneratedDirectory.Replace('/', Path.DirectorySeparatorChar));

            public string ArtifactsDirectory => Path.Combine(
                Root,
                VisualBridgeDebugGeneratorTestPaths.ArtifactsRoot.Replace('/', Path.DirectorySeparatorChar));

            public VisualBridgeDebugCompileResult Generate(IReadOnlyList<Type> interfaces)
            {
                return Compile(interfaces, VisualBridgeDebugGeneratorTestPaths.ArtifactsRoot,
                    VisualBridgeDebugGenerateMode.Generate);
            }

            public VisualBridgeDebugCompileResult GenerateWithArtifactsRoot(string artifactsRoot, IReadOnlyList<Type> interfaces)
            {
                return Compile(interfaces, artifactsRoot, VisualBridgeDebugGenerateMode.Generate);
            }

            public VisualBridgeDebugCompileResult Check(IReadOnlyList<Type> interfaces)
            {
                return Compile(interfaces, VisualBridgeDebugGeneratorTestPaths.ArtifactsRoot,
                    VisualBridgeDebugGenerateMode.Check);
            }

            public VisualBridgeDebugCompileResult CheckWithArtifactsRoot(string artifactsRoot, IReadOnlyList<Type> interfaces)
            {
                return Compile(interfaces, artifactsRoot, VisualBridgeDebugGenerateMode.Check);
            }

            public string ExpectError(IReadOnlyList<Type> interfaces, string artifactsRoot = null)
            {
                try
                {
                    Compile(interfaces, artifactsRoot ?? VisualBridgeDebugGeneratorTestPaths.ArtifactsRoot,
                        VisualBridgeDebugGenerateMode.Generate);
                    return null;
                }
                catch (VisualBridgeDebugGeneratorException exception)
                {
                    return exception.Code;
                }
            }

            public string ArtifactPath(string fileName)
            {
                return Path.Combine(ArtifactsDirectory, fileName);
            }

            public JObject ReadIds()
            {
                return JObject.Parse(File.ReadAllText(ArtifactPath("debug-ids.json")));
            }

            public string[] ReadAllArtifactFiles()
            {
                return Directory.Exists(ArtifactsDirectory)
                    ? Directory.GetFiles(ArtifactsDirectory)
                    : Array.Empty<string>();
            }

            public void Dispose()
            {
                if (Directory.Exists(Root))
                {
                    Directory.Delete(Root, true);
                }
            }

            private VisualBridgeDebugCompileResult Compile(
                IReadOnlyList<Type> interfaces,
                string artifactsRoot,
                VisualBridgeDebugGenerateMode mode)
            {
                var settings = new VisualBridgeDebugGeneratorSettings(Root)
                {
                    ArtifactsRoot = artifactsRoot,
                    Interfaces = interfaces,
                };
                return VisualBridgeDebugGenerator.Compile(settings, mode);
            }
        }
    }
}
