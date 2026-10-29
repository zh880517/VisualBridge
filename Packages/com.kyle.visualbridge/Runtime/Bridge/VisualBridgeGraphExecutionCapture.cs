using System;
using System.Collections.Generic;
using System.Threading;

namespace VisualBridge.Runtime
{
    /// <summary>
    /// Graph 执行采集门面（架构文档 §19.4）：游戏侧引擎把自己的 debug
    /// provider 事件转发到这里，VisualBridge 分配执行实例 ID（exec-&lt;n&gt;）
    /// 并维护实例注册表。生命周期追踪（实例起止）在服务端运行期间常开；
    /// Runtime 程序集禁止 Unity API；所有方法线程安全。
    ///
    /// 数据出口只有一个：**观察者缝**（G1c）。<see cref="SetObserver"/> 注入的
    /// <see cref="IVisualBridgeGraphExecutionObserver"/> 会在每条事实处理后同步收到一次回调，
    /// 供宿主侧的 Graph 调试发射端转成 <c>category = "graph"</c> 的调试契约事件。
    /// 采集与传输解耦：Runtime 不引用调试程序集，观察者由宿主注入。
    /// </summary>
    public static class VisualBridgeGraphExecutionCapture
    {
        private static readonly object Gate = new object();
        private static readonly Dictionary<string, VisualBridgeRuntimeGraphExecutionInstance> Instances =
            new Dictionary<string, VisualBridgeRuntimeGraphExecutionInstance>(StringComparer.Ordinal);
        private static long executionCounter;
        private static volatile bool tracking;
        private static IVisualBridgeGraphExecutionObserver observer;

        /// <summary>服务端是否在追踪（Editor Play / Player 运行期间为 true）。</summary>
        public static bool IsTracking => tracking;

        /// <summary>
        /// 注册 Graph 执行观察者（G1c）：宿主侧的调试发射端用它把每条事实转成调试契约事件。
        /// Runtime 不引用调试程序集，因此观察者由宿主注入；传 null 移除观察者。
        /// 注册时若已有运行中实例，会按 executionId 顺序补发一次实例开始事实，避免「发射端装晚了」
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
            }

            target?.OnInstanceStarted(executionId, documentTypeId, documentId, graphName, resolvedDebugKey, 0);
            return true;
        }

        /// <summary>上报执行实例停止；实例从注册表移除。</summary>
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
            }

            target?.OnInstanceStopped(executionId, stoppedFrame);
        }

        public static void OnNodeStart(string executionId, string nodeId, int frameIndex)
        {
            // 没有观察者时保持零开销快速路径。
            var target = Volatile.Read(ref observer);
            if (!tracking || target == null)
            {
                return;
            }

            lock (Gate)
            {
                if (!Instances.TryGetValue(executionId, out var instance))
                {
                    return;
                }

                // 节点事实写入的字段里，只有 FrameIndex 会被下游消费（停止事实取它作帧号；观察者补发也读它）。
                // CurrentNodeId 当前无读者；补发另读实例身份字段（ExecutionId/DocumentTypeId/DocumentId/GraphName/DebugKey）。
                instance.CurrentNodeId = nodeId;
                instance.FrameIndex = frameIndex;
            }

            target?.OnNodeStarted(executionId, nodeId, frameIndex);
        }

        public static void OnNodeOutput(string executionId, string nodeId, int outputIndex, int frameIndex)
        {
            var target = Volatile.Read(ref observer);
            if (!tracking || target == null)
            {
                return;
            }

            lock (Gate)
            {
                if (!Instances.TryGetValue(executionId, out var instance))
                {
                    return;
                }

                // 节点事实写入的字段里，只有 FrameIndex 会被下游消费（停止事实取它作帧号；观察者补发也读它）。
                // CurrentNodeId 当前无读者；补发另读实例身份字段（ExecutionId/DocumentTypeId/DocumentId/GraphName/DebugKey）。
                instance.CurrentNodeId = nodeId;
                instance.FrameIndex = frameIndex;
            }

            target?.OnNodeOutput(executionId, nodeId, outputIndex, frameIndex);
        }

        public static void OnDataNode(string executionId, string nodeId, int frameIndex)
        {
            var target = Volatile.Read(ref observer);
            if (!tracking || target == null)
            {
                return;
            }

            lock (Gate)
            {
                if (!Instances.TryGetValue(executionId, out var instance))
                {
                    return;
                }

                // 节点事实写入的字段里，只有 FrameIndex 会被下游消费（停止事实取它作帧号；观察者补发也读它）。
                // CurrentNodeId 当前无读者；补发另读实例身份字段（ExecutionId/DocumentTypeId/DocumentId/GraphName/DebugKey）。
                instance.CurrentNodeId = nodeId;
                instance.FrameIndex = frameIndex;
            }

            target?.OnDataNode(executionId, nodeId, frameIndex);
        }

        public static void OnEdgeValueChanged(string executionId, string nodeId, int outputIndex, string value, int frameIndex)
        {
            var target = Volatile.Read(ref observer);
            // value 为 null 不产生事件：调试契约的 value 是必填载荷。
            if (!tracking || value == null || target == null)
            {
                return;
            }

            lock (Gate)
            {
                if (!Instances.TryGetValue(executionId, out var instance))
                {
                    return;
                }

                // 节点事实写入的字段里，只有 FrameIndex 会被下游消费（停止事实取它作帧号；观察者补发也读它）。
                // CurrentNodeId 当前无读者；补发另读实例身份字段（ExecutionId/DocumentTypeId/DocumentId/GraphName/DebugKey）。
                instance.CurrentNodeId = nodeId;
                instance.FrameIndex = frameIndex;
            }

            target?.OnEdgeValueChanged(executionId, nodeId, outputIndex, value, frameIndex);
        }

        /// <summary>服务端开始/停止追踪；停止时清空注册表（并让观察者丢弃已登记实例）。</summary>
        internal static void SetTracking(bool value)
        {
            IVisualBridgeGraphExecutionObserver target;
            lock (Gate)
            {
                tracking = value;
                if (!value)
                {
                    Instances.Clear();
                    executionCounter = 0;
                }

                target = observer;
            }

            if (!value)
            {
                target?.Reset();
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
