namespace VisualBridge.Editor
{
    /// <summary>一个计划产物与磁盘现状的比较结果（与三域 Compiler 的输出模型同构，便于 batch 统一记录）。</summary>
    public sealed class VisualBridgeDebugCompileOutput
    {
        internal VisualBridgeDebugCompileOutput(string path, string expectedSha256, string previousSha256, bool changed)
        {
            Path = path;
            ExpectedSha256 = expectedSha256;
            PreviousSha256 = previousSha256;
            Changed = changed;
        }

        /// <summary>产物绝对路径。</summary>
        public string Path { get; }

        /// <summary>本次生成应有的内容哈希（SHA-256 小写十六进制）。</summary>
        public string ExpectedSha256 { get; }

        /// <summary>磁盘现状的哈希；文件不存在时为 <c>null</c>。</summary>
        public string PreviousSha256 { get; }

        /// <summary>磁盘内容与应有内容不一致（或文件缺失）。</summary>
        public bool Changed { get; }
    }
}
