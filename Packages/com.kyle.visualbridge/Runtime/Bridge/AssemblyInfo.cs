using System.Runtime.CompilerServices;

// 传输层（Runtime）把连接包成「调试通道」（VisualBridgeRuntimeDebugLink）；测试需要构造该通道
// 与真实 socket 一起验证帧头通道位与写出顺序。
[assembly: InternalsVisibleTo("VisualBridge.Editor.Tests")]
