namespace VisualBridge.Diagnostics
{
    /// <summary>
    /// 调试契约的运行环境类型（附录 B.2）：Editor 非播放态、Editor 内 Play 模式、独立 Player。
    /// 由传输层提供，业务只读。
    /// </summary>
    public enum ConnectType
    {
        /// <summary>Unity Editor 非播放态。</summary>
        Editor = 0,

        /// <summary>Editor 内的 Play 模式。</summary>
        EditorPlayer,

        /// <summary>独立 Player 构建。</summary>
        Player,
    }
}
