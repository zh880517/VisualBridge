using System;
using System.Collections.Generic;
using UnityEngine;
using VisualBridge.Diagnostics;
using VisualBridge.Runtime;

namespace VisualBridge.GraphDebug
{
    /// <summary>
    /// Graph 调试发射端（G1c）：把 <see cref="VisualBridgeGraphExecutionCapture"/> 采集到的每条执行事实，
    /// 经生成的 <see cref="GraphDebuger"/> 门面写进统一调试通道（<c>category = "graph"</c>）。
    ///
    /// 设计约束：
    /// 1. **两路并存**。旧 graphExecution 缓冲照旧由服务端泵发给旧订阅者（G1b 才删），这里只是额外发一条
    ///    调试事件；是否给旧订阅者入队仍只由 <c>IsSubscribed</c> 决定，本类型不碰旧缓冲。
    /// 2. **实例生命周期**：实例开始 → <c>Create</c> + <c>InstanceStarted</c>；事实 → 节点/边事件；
    ///    实例结束 → <c>InstanceStopped</c> + <c>Finish</c>。每个实例在一个会话里只 Create 一次，
    ///    绝不每条事件都 Create。会话重置（断连/重装）会把实例集合清空，因此每条事实前用
    ///    <see cref="VisualBridgeDebug.isInstanceRegistered"/> 做幂等补建，重连后自动恢复上报。
    /// 3. **Create 早于连接**：已挂接但未连接时 Create 只入待发队列（附录 B.3.1），此时不发 InstanceStarted
    ///    （发了必被丢弃、还会计 dropped）；连接建立后的第一条事实补发它。
    /// 4. **串行发送**：生成代码的 Start→PushParam→End 必须同线程连续调用，采集门面允许任意线程上报，
    ///    所以这里用 <see cref="EmitGate"/> 串行化整条生成调用，避免跨线程告警与半条消息。
    ///
    /// 落点：本类型是采集门面观察者（<see cref="IVisualBridgeGraphExecutionObserver"/>）的实现，
    /// Play 模式在 <c>BeforeSceneLoad</c> 自动挂接；EditMode 用例可显式 <see cref="Install"/>。
    /// </summary>
    public sealed class VisualBridgeGraphDebugEmitter : IVisualBridgeGraphExecutionObserver
    {
        /// <summary>调试分类：Graph 模块 facet 按它认领（<c>Modules/Graph/src/graphDebugFacet.ts</c>）。</summary>
        public const string Category = "graph";

        /// <summary>单例：采集门面只接受一个观察者。</summary>
        public static readonly VisualBridgeGraphDebugEmitter Instance = new VisualBridgeGraphDebugEmitter();

        /// <summary>生成调用的串行锁（Start→PushParam→End 必须连续，附录 B.2）。</summary>
        private static readonly object EmitGate = new object();

        /// <summary>发射端登记的实例（按 executionId）：只保存 Create 需要的描述与已发状态。</summary>
        private static readonly Dictionary<string, EmittedInstance> Instances =
            new Dictionary<string, EmittedInstance>(StringComparer.Ordinal);

        private static bool installed;

        /// <summary>
        /// 自愈 kill switch（仅供验证"自愈机制真的被走到"）：设 <c>VISUALBRIDGE_GRAPH_DEBUG_NO_SELF_HEAL=1</c>
        /// 时退化为"只按 Create 返回值记账"，即不再用登记状态复核。默认开启自愈。
        /// </summary>
        private static readonly bool SelfHealEnabled =
            !string.Equals(Environment.GetEnvironmentVariable("VISUALBRIDGE_GRAPH_DEBUG_NO_SELF_HEAL"), "1",
                StringComparison.Ordinal);

        /// <summary>
        /// 发射端 trace 门控：<see cref="VisualBridgeDebugDiagnostics.Log"/> 只在 <c>VISUALBRIDGE_DEBUG_TRACE=1</c>
        /// 时输出（sink 由宿主在 Install 时注入），所以这里直接调用，不需要本地开关。
        /// </summary>
        private static void Trace(string message)
        {
            VisualBridgeDebug.trace("[graph-debug] " + message);
        }

        private VisualBridgeGraphDebugEmitter()
        {
        }

