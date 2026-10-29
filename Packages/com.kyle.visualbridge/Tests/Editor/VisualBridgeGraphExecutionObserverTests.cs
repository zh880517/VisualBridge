using System;
using System.Collections.Generic;
using System.Linq;
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
        /// 观察者补发/结束只消费 <c>FrameIndex</c>：停止事实报出的帧号必须是**最后一条节点事实**的帧号，而不是 0。
        /// 这张四分支表锁的是 <c>FrameIndex</c> 那一半（经停止事实间接断言）；<c>CurrentNodeId</c> 的四处写入
        /// 当前无读者，**有意不做断言**——不给死状态上锁，不是遗漏。
        ///
        /// **新增第五条事实分支时，这个数组必须加一行**——G1c 三轮打回都栽在「分支表漏一行」上。
        /// </summary>
        [Test]
        public void EveryNodeFactFeedsTheStoppedFrame()
        {
            var branches = new (string Name, Action<string> Drive, int Frame)[]
            {
                ("nodeStart", id => VisualBridgeGraphExecutionCapture.OnNodeStart(id, "step_a", 11), 11),
                ("nodeOutput", id => VisualBridgeGraphExecutionCapture.OnNodeOutput(id, "step_a", 1, 12), 12),
                ("dataNode", id => VisualBridgeGraphExecutionCapture.OnDataNode(id, "step_a", 13), 13),
                ("edgeValueChanged", id => VisualBridgeGraphExecutionCapture.OnEdgeValueChanged(id, "step_a", 1, "v", 14), 14),
            };

            foreach (var branch in branches)
            {
                var observer = new RecordingObserver();
                VisualBridgeGraphExecutionCapture.SetObserver(observer);
                VisualBridgeGraphExecutionCapture.SetTracking(true);
                VisualBridgeGraphExecutionCapture.OnInstanceStarted(
                    "logicGraph", "encounter", "Encounter", "hero", out var executionId);

                branch.Drive(executionId);
                VisualBridgeGraphExecutionCapture.OnInstanceStopped(executionId);

                var stopped = observer.Facts.Last(fact => fact.Kind == "instanceStopped");
                Assert.That(stopped.ExecutionId, Is.EqualTo(executionId));
                Assert.That(stopped.FrameIndex, Is.EqualTo(branch.Frame),
                    branch.Name + "：停止事实必须带该节点事实的帧号。");

                VisualBridgeGraphExecutionCapture.SetObserver(null);
                VisualBridgeGraphExecutionCapture.SetTracking(false);
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
