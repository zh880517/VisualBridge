using VisualBridge.Diagnostics;

namespace VisualBridge.Editor.Tests.DebugFixtures
{
    /// <summary>Graph 调试事件契约样例：覆盖实例参数、帧参数与显式标签。</summary>
    [VisualBridgeDebuger(
        "graph",
        Version = 1,
        GeneratedDirectory = "Packages/com.kyle.visualbridge/Tests/Editor/Debug/Generated",
        InstanceParameter = "uid",
        FrameParameter = "frameIndex")]
    public interface IGraphDebuger
    {
        void ExecutionStarted(string uid, string graphName, string documentId, string debugKey);

        void NodeStart(string uid, string nodeId, int frameIndex);

        void NodeOutput(string uid, string nodeId, int outputIndex, int frameIndex);

        void DataNode(string uid, string nodeId, int frameIndex);

        void EdgeValueChanged(
            string uid,
            [VisualBridgeDebugTag(10)] string nodeId,
            int outputIndex,
            string value,
            int frameIndex);

        void ExecutionStopped(string uid);
    }

    /// <summary>Graph 调试查询契约样例。</summary>
    [VisualBridgeDebuger(
        "graph",
        Version = 1,
        Kind = VisualBridgeDebugerKind.Query,
        GeneratedDirectory = "Packages/com.kyle.visualbridge/Tests/Editor/Debug/Generated",
        InstanceParameter = "uid")]
    public interface IGraphQueryDebuger
    {
        void GetSnapshot(string uid, string requestId);
    }
}
