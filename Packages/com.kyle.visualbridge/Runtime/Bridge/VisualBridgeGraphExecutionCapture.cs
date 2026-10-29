using System;
using System.Collections.Generic;
using System.Threading;

namespace VisualBridge.Runtime
{
    /// <summary>
    /// Graph 执行采集门面（架构文档 §19.4）：游戏侧引擎把自己的 debug
    /// provider 事件转发到这里，VisualBridge 分配执行实例 ID（exec-&lt;n&gt;）
    /// 并维护实例注册表。生命周期追踪（实例起止）在服务端运行期间常开，
    /// 保证实例列表无需订阅即可查询；节点级高频事件仅在存在订阅者时进
    /// 缓冲——无订阅时全部节点方法走零分配快速路径。采集与传输解耦：
    /// RuntimeBridgeServer 的执行泵线程按「满 64 条或 100ms」冲刷缓冲。
    /// Runtime 程序集禁止 Unity API；所有方法线程安全。
    ///
    /// 另有**观察者缝**（G1c）：<see cref="SetObserver"/> 注入的
    /// <see cref="IVisualBridgeGraphExecutionObserver"/> 会在每条事实处理后同步收到一次回调，
    /// 供宿主侧的 Graph 调试发射端转成 <c>category = "graph"</c> 的调试契约事件。观察者**只吃回调参数**：
    /// 它不改变旧路径的任何可观察输出（入队仍只看 <c>subscribed</c>，实例快照的当前节点/帧号也只在
    /// 订阅时更新），因此"装不装观察者"对旧 graphExecution 消费者完全不可见（G1b 才删旧路径）。
    /// </summary>
    public static class VisualBridgeGraphExecutionCapture
    {
        private const int FlushThreshold = 64;
        private const int MaxPendingEvents = 16384;

        private static readonly object Gate = new object();
        private static readonly Dictionary<string, VisualBridgeRuntimeGraphExecutionInstance> Instances =
            new Dictionary<string, VisualBridgeRuntimeGraphExecutionInstance>(StringComparer.Ordinal);
        private static readonly List<VisualBridgeRuntimeGraphExecutionEvent> Pending =
            new List<VisualBridgeRuntimeGraphExecutionEvent>();
        private static long executionCounter;
        private static volatile bool tracking;
        private static volatile bool subscribed;
        private static IVisualBridgeGraphExecutionObserver observer;

        /// <summary>服务端是否在追踪（Editor Play / Player 运行期间为 true）。</summary>
        public static bool IsTracking => tracking;

        /// <summary>当前是否存在至少一个执行事件订阅者。</summary>
        public static bool IsSubscribed => subscribed;

        /// <summary>
        /// 订阅 Graph 执行事实（G1c）：宿主侧的调试发射端用它把每条事实转成调试契约事件。
        /// Runtime 不引用调试程序集，因此观察者由宿主注入；传 null 取消订阅。
        /// 订阅时若已有运行中实例，会按 executionId 顺序补发一次实例开始事实，避免「发射端装晚了」
        /// 导致面板上永久缺实例。回调在调用 <c>On*</c> 的线程上同步执行且不在采集锁内，
        /// 被替换/清空时旧观察者会收到 <see cref="IVisualBridgeGraphExecutionObserver.Reset"/>。
        /// </summary>
        public static void SetObserver(IVisualBridgeGraphExecutionObserver value)
        {
            List<VisualBridgeRuntimeGraphExecutionInstance> replay = null;
            IVisualBridgeGraphExecutionObserver previous;
            lock (Gate)
            {
                previous = observer;
                observer = value;
                if (value != null && tracking)
                {
                    replay = new List<VisualBridgeRuntimeGraphExecutionInstance>(Instances.Count);
                    foreach (var instance in Instances.Values)
                    {
                        replay.Add(Clone(instance));
                    }

                    // Dictionary 的枚举顺序不是契约：按 executionId 排序，补发顺序确定。
                    replay.Sort((left, right) => string.CompareOrdinal(left.ExecutionId, right.ExecutionId));
                }
            }

            previous?.Reset();
            if (replay == null)
            {
                return;
            }

            foreach (var instance in replay)
            {
                value.OnInstanceStarted(
                    instance.ExecutionId,
                    instance.DocumentTypeId,
                    instance.DocumentId,
                    instance.GraphName,
                    instance.DebugKey,
                    instance.FrameIndex);
            }
        }

