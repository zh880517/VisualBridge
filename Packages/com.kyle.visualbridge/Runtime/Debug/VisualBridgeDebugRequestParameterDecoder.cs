using System;

namespace VisualBridge.Diagnostics
{
    /// <summary>
    /// 方法号 → 载荷参数声明表（附录 B.5）：由生成的 Dispatcher 的 <c>TryGetParameters</c> 适配，
    /// 运行期据此把请求 args 按 tag 重排成业务方法的声明顺序并做类型校验。
    /// 返回 false 表示该方法号不属于这个处理器（分类内方法号唯一，运行期用它可以反查接口）。
    /// </summary>
    public delegate bool VisualBridgeDebugRequestParameterDecoder(
        ushort methodId,
        out string[] names,
        out ushort[] tags,
        out Type[] types);
}
