using System.Runtime.CompilerServices;

// 查询 pump 的挂接状态是静态字段：测试需要在不重启 Editor 的前提下重置/模拟 Domain Reload。
[assembly: InternalsVisibleTo("VisualBridge.Editor.Tests")]