        /// <summary>
        /// 上报执行实例开始。documentTypeId/documentId 是 VisualBridge 图文档
        /// 身份；graphName 为游戏侧图名，debugKey 为执行者标识（可为空）。
        /// 返回 false 表示未在追踪（服务端未运行），调用方事件被忽略。
        /// </summary>
        public static bool OnInstanceStarted(
            string documentTypeId,
            string documentId,
            string graphName,
            string debugKey,
            out string executionId)
        {
            executionId = null;
            if (!tracking)
            {
                return false;
            }

            var target = Volatile.Read(ref observer);
            var resolvedDebugKey = debugKey ?? string.Empty;
            lock (Gate)
            {
                executionCounter++;
                executionId = "exec-" + executionCounter.ToString(System.Globalization.CultureInfo.InvariantCulture);
                var instance = new VisualBridgeRuntimeGraphExecutionInstance
                {
                    ExecutionId = executionId,
                    DocumentTypeId = documentTypeId,
                    DocumentId = documentId,
                    GraphName = graphName,
                    DebugKey = resolvedDebugKey,
                    State = "running",
                    CurrentNodeId = null,
                    FrameIndex = 0,
                };
                Instances[executionId] = instance;
                if (subscribed)
                {
                    EnqueueLocked(new VisualBridgeRuntimeGraphExecutionEvent
                    {
                        ExecutionId = executionId,
                        FrameIndex = 0,
                        Kind = "instanceStarted",
                    });
                }
            }

            target?.OnInstanceStarted(executionId, documentTypeId, documentId, graphName, resolvedDebugKey, 0);
            return true;
        }

        /// <summary>上报执行实例停止；实例从注册表移除（快照/订阅随即失效）。</summary>
        public static void OnInstanceStopped(string executionId)
        {
            if (!tracking || executionId == null)
            {
                return;
            }

            var target = Volatile.Read(ref observer);
            var stoppedFrame = 0;
            lock (Gate)
            {
                if (!Instances.TryGetValue(executionId, out var instance))
                {
                    return;
                }

                stoppedFrame = instance.FrameIndex;
                Instances.Remove(executionId);
                if (subscribed)
                {
                    EnqueueLocked(new VisualBridgeRuntimeGraphExecutionEvent
                    {
                        ExecutionId = executionId,
                        FrameIndex = stoppedFrame,
                        Kind = "instanceStopped",
                    });
                }
            }

            target?.OnInstanceStopped(executionId, stoppedFrame);
        }

        public static void OnNodeStart(string executionId, string nodeId, int frameIndex)
        {
            // 观察者与旧订阅者相互独立：没有观察者时保持原来的「无订阅零开销」快速路径。
            var target = Volatile.Read(ref observer);
            if (!tracking || (!subscribed && target == null))
            {
                return;
            }

            lock (Gate)
            {
                if (!Instances.TryGetValue(executionId, out var instance))
                {
                    return;
                }

                if (subscribed)
                {
                    // 旧路径语义（Doc/UnityGraphExecutionDebug.md）：无订阅期间当前节点与帧号**不更新**。
                    // 观察者只吃回调参数，不动实例快照——否则"装个观察者"就会改变旧路径的可观察输出。
                    instance.CurrentNodeId = nodeId;
                    instance.FrameIndex = frameIndex;
                    EnqueueLocked(new VisualBridgeRuntimeGraphExecutionEvent
                    {
                        ExecutionId = executionId,
                        FrameIndex = frameIndex,
                        Kind = "nodeStart",
                        NodeId = nodeId,
                    });
                }
            }

            target?.OnNodeStarted(executionId, nodeId, frameIndex);
        }

        public static void OnNodeOutput(string executionId, string nodeId, int outputIndex, int frameIndex)
        {
            var target = Volatile.Read(ref observer);
            if (!tracking || (!subscribed && target == null))
            {
                return;
            }

            lock (Gate)
            {
                if (!Instances.TryGetValue(executionId, out var instance))
                {
                    return;
                }

                if (subscribed)
                {
                    // 旧路径语义（Doc/UnityGraphExecutionDebug.md）：无订阅期间当前节点与帧号**不更新**。
                    // 观察者只吃回调参数，不动实例快照——否则"装个观察者"就会改变旧路径的可观察输出。
                    instance.CurrentNodeId = nodeId;
                    instance.FrameIndex = frameIndex;
                    EnqueueLocked(new VisualBridgeRuntimeGraphExecutionEvent
                    {
                        ExecutionId = executionId,
                        FrameIndex = frameIndex,
                        Kind = "nodeOutput",
                        NodeId = nodeId,
                        OutputIndex = outputIndex,
                    });
                }
            }

            target?.OnNodeOutput(executionId, nodeId, outputIndex, frameIndex);
        }

        public static void OnDataNode(string executionId, string nodeId, int frameIndex)
        {
            var target = Volatile.Read(ref observer);
            if (!tracking || (!subscribed && target == null))
            {
                return;
            }

            lock (Gate)
            {
                if (!Instances.TryGetValue(executionId, out var instance))
                {
                    return;
                }

                if (subscribed)
                {
                    // 旧路径语义（Doc/UnityGraphExecutionDebug.md）：无订阅期间当前节点与帧号**不更新**。
                    // 观察者只吃回调参数，不动实例快照——否则"装个观察者"就会改变旧路径的可观察输出。
                    instance.CurrentNodeId = nodeId;
                    instance.FrameIndex = frameIndex;
                    EnqueueLocked(new VisualBridgeRuntimeGraphExecutionEvent
                    {
                        ExecutionId = executionId,
                        FrameIndex = frameIndex,
                        Kind = "dataNode",
                        NodeId = nodeId,
                    });
                }
            }

            target?.OnDataNode(executionId, nodeId, frameIndex);
        }

