namespace VisualBridge.Editor
{
    /// <summary>生成器入口的两种模式：Generate 写产物，Check 只比较（drift 由 batch 映射为退出码 2）。</summary>
    public enum VisualBridgeDebugGenerateMode
    {
        Generate,
        Check,
    }
}
