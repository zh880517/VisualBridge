using System.Runtime.CompilerServices;

// Debug.Bridge 负责把静态 API 接到传输层；测试程序集需要读实例状态、诊断与假编码器。
[assembly: InternalsVisibleTo("VisualBridge.Debug.Bridge")]
[assembly: InternalsVisibleTo("VisualBridge.Editor.Tests")]
