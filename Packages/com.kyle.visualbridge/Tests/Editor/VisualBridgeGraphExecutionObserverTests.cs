using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using NUnit.Framework;
using VisualBridge.Runtime;

namespace VisualBridge.Editor.Tests
{
    /// <summary>
    /// G1c 的第一段接线：采集门面 → 观察者（<see cref="IVisualBridgeGraphExecutionObserver"/>）。
    /// 这里只验证「缝」本身——每条事实都回调一次、注册时补发运行中实例、停追踪/换观察者会 Reset。
    /// 观察者之后的事情（调试契约事件序列）在工程侧的 VisualBridge.GraphDebug.Tests 里验。
    /// </summary>
    public sealed class VisualBridgeGraphExecutionObserverTests
    {
        [SetUp]
        public void SetUp()
        {
            VisualBridgeGraphExecutionCapture.SetObserver(null);
            VisualBridgeGraphExecutionCapture.SetTracking(false);
        }

        [TearDown]
        public void TearDown()
        {
            VisualBridgeGraphExecutionCapture.SetObserver(null);
            VisualBridgeGraphExecutionCapture.SetTracking(false);
        }

        [Test]
        public void ObserverReceivesEveryFact()
        {
            var observer = new RecordingObserver();
            VisualBridgeGraphExecutionCapture.SetObserver(observer);
            VisualBridgeGraphExecutionCapture.SetTracking(true);

            Assert.That(VisualBridgeGraphExecutionCapture.OnInstanceStarted(
                "logicGraph", "encounter", "Encounter", "hero", out var executionId), Is.True);
            VisualBridgeGraphExecutionCapture.OnNodeStart(executionId, "step_a", 1);
            VisualBridgeGraphExecutionCapture.OnNodeOutput(executionId, "step_a", 2, 1);
            VisualBridgeGraphExecutionCapture.OnDataNode(executionId, "data_b", 2);
            VisualBridgeGraphExecutionCapture.OnEdgeValueChanged(executionId, "data_b", 1, "42", 2);
            VisualBridgeGraphExecutionCapture.OnInstanceStopped(executionId);

            Assert.That(observer.Kinds, Is.EqualTo(new[]
            {
                "instanceStarted",
                "nodeStart",
                "nodeOutput",
                "dataNode",
                "edgeValueChanged",
                "instanceStopped",
            }));
            Assert.That(observer.Started.Single().ExecutionId, Is.EqualTo(executionId));
            Assert.That(observer.Started.Single().DocumentTypeId, Is.EqualTo("logicGraph"));
            Assert.That(observer.Started.Single().DocumentId, Is.EqualTo("encounter"));
            Assert.That(observer.Started.Single().GraphName, Is.EqualTo("Encounter"));
            Assert.That(observer.Started.Single().DebugKey, Is.EqualTo("hero"));
            var edge = observer.Facts.Last(fact => fact.Kind == "edgeValueChanged");
            Assert.That(edge.NodeId, Is.EqualTo("data_b"));
            Assert.That(edge.OutputIndex, Is.EqualTo(1));
            Assert.That(edge.Value, Is.EqualTo("42"));
        }

        [Test]
        public void ObserverReplaysLiveInstancesWhenInstalledMidRun()
        {
            VisualBridgeGraphExecutionCapture.SetTracking(true);
            VisualBridgeGraphExecutionCapture.OnInstanceStarted("logicGraph", "encounter", "Encounter", "b", out _);
            VisualBridgeGraphExecutionCapture.OnInstanceStarted("logicGraph", "encounter", "Encounter", "a", out _);

            var observer = new RecordingObserver();
            VisualBridgeGraphExecutionCapture.SetObserver(observer);

            // 补发按 executionId 排序，注册时机不影响顺序确定性。
            Assert.That(observer.Started.Select(started => started.ExecutionId), Is.EqualTo(new[] { "exec-1", "exec-2" }));
        }

