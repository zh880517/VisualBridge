using System;

namespace VisualBridge.Debug
{
    /// <summary>标记调试契约接口。</summary>
    [AttributeUsage(AttributeTargets.Interface, AllowMultiple = false)]
    public sealed class VisualBridgeDebugerAttribute : Attribute
    {
        public VisualBridgeDebugerAttribute(string category)
        {
            if (string.IsNullOrWhiteSpace(category))
            {
                throw new ArgumentException("调试类别不能为空。", nameof(category));
            }

            Category = category.Trim();
        }

        /// <summary>接口类别，已去除首尾空白。</summary>
        public string Category { get; }

        /// <summary>生成物目录；为 null 时使用默认目录。</summary>
        public string GeneratedDirectory { get; set; }

        /// <summary>接口版本。</summary>
        public int Version { get; set; } = 1;

        /// <summary>调用类别。</summary>
        public VisualBridgeDebugerKind Kind { get; set; }

        /// <summary>实例参数名；为 null 表示无实例。</summary>
        public string InstanceParameter { get; set; }

        /// <summary>帧参数名；为 null 表示无帧参数。</summary>
        public string FrameParameter { get; set; }
    }
}
