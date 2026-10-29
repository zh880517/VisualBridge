namespace VisualBridge.Runtime
{
    /// <summary>
    /// Graph 执行事实的观察者（G1c）：<see cref="VisualBridgeGraphExecutionCapture"/> 把每条
    /// 执行事实同步回调给观察者一次，供调试发射端转成 <c>category = "graph"</c> 的调试契约事件。
    ///
    /// 为什么是观察者而不是直接发调试事件：<c>VisualBridge.Runtime</c> 不引用调试程序集
    /// （<c>VisualBridge.Debug</c> 反向依赖它，直接引用会形成 asmdef 循环），
    /// 所以发射端在宿主侧实现本接口并注入。
    ///
    /// 线程与重入：回调在调用 <c>On*</c> 的线程上同步执行，且**不在采集锁内**；
    /// 实现不得阻塞、不得回调采集门面（<see cref="VisualBridgeGraphExecutionCapture"/>）。
    /// </summary>
    public interface IVisualBridgeGraphExecutionObserver
    {
        /// <summary>执行实例开始（注册观察者时若已有运行中实例，会按 executionId 顺序补发一次）。</summary>
        void OnInstanceStarted(
            string executionId,
            string documentTypeId,
            string documentId,
            string graphName,
            string debugKey,
            int frameIndex);

        /// <summary>执行实例停止；采集门面先从注册表移除，再回调这里。</summary>
        void OnInstanceStopped(string executionId, int frameIndex);

        /// <summary>节点开始执行。</summary>
        void OnNodeStarted(string executionId, string nodeId, int frameIndex);

        /// <summary>节点输出端口产生一次输出（outputIndex 是节点内的输出序号）。</summary>
        void OnNodeOutput(string executionId, string nodeId, int outputIndex, int frameIndex);

        /// <summary>数据节点被求值。</summary>
        void OnDataNode(string executionId, string nodeId, int frameIndex);

        /// <summary>边的值变化（边由 nodeId + outputIndex 标识，value 是引擎侧字符串化的值）。</summary>
        void OnEdgeValueChanged(string executionId, string nodeId, int outputIndex, string value, int frameIndex);

        /// <summary>追踪停止或观察者被替换：丢弃已登记实例，之后从新事实重新开始。</summary>
        void Reset();
    }
}
