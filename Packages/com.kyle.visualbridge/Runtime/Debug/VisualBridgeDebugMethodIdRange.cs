namespace VisualBridge.Diagnostics
{
    /// <summary>
    /// 方法号号段（附录 A.4）：<c>0</c> = <c>None</c>、<c>1</c>/<c>2</c> = <c>Create</c>/<c>Finish</c>、
    /// <c>3–9</c> 预留系统、<c>10+</c> 分类方法。二进制载荷头（A.4）与 JSON <c>request</c> 信封（A.5）
    /// 共用同一号段，运行期只在定义这一处，传输层、入站解析器与查询队列都引用它。
    /// </summary>
    public static class VisualBridgeDebugMethodIdRange
    {
        /// <summary>分类方法号段的起点；低于它的方法号不参与事件与查询。</summary>
        public const ushort FirstCategoryMethodId = 10;
    }
}
