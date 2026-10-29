using System.Runtime.CompilerServices;

// Debug.Bridge 负责把静态 API 接到传输层；测试程序集需要读实例状态、诊断与假编码器。
[assembly: InternalsVisibleTo("VisualBridge.Debug.Bridge")]
[assembly: InternalsVisibleTo("VisualBridge.Editor.Tests")]
// E11：Graph 发射端的 EditMode 用例要断言"登记表"（与"会话快照"分开的第二套状态）——
// Reset / InstanceStopped 在会话已复位时是否真的注销了登记，只能从这里观测（评审 P1-2）。
[assembly: InternalsVisibleTo("VisualBridge.GraphDebug.Tests")]
