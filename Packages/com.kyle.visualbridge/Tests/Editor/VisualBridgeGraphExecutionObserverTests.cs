using System;
using System.Collections.Generic;
using System.Linq;
using NUnit.Framework;
using VisualBridge.Runtime;

namespace VisualBridge.Editor.Tests
{
    /// <summary>
    /// G1c 的第一段接线：采集门面 → 观察者（<see cref="IVisualBridgeGraphExecutionObserver"/>）。
    /// 这里只验证「缝」本身——每条事实都回调一次、订阅状态与观察者互不影响（旧 graphExecution 缓冲
    /// 的输出逐字不变）、订阅时补发运行中实例、停追踪/换观察者会 Reset。
    /// 观察者之后的事情（调试契约事件序列）在工程侧的 VisualBridge.GraphDebug.Tests 里验。
    /// </summary>
    public sealed class VisualBridgeGraphExecutionObserverTests
    {
        [SetUp]
        public void SetUp()
        {
            VisualBridgeGraphExecutionCapture.SetObserver(null);
            VisualBridgeGraphExecutionCapture.SetSubscribed(false);
            VisualBridgeGraphExecutionCapture.SetTracking(false);
        }

        [TearDown]
        public void TearDown()
        {
            VisualBridgeGraphExecutionCapture.SetObserver(null);
            VisualBridgeGraphExecutionCapture.SetSubscribed(false);
            VisualBridgeGraphExecutionCapture.SetTracking(false);
        }

        [Test]
        public void ObserverReceivesEveryFactWhileTheLegacyBufferStaysEmpty()
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

            // 旧路径：没有订阅者就一条都不进缓冲（观察者不改变这个语义）。
            var drained = new List<VisualBridgeRuntimeGraphExecutionEvent>();
            Assert.That(VisualBridgeGraphExecutionCapture.WaitAndDrain(TimeSpan.Zero, drained), Is.False);
            Assert.That(VisualBridgeGraphExecutionCapture.IsSubscribed, Is.False);
        }

        [Test]
        public void ObserverReplaysLiveInstancesWhenSubscribedMidRun()
        {
            VisualBridgeGraphExecutionCapture.SetTracking(true);
            VisualBridgeGraphExecutionCapture.OnInstanceStarted("logicGraph", "encounter", "Encounter", "b", out _);
            VisualBridgeGraphExecutionCapture.OnInstanceStarted("logicGraph", "encounter", "Encounter", "a", out _);

            var observer = new RecordingObserver();
            VisualBridgeGraphExecutionCapture.SetObserver(observer);

            // 补发按 executionId 排序，订阅时机不影响顺序确定性。
            Assert.That(observer.Started.Select(started => started.ExecutionId), Is.EqualTo(new[] { "exec-1", "exec-2" }));
        }

        [Test]
        public void LegacyStreamIsUnchangedWhenObserverIsInstalled()
        {
            var observer = new RecordingObserver();
            VisualBridgeGraphExecutionCapture.SetSubscribed(true);
            VisualBridgeGraphExecutionCapture.SetObserver(observer);
            VisualBridgeGraphExecutionCapture.SetTracking(true);
            VisualBridgeGraphExecutionCapture.OnInstanceStarted("logicGraph", "encounter", "Encounter", "hero", out var executionId);

            VisualBridgeGraphExecutionCapture.OnNodeStart(executionId, "step_a", 3);
            VisualBridgeGraphExecutionCapture.OnEdgeValueChanged(executionId, "data_b", 1, "x", 3);

            var drained = new List<VisualBridgeRuntimeGraphExecutionEvent>();
            Assert.That(VisualBridgeGraphExecutionCapture.WaitAndDrain(TimeSpan.Zero, drained), Is.True);
            Assert.That(drained.Select(item => item.Kind).ToArray(), Is.EqualTo(new[]
            {
                "instanceStarted",
                "nodeStart",
                "edgeValueChanged",
            }));
            Assert.That(drained[1].FrameIndex, Is.EqualTo(3));
            Assert.That(drained[1].NodeId, Is.EqualTo("step_a"));
            Assert.That(drained[2].OutputIndex, Is.EqualTo(1));
            Assert.That(drained[2].Value, Is.EqualTo("x"));

            // 观察者拿到的事实与旧缓冲逐条同源。
            Assert.That(observer.Kinds, Is.EqualTo(drained.Select(item => item.Kind).ToArray()));
        }

        [Test]
        public void NodeFactsChangeNothingWhenThereIsNeitherSubscriberNorObserver()
        {
            VisualBridgeGraphExecutionCapture.SetTracking(true);
            VisualBridgeGraphExecutionCapture.OnInstanceStarted("logicGraph", "encounter", "Encounter", "hero", out var executionId);

            // 没有任何接收者：保持旧的零分配快速路径——节点方法在锁外早退，连实例快照都不更新。
            VisualBridgeGraphExecutionCapture.OnNodeStart(executionId, "step_a", 1);
            var drained = new List<VisualBridgeRuntimeGraphExecutionEvent>();
            Assert.That(VisualBridgeGraphExecutionCapture.WaitAndDrain(TimeSpan.Zero, drained), Is.False);
            Assert.That(VisualBridgeGraphExecutionCapture.GetSnapshot(executionId).CurrentNodeId, Is.Null);
        }