        /// <summary>
        /// 表 C（G1c2 起**自动**）：**所有**会产生节点事实的入口，其停止事实的帧号必须等于该事实的帧号。
        ///
        /// 这张表不再是手抄的 4 行：<see cref="DiscoverNodeFactBranches"/> 反射枚举
        /// <see cref="VisualBridgeGraphExecutionCapture"/> 的全部公开静态入口，凡是"首参 executionId、
        /// 末参 int frameIndex"的都当成节点事实逐个驱动。新增第五条事实分支（例：
        /// <c>OnNodeFaulted(executionId, nodeId, frameIndex)</c>）会自动多跑一遍；新分支签名不合约定时
        /// 本用例**明确失败**并要求显式处理，而不是像手抄表那样悄悄漏掉一行。
        ///
        /// <c>CurrentNodeId</c> 的四处写入当前无读者，**有意不做断言**——不给死状态上锁，不是遗漏。
        /// </summary>
        [Test]
        public void EveryNodeFactFeedsTheStoppedFrame()
        {
            var branches = DiscoverNodeFactBranches();
            Assert.That(branches.Count, Is.GreaterThanOrEqualTo(4),
                "节点事实入口至少要能枚举到 4 条（nodeStart/nodeOutput/dataNode/edgeValueChanged）");

            // 帧号各不相同且都不为 0：0 是"没设置过帧"的占位值，用它当期望值等于没断言。
            var frames = Enumerable.Range(11, branches.Count).ToArray();
            for (int index = 0; index < branches.Count; index++)
            {
                var branch = branches[index];
                int frame = frames[index];
                var observer = new RecordingObserver();
                VisualBridgeGraphExecutionCapture.SetObserver(observer);
                VisualBridgeGraphExecutionCapture.SetTracking(true);
                VisualBridgeGraphExecutionCapture.OnInstanceStarted(
                    "logicGraph", "encounter", "Encounter", "hero", out var executionId);

                branch.Drive(executionId, frame);
                VisualBridgeGraphExecutionCapture.OnInstanceStopped(executionId);

                var stopped = observer.Facts.Last(fact => fact.Kind == "instanceStopped");
                Assert.That(stopped.ExecutionId, Is.EqualTo(executionId));
                Assert.That(stopped.FrameIndex, Is.EqualTo(frame),
                    branch.Name + "：停止事实必须带该节点事实的帧号。");

                VisualBridgeGraphExecutionCapture.SetObserver(null);
                VisualBridgeGraphExecutionCapture.SetTracking(false);
            }
        }

