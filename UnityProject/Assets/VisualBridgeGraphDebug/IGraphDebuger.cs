using VisualBridge.Diagnostics;

namespace VisualBridge.GraphDebug
{
    /// <summary>
    /// Graph 执行的调试契约（G1c，附录 B.2/B.5）：实例起止 + 节点/边级执行事实。
    ///
    /// 为什么由 UnityProject 声明：生成的 writer 必须和调用它的代码在同一个程序集里
    /// （生成产物落在 <c>Assets/VisualBridgeGraphDebug/Generated</c>，与发射端同属
    /// <c>VisualBridge.GraphDebug</c> 程序集）；而调试运行期（<c>VisualBridge.Debug</c>）在包内，
    /// 不能反向引用工程程序集。工程的调试契约因此和它的执行采集门面一样，属于工程侧。
    ///
    /// 与旧 graphExecution 录制一一对应（G1b 才删旧）：<c>instanceStarted</c> / <c>nodeStart</c> /
    /// <c>nodeOutput</c> / <c>dataNode</c> / <c>edgeValueChanged</c> / <c>instanceStopped</c>。
    /// 方法名是调试流的<b>唯一真源</b>：消费端 <c>Modules/Graph/src/graphDebugFacet.ts</c> 的别名表
    /// 由守卫测试逐一对齐（<c>debug-contracts.json</c> 的 graph 类别全部方法名 = 别名表键）。
    ///
    /// 参数约定：
    /// - 每个方法恰好一个 <c>[VisualBridgeDebugInstance]</c> 实例参数（执行实例 id，采集门面分配）；
    /// - 节点/边事件带稳定的 <c>nodeId</c>；边由 <c>nodeId + outputIndex</c>（节点内的输出序号）标识；
    /// - <c>frameIndex</c> 是图执行的帧号（旧路径同名字段），不是 Unity 的 <c>Time.frameCount</c>；
    /// - <c>value</c> 是引擎侧字符串化的边值（与旧录制的 <c>value: string</c> 一致）。
    /// </summary>
    [VisualBridgeDebuger(
        "graph",
        Kind = VisualBridgeDebugerKind.Event,
        GeneratedDirectory = "Assets/VisualBridgeGraphDebug/Generated")]
    public interface IGraphDebuger
    {
        /// <summary>一次图执行开始；documentTypeId/documentId 是 VisualBridge 图文档身份。</summary>
        bool InstanceStarted(
            [VisualBridgeDebugInstance] string instanceId,
            string documentTypeId,
            string documentId,
            string graphName,
            string debugKey,
            int frameIndex);

        /// <summary>一次图执行结束；documentId 让消费端无需依赖实例描述即可归属文档。</summary>
        bool InstanceStopped(
            [VisualBridgeDebugInstance] string instanceId,
            string documentId,
            int frameIndex);

        /// <summary>节点开始执行。</summary>
        bool NodeStarted(
            [VisualBridgeDebugInstance] string instanceId,
            string nodeId,
            int frameIndex);

        /// <summary>节点输出端口产生一次输出；outputIndex 是节点内的输出序号。</summary>
        bool NodeOutput(
            [VisualBridgeDebugInstance] string instanceId,
            string nodeId,
            int outputIndex,
            int frameIndex);

        /// <summary>数据节点被求值。</summary>
        bool DataNode(
            [VisualBridgeDebugInstance] string instanceId,
            string nodeId,
            int frameIndex);

        /// <summary>边的值变化；边由 nodeId + outputIndex（源节点的输出端口）标识。</summary>
        bool EdgeValueChanged(
            [VisualBridgeDebugInstance] string instanceId,
            string nodeId,
            int outputIndex,
            string value,
            int frameIndex);
    }
}