        public static void OnEdgeValueChanged(string executionId, string nodeId, int outputIndex, string value, int frameIndex)
        {
            var target = Volatile.Read(ref observer);
            // value 为 null 在两条路径上都不产生事件：旧路径没有可传的值，调试契约的 value 是必填载荷。
            if (!tracking || value == null || (!subscribed && target == null))
            {
                return;
            }

            lock (Gate)
            {
                if (!Instances.TryGetValue(executionId, out var instance))
                {
                    return;
                }

                if (subscribed)
                {
                    // 旧路径语义（Doc/UnityGraphExecutionDebug.md）：无订阅期间当前节点与帧号**不更新**。
                    // 观察者只吃回调参数，不动实例快照——否则"装个观察者"就会改变旧路径的可观察输出。
                    instance.CurrentNodeId = nodeId;
                    instance.FrameIndex = frameIndex;
                    EnqueueLocked(new VisualBridgeRuntimeGraphExecutionEvent
                    {
                        ExecutionId = executionId,
                        FrameIndex = frameIndex,
                        Kind = "edgeValueChanged",
                        NodeId = nodeId,
                        OutputIndex = outputIndex,
                        Value = value,
                    });
                }
            }

            target?.OnEdgeValueChanged(executionId, nodeId, outputIndex, value, frameIndex);
        }

        /// <summary>按 documentId 过滤的运行中实例快照（documentIdFilter 为 null 时不过滤）。</summary>
        internal static List<VisualBridgeRuntimeGraphExecutionInstance> ListInstances(string documentIdFilter)
        {
            lock (Gate)
            {
                var result = new List<VisualBridgeRuntimeGraphExecutionInstance>();
                foreach (var instance in Instances.Values)
                {
                    if (documentIdFilter == null
                        || string.Equals(instance.DocumentId, documentIdFilter, StringComparison.Ordinal))
                    {
                        result.Add(Clone(instance));
                    }
                }

                return result;
            }
        }

        /// <summary>单个实例的浅快照；不存在（未开始或已停止）返回 null。</summary>
        internal static VisualBridgeRuntimeGraphExecutionInstance GetSnapshot(string executionId)
        {
            if (executionId == null)
            {
                return null;
            }

            lock (Gate)
            {
                return Instances.TryGetValue(executionId, out var instance) ? Clone(instance) : null;
            }
        }

        /// <summary>服务端开始/停止追踪；停止时清空注册表与缓冲（并让观察者丢弃已登记实例）。</summary>
        internal static void SetTracking(bool value)
        {
            IVisualBridgeGraphExecutionObserver target;
            lock (Gate)
            {
                tracking = value;
                if (!value)
                {
                    Instances.Clear();
                    Pending.Clear();
                    executionCounter = 0;
                }

                target = observer;
            }

            if (!value)
            {
                target?.Reset();
            }
        }

        /// <summary>订阅状态切换；退订清空待发缓冲（订阅即录制语义）。</summary>
        internal static void SetSubscribed(bool value)
        {
            lock (Gate)
            {
                subscribed = value;
                if (!value)
                {
                    Pending.Clear();
                }
            }
        }

        /// <summary>
        /// 执行泵：缓冲为空时等待至多 timeout，被「满 64 条」唤醒或超时后
        /// 一次性取走全部待发事件。drained 由调用方提供，避免内部分配。
        /// </summary>
        internal static bool WaitAndDrain(TimeSpan timeout, List<VisualBridgeRuntimeGraphExecutionEvent> drained)
        {
            lock (Gate)
            {
                if (Pending.Count == 0)
                {
                    Monitor.Wait(Gate, timeout);
                }

                if (Pending.Count == 0)
                {
                    return false;
                }

                drained.AddRange(Pending);
                Pending.Clear();
                return true;
            }
        }

        private static void EnqueueLocked(VisualBridgeRuntimeGraphExecutionEvent item)
        {
            if (Pending.Count >= MaxPendingEvents)
            {
                // 泵滞后时丢弃最旧事件，防止无界内存增长。
                Pending.RemoveAt(0);
            }

            Pending.Add(item);
            if (Pending.Count >= FlushThreshold)
            {
                Monitor.Pulse(Gate);
            }
        }

        private static VisualBridgeRuntimeGraphExecutionInstance Clone(VisualBridgeRuntimeGraphExecutionInstance instance)
        {
            return new VisualBridgeRuntimeGraphExecutionInstance
            {
                ExecutionId = instance.ExecutionId,
                DocumentTypeId = instance.DocumentTypeId,
                DocumentId = instance.DocumentId,
                GraphName = instance.GraphName,
                DebugKey = instance.DebugKey,
                State = instance.State,
                CurrentNodeId = instance.CurrentNodeId,
                FrameIndex = instance.FrameIndex,
            };
        }
    }
}