        /// <summary>
        /// 反射枚举"节点事实"入口（G1c2）：公开静态、非属性访问器、且不在下面的显式排除名单里。
        ///
        /// 默认**必须**是节点事实，而不是"名字像节点事实才算"——后者会让一条命名不同的新分支悄悄漏测。
        /// 签名不合约定（首参不是 <c>string executionId</c>、末参不是 <c>int frameIndex</c>、出现
        /// string/int 之外的参数）时直接失败：那种分支需要在表里显式加一行并说明如何驱动。
        /// </summary>
        private static List<NodeFactBranch> DiscoverNodeFactBranches()
        {
            // 不是节点事实的公开静态入口：生命周期（实例起止）与观察者安装。`SetTracking` 是
            // internal static，本来就不在反射范围内（Unity 测试程序集用 InternalsVisibleTo 能直接调用，
            // 但不属于"公开入口"）。新增成员时必须在这里明确分类——是节点事实就交给反射自动覆盖，
            // 不是就登记进来并写明理由；名单与代码必须双向相等（见下面的反向守卫）。
            var notNodeFacts = new HashSet<string>(StringComparer.Ordinal)
            {
                "SetObserver",
                "OnInstanceStarted",
                "OnInstanceStopped",
            };

            var publicStatics = typeof(VisualBridgeGraphExecutionCapture)
                .GetMethods(BindingFlags.Public | BindingFlags.Static | BindingFlags.DeclaredOnly)
                .Where(method => !method.IsSpecialName)
                .Select(method => method.Name)
                .ToArray();
            // 反向守卫：排除名单里写了代码里不存在的名字 ⇒ 红（防止名单腐化成"什么都排除"，
            // 那样新入口会被静默跳过而不是走下面的签名断言）。
            Assert.That(notNodeFacts.Except(publicStatics), Is.Empty,
                "节点事实排除名单里有采集门面中不存在的公开静态成员（名单与代码漂移）。");

            var branches = new List<NodeFactBranch>();
            foreach (var method in typeof(VisualBridgeGraphExecutionCapture)
                .GetMethods(BindingFlags.Public | BindingFlags.Static | BindingFlags.DeclaredOnly)
                .OrderBy(method => method.Name, StringComparer.Ordinal))
            {
                if (method.IsSpecialName || notNodeFacts.Contains(method.Name))
                {
                    continue;
                }

                var parameters = method.GetParameters();
                Assert.That(parameters.Length, Is.GreaterThanOrEqualTo(2),
                    method.Name + "：节点事实至少要有 executionId 与 frameIndex 两个参数。");
                Assert.That(parameters[0].ParameterType, Is.EqualTo(typeof(string)),
                    method.Name + "：首参必须是 string executionId。");
                Assert.That(parameters[0].Name, Is.EqualTo("executionId"),
                    method.Name + "：首参必须叫 executionId（反射按名字填实参）。");
                var last = parameters[parameters.Length - 1];
                Assert.That(last.ParameterType, Is.EqualTo(typeof(int)),
                    method.Name + "：末参必须是 int frameIndex。");
                Assert.That(last.Name, Is.EqualTo("frameIndex"),
                    method.Name + "：末参必须叫 frameIndex（停止事实取它的值）。");
                foreach (var parameter in parameters)
                {
                    Assert.That(
                        parameter.ParameterType == typeof(string) || parameter.ParameterType == typeof(int),
                        Is.True,
                        method.Name + "：反射驱动只构造 string/int 实参，参数 '" + parameter.Name
                        + "' 是 " + parameter.ParameterType.Name + "——请在表 C 里显式加一行并说明如何驱动。");
                }

                branches.Add(new NodeFactBranch(method));
            }

            return branches;
        }

        /// <summary>一条节点事实入口：按参数类型构造实参（string → 哨兵文本，末位 int → 帧号，其余 int → 1）。</summary>
        private sealed class NodeFactBranch
        {
            private readonly MethodInfo method;
            private readonly ParameterInfo[] parameters;

            internal NodeFactBranch(MethodInfo method)
            {
                this.method = method;
                parameters = method.GetParameters();
            }

            internal string Name => method.Name;

            internal void Drive(string executionId, int frame)
            {
                var arguments = new object[parameters.Length];
                for (int index = 0; index < parameters.Length; index++)
                {
                    var parameter = parameters[index];
                    if (parameter.ParameterType == typeof(string))
                    {
                        arguments[index] = index == 0
                            ? executionId
                            : parameter.Name == "value" ? "v" : "step_a";
                    }
                    else
                    {
                        arguments[index] = parameter.Name == "frameIndex" ? frame : 1;
                    }
                }

                method.Invoke(null, arguments);
            }
        }

        [Test]
        public void StoppingTrackingResetsTheObserver()
        {
            var observer = new RecordingObserver();
            VisualBridgeGraphExecutionCapture.SetObserver(observer);
            VisualBridgeGraphExecutionCapture.SetTracking(true);
            VisualBridgeGraphExecutionCapture.OnInstanceStarted("logicGraph", "encounter", "Encounter", "hero", out var executionId);

            VisualBridgeGraphExecutionCapture.SetTracking(false);
            Assert.That(observer.Resets, Is.EqualTo(1));

            var before = observer.Kinds.Count;
            VisualBridgeGraphExecutionCapture.OnNodeStart(executionId, "step_a", 1);
            Assert.That(observer.Kinds.Count, Is.EqualTo(before), "停追踪后不再回调。");
        }