        /// <summary>
        /// P0-2：装观察者**不得**改变旧路径的可观察输出。旧语义是"无订阅期间当前节点/帧号不更新"
        /// （Doc/UnityGraphExecutionDebug.md），观察者只吃回调参数，不能顺手把实例快照也写了。
        /// </summary>
        [Test]
        public void InstallingAnObserverKeepsTheLegacySnapshotFrozen()
        {
            var observer = new RecordingObserver();
            VisualBridgeGraphExecutionCapture.SetObserver(observer);
            VisualBridgeGraphExecutionCapture.SetTracking(true);
            VisualBridgeGraphExecutionCapture.OnInstanceStarted("logicGraph", "encounter", "Encounter", "hero", out var executionId);

            VisualBridgeGraphExecutionCapture.OnNodeStart(executionId, "step_a", 1);
            VisualBridgeGraphExecutionCapture.OnEdgeValueChanged(executionId, "step_a", 1, "v", 2);

            // 观察者照常收到事实（参数里带着 nodeId / frameIndex）……
            // 注意 SetObserver 时的补发事实也在列（instanceStarted），这里只断言这几条事实都在。
            Assert.That(observer.Kinds, Is.EqualTo(new[] { "instanceStarted", "nodeStart", "edgeValueChanged" }));
            Assert.That(observer.Facts.Last().NodeId, Is.EqualTo("step_a"));
            Assert.That(observer.Facts.Last().FrameIndex, Is.EqualTo(2));

            // ……但实例快照必须与"没有订阅者"的 HEAD 行为一致：不更新。
            var snapshot = VisualBridgeGraphExecutionCapture.GetSnapshot(executionId);
            Assert.That(snapshot.CurrentNodeId, Is.Null, "无订阅期间当前节点不更新（观察者不得改写旧路径）。");
            Assert.That(snapshot.FrameIndex, Is.EqualTo(0), "无订阅期间帧号不更新。");
        }

        /// <summary>
        /// 表 C 的类级断言：**四条**节点事实分支（nodeStart / nodeOutput / dataNode / edgeValueChanged）
        /// 在"装了观察者但没有订阅者"时都不得改写旧快照；装了订阅者时四条都必须更新。
        /// 新增一条写快照的分支时，这张表要跟着加一行。
        /// </summary>
        [Test]
        public void EveryNodeFactRespectsTheSubscribedGate()
        {
            var branches = new (string Name, Action<string> Drive)[]
            {
                ("nodeStart", id => VisualBridgeGraphExecutionCapture.OnNodeStart(id, "step_a", 5)),
                ("nodeOutput", id => VisualBridgeGraphExecutionCapture.OnNodeOutput(id, "step_a", 1, 5)),
                ("dataNode", id => VisualBridgeGraphExecutionCapture.OnDataNode(id, "step_a", 5)),
                ("edgeValueChanged", id => VisualBridgeGraphExecutionCapture.OnEdgeValueChanged(id, "step_a", 1, "v", 5)),
            };

            foreach (var branch in branches)
            {
                // ① 装观察者、无订阅者 ⇒ 快照必须保持初始值（HEAD 语义：无订阅期间不更新）。
                var observer = new RecordingObserver();
                VisualBridgeGraphExecutionCapture.SetObserver(observer);
                VisualBridgeGraphExecutionCapture.SetTracking(true);
                VisualBridgeGraphExecutionCapture.OnInstanceStarted("logicGraph", "encounter", "Encounter", "hero", out var unsubscribedId);
                branch.Drive(unsubscribedId);

                var frozen = VisualBridgeGraphExecutionCapture.GetSnapshot(unsubscribedId);
                Assert.That(frozen.CurrentNodeId, Is.Null, branch.Name + "：无订阅期间当前节点不得更新。");
                Assert.That(frozen.FrameIndex, Is.EqualTo(0), branch.Name + "：无订阅期间帧号不得更新。");
                Assert.That(observer.Kinds.Count, Is.GreaterThanOrEqualTo(2), branch.Name + "：观察者仍应收到事实。");
                VisualBridgeGraphExecutionCapture.SetObserver(null);

                // ② 有订阅者 ⇒ 快照必须更新（否则①的"不更新"可能恒真而抓不到缺陷）。
                VisualBridgeGraphExecutionCapture.SetSubscribed(true);
                VisualBridgeGraphExecutionCapture.SetTracking(true);
                VisualBridgeGraphExecutionCapture.OnInstanceStarted("logicGraph", "encounter", "Encounter", "hero", out var subscribedId);
                branch.Drive(subscribedId);

                var tracked = VisualBridgeGraphExecutionCapture.GetSnapshot(subscribedId);
                Assert.That(tracked.CurrentNodeId, Is.EqualTo("step_a"), branch.Name + "：有订阅时必须更新当前节点。");
                Assert.That(tracked.FrameIndex, Is.EqualTo(5), branch.Name + "：有订阅时必须更新帧号。");
                VisualBridgeGraphExecutionCapture.SetSubscribed(false);
            }
        }

        /// <summary>订阅者存在时旧语义照常生效（观察者不改变它）。</summary>
        [Test]
        public void SubscribedInstanceStillTracksCurrentNodeAndFrame()
        {
            VisualBridgeGraphExecutionCapture.SetObserver(new RecordingObserver());
            VisualBridgeGraphExecutionCapture.SetSubscribed(true);
            VisualBridgeGraphExecutionCapture.SetTracking(true);
            VisualBridgeGraphExecutionCapture.OnInstanceStarted("logicGraph", "encounter", "Encounter", "hero", out var executionId);

            VisualBridgeGraphExecutionCapture.OnNodeStart(executionId, "step_a", 5);

            var snapshot = VisualBridgeGraphExecutionCapture.GetSnapshot(executionId);
            Assert.That(snapshot.CurrentNodeId, Is.EqualTo("step_a"));
            Assert.That(snapshot.FrameIndex, Is.EqualTo(5));
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
