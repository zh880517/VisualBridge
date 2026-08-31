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

        /// <summary>服务端是否在追踪（Editor Play / Player 运行期间为 true）。</summary>
        public static bool IsTracking => tracking;

        /// <summary>当前是否存在至少一个执行事件订阅者。</summary>
        public static bool IsSubscribed => subscribed;

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
                    DebugKey = debugKey ?? string.Empty,
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

            return true;
        }

        /// <summary>上报执行实例停止；实例从注册表移除（快照/订阅随即失效）。</summary>
        public static void OnInstanceStopped(string executionId)
        {
            if (!tracking || executionId == null)
            {
                return;
            }

            lock (Gate)
            {
                if (!Instances.TryGetValue(executionId, out var instance))
                {
                    return;
                }

                Instances.Remove(executionId);
                if (subscribed)
                {
                    EnqueueLocked(new VisualBridgeRuntimeGraphExecutionEvent
                    {
                        ExecutionId = executionId,
                        FrameIndex = instance.FrameIndex,
                        Kind = "instanceStopped",
                    });
                }
            }
        }

        public static void OnNodeStart(string executionId, string nodeId, int frameIndex)
        {
            if (!tracking || !subscribed)
            {
                return;
            }

            lock (Gate)
            {
                if (!Instances.TryGetValue(executionId, out var instance))
                {
                    return;
                }

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

        public static void OnNodeOutput(string executionId, string nodeId, int outputIndex, int frameIndex)
        {
            if (!tracking || !subscribed)
            {
                return;
            }

            lock (Gate)
            {
                if (!Instances.TryGetValue(executionId, out var instance))
                {
                    return;
                }

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

        public static void OnDataNode(string executionId, string nodeId, int frameIndex)
        {
            if (!tracking || !subscribed)
            {
                return;
            }

            lock (Gate)
            {
                if (!Instances.TryGetValue(executionId, out var instance))
                {
                    return;
                }

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

        public static void OnEdgeValueChanged(string executionId, string nodeId, int outputIndex, string value, int frameIndex)
        {
            if (!tracking || !subscribed || value == null)
            {
                return;
            }

            lock (Gate)
            {
                if (!Instances.TryGetValue(executionId, out var instance))
                {
                    return;
                }

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

        /// <summary>服务端开始/停止追踪；停止时清空注册表与缓冲。</summary>
        internal static void SetTracking(bool value)
        {
            lock (Gate)
            {
                tracking = value;
                if (!value)
                {
                    Instances.Clear();
                    Pending.Clear();
                    executionCounter = 0;
                }
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