        [Test]
        public void ReplacingTheObserverResetsThePreviousOne()
        {
            var first = new RecordingObserver();
            var second = new RecordingObserver();
            VisualBridgeGraphExecutionCapture.SetObserver(first);
            VisualBridgeGraphExecutionCapture.SetObserver(second);

            Assert.That(first.Resets, Is.EqualTo(1));
            Assert.That(second.Resets, Is.EqualTo(0));
        }

        private sealed class RecordingObserver : IVisualBridgeGraphExecutionObserver
        {
            public List<string> Kinds { get; } = new List<string>();

            public List<StartedFact> Started { get; } = new List<StartedFact>();

            public List<Fact> Facts { get; } = new List<Fact>();

            public int Resets { get; private set; }

            public void OnInstanceStarted(
                string executionId,
                string documentTypeId,
                string documentId,
                string graphName,
                string debugKey,
                int frameIndex)
            {
                Kinds.Add("instanceStarted");
                Started.Add(new StartedFact(executionId, documentTypeId, documentId, graphName, debugKey, frameIndex));
                Facts.Add(new Fact("instanceStarted", executionId, null, null, null, frameIndex));
            }

            public void OnInstanceStopped(string executionId, int frameIndex)
            {
                Kinds.Add("instanceStopped");
                Facts.Add(new Fact("instanceStopped", executionId, null, null, null, frameIndex));
            }

            public void OnNodeStarted(string executionId, string nodeId, int frameIndex)
            {
                Kinds.Add("nodeStart");
                Facts.Add(new Fact("nodeStart", executionId, nodeId, null, null, frameIndex));
            }

            public void OnNodeOutput(string executionId, string nodeId, int outputIndex, int frameIndex)
            {
                Kinds.Add("nodeOutput");
                Facts.Add(new Fact("nodeOutput", executionId, nodeId, outputIndex, null, frameIndex));
            }

            public void OnDataNode(string executionId, string nodeId, int frameIndex)
            {
                Kinds.Add("dataNode");
                Facts.Add(new Fact("dataNode", executionId, nodeId, null, null, frameIndex));
            }

            public void OnEdgeValueChanged(string executionId, string nodeId, int outputIndex, string value, int frameIndex)
            {
                Kinds.Add("edgeValueChanged");
                Facts.Add(new Fact("edgeValueChanged", executionId, nodeId, outputIndex, value, frameIndex));
            }

            public void Reset()
            {
                Resets++;
            }
        }

        private sealed class StartedFact
        {
            public StartedFact(
                string executionId,
                string documentTypeId,
                string documentId,
                string graphName,
                string debugKey,
                int frameIndex)
            {
                ExecutionId = executionId;
                DocumentTypeId = documentTypeId;
                DocumentId = documentId;
                GraphName = graphName;
                DebugKey = debugKey;
                FrameIndex = frameIndex;
            }

            public string ExecutionId { get; }

            public string DocumentTypeId { get; }

            public string DocumentId { get; }

            public string GraphName { get; }

            public string DebugKey { get; }

            public int FrameIndex { get; }
        }

        private sealed class Fact
        {
            public Fact(string kind, string executionId, string nodeId, int? outputIndex, string value, int frameIndex)
            {
                Kind = kind;
                ExecutionId = executionId;
                NodeId = nodeId;
                OutputIndex = outputIndex;
                Value = value;
                FrameIndex = frameIndex;
            }

            public string Kind { get; }

            public string ExecutionId { get; }

            public string NodeId { get; }

            public int? OutputIndex { get; }

            public string Value { get; }

            public int FrameIndex { get; }
        }
    }
}