        /// <summary>
        /// Play 模式自动挂接：BeforeSceneLoad 早于场景脚本，采集事实从一开始就有接收者。
        /// 排查开关 <c>VISUALBRIDGE_GRAPH_DEBUG_EMITTER=0</c> 可关掉自动挂接（只读，不影响显式 Install）。
        /// </summary>
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.BeforeSceneLoad)]
        private static void InstallOnPlay()
        {
            if (string.Equals(Environment.GetEnvironmentVariable("VISUALBRIDGE_GRAPH_DEBUG_EMITTER"), "0",
                    StringComparison.Ordinal))
            {
                UnityEngine.Debug.Log("[graph-debug] auto install disabled by VISUALBRIDGE_GRAPH_DEBUG_EMITTER=0");
                return;
            }

            Install();
        }

        /// <summary>挂接到采集门面；重复调用无副作用。</summary>
        public static void Install()
        {
            lock (EmitGate)
            {
                if (installed)
                {
                    return;
                }

                installed = true;
            }

            VisualBridgeGraphExecutionCapture.SetObserver(Instance);
        }

        /// <summary>解除挂接并丢弃登记的实例；重复调用无副作用。</summary>
        public static void Uninstall()
        {
            lock (EmitGate)
            {
                installed = false;
            }

            // SetObserver(null) 会让被替换的观察者收到 Reset，实例登记随之清空。
            VisualBridgeGraphExecutionCapture.SetObserver(null);
        }

        public void OnInstanceStarted(
            string executionId,
            string documentTypeId,
            string documentId,
            string graphName,
            string debugKey,
            int frameIndex)
        {
            if (string.IsNullOrEmpty(executionId))
            {
                return;
            }

            lock (EmitGate)
            {
                var entry = new EmittedInstance(documentTypeId, documentId, graphName, debugKey ?? string.Empty);
                Instances[executionId] = entry;
                EnsureCreated(executionId, entry);
                SyncFrame(frameIndex);
                Announce(executionId, entry, frameIndex);
            }
        }

        public void OnInstanceStopped(string executionId, int frameIndex)
        {
            if (string.IsNullOrEmpty(executionId))
            {
                return;
            }

            lock (EmitGate)
            {
                if (!Instances.TryGetValue(executionId, out var entry))
                {
                    // 发射端装晚或已 Reset：没有我们建的实例，不能对未知实例 Finish（会误导会话）。
                    return;
                }

                if (entry.Created)
                {
                    if (entry.Announced)
                    {
                        // 帧号先同步再发：`record.frame` 取的是 Start 时刻的会话帧号，payload 用的是这里传的
                        // 图执行帧；两者必须同源，否则"实例结束于第 N 帧"会记成上一帧。
                        SyncFrame(frameIndex);
                        GraphDebuger.InstanceStopped(executionId, entry.DocumentId, frameIndex);
                    }

                    // 会话可能已被服务端清空：那就不存在可 Finish 的实例（Finish 会返回 false 并告警）。
                    if (VisualBridgeDebug.isInstanceRegistered(executionId))
                    {
                        VisualBridgeDebug.Finish(executionId);
                    }
                }

                Instances.Remove(executionId);
            }
        }

        public void OnNodeStarted(string executionId, string nodeId, int frameIndex)
        {
            lock (EmitGate)
            {
                if (!Prepare(executionId, frameIndex, out _))
                {
                    return;
                }

                GraphDebuger.NodeStarted(executionId, nodeId, frameIndex);
            }
        }

        public void OnNodeOutput(string executionId, string nodeId, int outputIndex, int frameIndex)
        {
            lock (EmitGate)
            {
                if (!Prepare(executionId, frameIndex, out _))
                {
                    return;
                }

                GraphDebuger.NodeOutput(executionId, nodeId, outputIndex, frameIndex);
            }
        }

        public void OnDataNode(string executionId, string nodeId, int frameIndex)
        {
            lock (EmitGate)
            {
                if (!Prepare(executionId, frameIndex, out _))
                {
                    return;
                }

                GraphDebuger.DataNode(executionId, nodeId, frameIndex);
            }
        }

        public void OnEdgeValueChanged(string executionId, string nodeId, int outputIndex, string value, int frameIndex)
        {
            if (value == null)
            {
                // 契约里的 value 是必填载荷；采集门面也在两条路径上都丢弃 null 值。
                return;
            }

            lock (EmitGate)
            {
                if (!Prepare(executionId, frameIndex, out _))
                {
                    return;
                }

                GraphDebuger.EdgeValueChanged(executionId, nodeId, outputIndex, value, frameIndex);
            }
        }

        /// <summary>
        /// 追踪停止或观察者被替换：先对仍登记着的实例补 <c>InstanceStopped</c> + <c>Finish</c>（否则会留下
        /// "Create 过、永不 Finish"的实例，远端只能等连接断开才收敛），再丢弃登记。
        /// 会话可能已先被服务端清空：那种情况下 <see cref="VisualBridgeDebug.isInstanceRegistered"/> 为 false，
        /// 跳过 <see cref="VisualBridgeDebug.Finish"/>（对不存在的实例 Finish 会返回 false 并告警），
        /// 但仍把本地登记清掉。
        /// </summary>
        public void Reset()
        {
            lock (EmitGate)
            {
                FinishAll();
            }
        }

        /// <summary>
        /// 补齐所有登记实例的结束消息并清空登记。帧号取**会话当前帧**（`VisualBridgeDebug.frame`，即最近一次
        /// `SetFrame` 的值），**不再用常量 0 冒充**：0 是合法帧号，用 0 表示"不知道第几帧"会让
        /// "第 0 帧结束"与"无帧信息"无法区分（与 `outputIndex=0` 被默认值规则吞掉是同一类坑）。
        /// 若本会话从未设帧，会话帧是 -1（"无帧"的显式值），照实写入。
        /// </summary>
        private static void FinishAll()
        {
            var frameIndex = VisualBridgeDebug.frame;
            foreach (var pair in Instances)
            {
                if (!VisualBridgeDebug.isInstanceRegistered(pair.Key))
                {
                    // 会话已重置：远端已没有这个实例，不能再 Finish（否则是"对不存在实例的 Finish"）。
                    continue;
                }

                if (pair.Value.Announced)
                {
                    // `record.frame` 与 payload 同源：先按同一帧号同步会话，再发。
                    SyncFrame((int)frameIndex);
                    GraphDebuger.InstanceStopped(pair.Key, pair.Value.DocumentId, (int)frameIndex);
                }

                VisualBridgeDebug.Finish(pair.Key);
            }

            Instances.Clear();
        }

        /// <summary>
        /// 发射一条节点/边事实前的准备：登记存在 → 幂等补建 → 对齐帧号 → 必要时补发 InstanceStarted。
        /// 帧号必须在 <see cref="Announce"/> **之前**同步：补发的 InstanceStarted 的 `record.frame` 取的是
        /// Start 时刻的会话帧号，晚同步就会出现"载荷 frameIndex 是新帧、record.frame 是重置前最后一帧"的错位。
        /// 返回 false 表示当前没有可用的调试会话（未挂接/实例数或槽位耗尽），调用方直接跳过。
        /// </summary>
        private static bool Prepare(string executionId, int frameIndex, out EmittedInstance entry)
        {
            entry = null;
            if (string.IsNullOrEmpty(executionId) || !Instances.TryGetValue(executionId, out entry))
            {
                return false;
            }

            EnsureCreated(executionId, entry);
            if (!entry.Created)
            {
                return false;
            }

            SyncFrame(frameIndex);
            Announce(executionId, entry, frameIndex);
            return true;
        }

        /// <summary>
        /// 幂等 Create，**以"确认登记"为准**：只有 <see cref="VisualBridgeDebug.isInstanceRegistered"/>
        /// 为真才算成功。直接用 Create 的返回值判断会漏掉两种情况——"未连接时入待发队列、随后会话被清空"
        /// 与"会话换代后登记已丢"；那之后每条事实都会因为实例不在会话里被丢弃。
        /// 因此每条事实进来都先复核登记，丢了就重建（并允许重发一次 InstanceStarted），
        /// 这样自愈发生在**任意一条后续事实**上，不依赖"恰好赶在重置之前"。
        /// </summary>
        private static void EnsureCreated(string executionId, EmittedInstance entry)
        {
            if (SelfHealEnabled && VisualBridgeDebug.isInstanceRegistered(executionId))
            {
                // 已登记：本次调用什么都不做（Create 的返回值不能当成长期状态，所以这里每事实都复核）。
                // 注意"登记着"不等于"远端已有描述"：断连期间登记会留着、描述却随会话重置被清，
                // 那条补发必须等 `Announce` 里 `isConnected` 为真才发出（见 Announce）。
                entry.Created = true;
                return;
            }

            if (!SelfHealEnabled && entry.Created)
            {
                return;
            }

            entry.Created = VisualBridgeDebug.Create(
                executionId,
                Category,
                entry.GraphName,
                entry.DebugInfo());
            // 重建一律清掉"已公告"：旧会话里的那一次 InstanceStarted 对新会话无效，换会话必须重发。
            // （Create 返回 true 只表示"这次调用被接受"——未连接时是入待发队列，之后可能被会话重置清掉；
            //  所以"已公告"只与"本次重建后是否真的登记成功"有关，与返回值无关。）
            MarkAnnounced(entry, announced: false, confirmed: VisualBridgeDebug.isInstanceRegistered(executionId));
            // 排障（`VISUALBRIDGE_DEBUG_TRACE=1`，走统一 trace 通道）：记录"重建了实例"这一步及其确认结果。
            Trace("re-created instance '" + executionId + "' accepted=" + entry.Created
                + " registered=" + VisualBridgeDebug.isInstanceRegistered(executionId)
                + " selfHeal=" + SelfHealEnabled);
        }

        /// <summary>
        /// 把图执行帧号同步给调试会话：`record.frame` 取的是 Start 时刻的会话帧号（生成代码不推送它），
        /// 不同步的话真实 Play 下会话帧号恒为 -1，面板只能显示"帧 -1"。
        /// </summary>
        private static void SyncFrame(int frameIndex)
        {
            VisualBridgeDebug.SetFrame(frameIndex);
        }

        /// <summary>
        /// 唯一改写"已公告"标记的地方：只有"确认登记"为真时才可能记为已公告，
        /// 其余情况一律记成未公告（下一条事实会补发 InstanceStarted）。集中在一处，避免下次再写错。
        /// </summary>
        private static void MarkAnnounced(EmittedInstance entry, bool announced, bool confirmed)
        {
            entry.Announced = announced && confirmed;
        }

        /// <summary>连接建立后补发一次 InstanceStarted（每会话一次；断开期间不发，避免必丢的计数）。</summary>
        private static void Announce(string executionId, EmittedInstance entry, int frameIndex)
        {
            if (SelfHealEnabled && !VisualBridgeDebug.isInstanceRegistered(executionId))
            {
                return;
            }

            if (entry.Announced || !VisualBridgeDebug.isConnected)
            {
                return;
            }

            var sent = GraphDebuger.InstanceStarted(
                executionId,
                entry.DocumentTypeId,
                entry.DocumentId,
                entry.GraphName,
                entry.DebugKey,
                frameIndex);
            MarkAnnounced(entry, sent, confirmed: VisualBridgeDebug.isInstanceRegistered(executionId));
        }

        /// <summary>一次执行发射所需的实例描述与已发状态。</summary>
        private sealed class EmittedInstance
        {
            public EmittedInstance(string documentTypeId, string documentId, string graphName, string debugKey)
            {
                DocumentTypeId = documentTypeId ?? string.Empty;
                DocumentId = documentId ?? string.Empty;
                GraphName = graphName ?? string.Empty;
                DebugKey = debugKey;
            }

            public string DocumentTypeId { get; }

            public string DocumentId { get; }

            public string GraphName { get; }

            public string DebugKey { get; }

            /// <summary>
            /// 最近一次 Create 是否被接受（实例已登记，或入待发队列）。**这只是"这次调用被接受"**：
            /// 入队后如果会话被重置，待发描述会被清掉而这里仍为 true——所以每次使用前都要用
            /// <see cref="VisualBridgeDebug.isInstanceRegistered"/> 复核（见 EnsureCreated）。
            /// </summary>
            public bool Created { get; set; }

            /// <summary>InstanceStarted 是否已按"登记状态为真"发出过（会话重置后会重新置 false）。</summary>
            public bool Announced { get; set; }

            /// <summary>实例描述的 debugInfo：文档身份 + 执行者标识（面板展示用，不参与路由）。</summary>
            public string DebugInfo()
            {
                var document = DocumentId.Length == 0 ? DocumentTypeId : DocumentTypeId + "/" + DocumentId;
                return DebugKey.Length == 0 ? document : document + " @" + DebugKey;
            }
        }
    }
}
