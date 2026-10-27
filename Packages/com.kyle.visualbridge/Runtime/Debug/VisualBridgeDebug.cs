using System;

namespace VisualBridge.Diagnostics
{
    /// <summary>
    /// 调试契约对业务暴露的静态门面（附录 B.2）：业务像调用 Debug.Log 一样调用，
    /// 不判断连接、不处理异常。编译边界见附录 B.1：宏关闭时全部方法返回 false / 空实现，
    /// 通信实现不参与编译，不加载任何静态状态、不产生任何副作用。
    /// </summary>
    public static class VisualBridgeDebug
    {
        /// <summary>编译期常量：Editor 与 Development Build 为 true。</summary>
        public static bool isDebugBuild
        {
            get
            {
#if UNITY_EDITOR || DEVELOPMENT_BUILD
                return true;
#else
                return false;
#endif
            }
        }

        /// <summary>是否已挂接并建立连接；业务不需要判断，生成代码也不依赖它。</summary>
        public static bool isConnected
        {
            get
            {
#if UNITY_EDITOR || VISUALBRIDGE_RUNTIME_BRIDGE
                return VisualBridgeDebugSession.IsConnected;
#else
                return false;
#endif
            }
        }

        /// <summary>运行环境类型；宏关闭时固定为独立 Player。</summary>
        public static ConnectType ConnectType
        {
            get
            {
#if UNITY_EDITOR || VISUALBRIDGE_RUNTIME_BRIDGE
                return VisualBridgeDebugSession.CurrentConnectType;
#else
                return ConnectType.Player;
#endif
            }
        }

        /// <summary>
        /// 创建实例描述：加入实例集合、分配槽位，已挂接且有连接时立即发送，已挂接但无连接时入待发队列。
        /// 未挂接（没有注入传输）时返回 false 且不产生任何状态，与宏关闭一致。
        /// 重复 Create 返回 true 且不重发；实例或槽位耗尽时返回 false 并告警。
        /// </summary>
        public static bool Create(string instanceId, string category, string resName, string debugInfo)
        {
#if UNITY_EDITOR || VISUALBRIDGE_RUNTIME_BRIDGE
            return VisualBridgeDebugSession.Create(instanceId, category, resName, debugInfo);
#else
            return false;
#endif
        }

        /// <summary>
        /// 结束实例：移出实例集合并发送结束；实例不存在或未挂接时返回 false。
        /// </summary>
        public static bool Finish(string instanceId)
        {
#if UNITY_EDITOR || VISUALBRIDGE_RUNTIME_BRIDGE
            return VisualBridgeDebugSession.Finish(instanceId);
#else
            return false;
#endif
        }

        /// <summary>设置当前帧号（默认 -1 表示无帧）；只写内部值，不立即产生消息。</summary>
        public static void SetFrame(long frame)
        {
#if UNITY_EDITOR || VISUALBRIDGE_RUNTIME_BRIDGE
            VisualBridgeDebugSession.SetFrame(frame);
#endif
        }

        /// <summary>注入消息编码器；替换编码器时生成代码零改动。</summary>
        public static void SetEncoder(IDebugMessageEncoder encoder)
        {
#if UNITY_EDITOR || VISUALBRIDGE_RUNTIME_BRIDGE
            VisualBridgeDebugSession.SetEncoder(encoder);
#endif
        }

        /// <summary>
        /// 开始一条事件消息：返回 true 只表示消息被接受；返回 false 后生成代码必须立即返回，
        /// 不得再调用 PushParam / End（附录 B.2）。同一条消息的 Start→PushParam→End 必须在同一线程连续调用。
        /// </summary>
        public static bool Start(string instanceId, string category, ushort methodId, string iface, string method)
        {
#if UNITY_EDITOR || VISUALBRIDGE_RUNTIME_BRIDGE
            return VisualBridgeDebugSession.Start(instanceId, category, methodId, iface, method);
#else
            return false;
#endif
        }

        /// <summary>结果回发入口：开始一条查询结果消息，之后照常 PushParam / End（同样要求同线程）。</summary>
        public static bool StartResult(VisualBridgeDebugRequest request)
        {
#if UNITY_EDITOR || VISUALBRIDGE_RUNTIME_BRIDGE
            return VisualBridgeDebugSession.StartResult(request);
#else
            return false;
#endif
        }

        /// <summary>
        /// 拒绝请求：发送失败应答（通道 1 的 <c>response</c>），不进入调试流。错误码是
        /// <c>runtime.queryRejected</c>（附录 A.6），<paramref name="reason"/> 原样进 <c>detail</c>。
        /// </summary>
        public static bool RejectRequest(VisualBridgeDebugRequest request, string reason)
        {
#if UNITY_EDITOR || VISUALBRIDGE_RUNTIME_BRIDGE
            return VisualBridgeDebugSession.RejectRequest(request, reason);
#else
            return false;
#endif
        }

        /// <summary>注册查询处理器；由生成的 Dispatcher 在 Register 时挂载（D4）。</summary>
        public static void RegisterRequestHandler(string category, string interfaceId, Delegate handler)
        {
#if UNITY_EDITOR || VISUALBRIDGE_RUNTIME_BRIDGE
            VisualBridgeDebugSession.RegisterRequestHandler(category, interfaceId, handler);
#endif
        }

        /// <summary>
        /// 注册查询处理器与它的参数声明表：生成 Dispatcher 的 <c>Register</c> 用这一组（D4）。
        /// <paramref name="parameterDecoder"/> 给出「方法号 → 参数名/tag/类型」，运行期据此把请求 args
        /// 按声明顺序解码；缺少它时只有无载荷参数的请求还能分发。
        /// </summary>
        public static void RegisterRequestHandler(string category, string interfaceId, Delegate handler,
            Delegate parameterDecoder)
        {
#if UNITY_EDITOR || VISUALBRIDGE_RUNTIME_BRIDGE
            VisualBridgeDebugSession.RegisterRequestHandler(category, interfaceId, handler, parameterDecoder);
#endif
        }

        /// <summary>显式挂接（Bridge 程序集）：重连后调用，按需 flush 待发描述。</summary>
        public static void Attach()
        {
#if UNITY_EDITOR || VISUALBRIDGE_RUNTIME_BRIDGE
            VisualBridgeDebugSession.Attach();
#endif
        }

        /// <summary>显式解除挂接：按断连语义重置快照、实例集合、槽位与待发队列。</summary>
        public static void Detach()
        {
#if UNITY_EDITOR || VISUALBRIDGE_RUNTIME_BRIDGE
            VisualBridgeDebugSession.Detach();
#endif
        }

        /// <summary>
        /// 结束当前消息并把「完整载荷 + 目标队列」描述交给数据队列。返回 false 表示没有可结束的消息、
        /// 调用线程不是 Start 线程、载荷编码失败/超限、已断连，或连接在 Start/End 之间换了代（此时载荷按旧会话丢弃）。
        /// </summary>
        public static bool End()
        {
#if UNITY_EDITOR || VISUALBRIDGE_RUNTIME_BRIDGE
            return VisualBridgeDebugSession.End();
#else
            return false;
#endif
        }

        // PushParam 只有这一组重载（附录 B.2）：收窄类型由生成代码显式转换。
        // 默认值在编码前跳过，调用方可以无条件压入全部参数。
        // 必须与对应消息的 Start 在同一线程调用；其它线程的调用被忽略并计入跨线程计数。

        public static void PushParam(string name, ushort tag, bool value)
        {
#if UNITY_EDITOR || VISUALBRIDGE_RUNTIME_BRIDGE
            if (value)
            {
                VisualBridgeDebugSession.PushParam(name, tag, value);
            }
#endif
        }

        public static void PushParam(string name, ushort tag, int value)
        {
#if UNITY_EDITOR || VISUALBRIDGE_RUNTIME_BRIDGE
            if (value != 0)
            {
                VisualBridgeDebugSession.PushParam(name, tag, value);
            }
#endif
        }

        public static void PushParam(string name, ushort tag, long value)
        {
#if UNITY_EDITOR || VISUALBRIDGE_RUNTIME_BRIDGE
            if (value != 0L)
            {
                VisualBridgeDebugSession.PushParam(name, tag, value);
            }
#endif
        }

        public static void PushParam(string name, ushort tag, ulong value)
        {
#if UNITY_EDITOR || VISUALBRIDGE_RUNTIME_BRIDGE
            if (value != 0UL)
            {
                VisualBridgeDebugSession.PushParam(name, tag, value);
            }
#endif
        }

        public static void PushParam(string name, ushort tag, float value)
        {
#if UNITY_EDITOR || VISUALBRIDGE_RUNTIME_BRIDGE
            // 附录 A.4：float 默认值按位判断，只有 +0.0 是默认值，-0.0 必须写出（D3 的编码前置契约）。
            if (BitConverter.SingleToInt32Bits(value) != 0)
            {
                VisualBridgeDebugSession.PushParam(name, tag, value);
            }
#endif
        }

        public static void PushParam(string name, ushort tag, double value)
        {
#if UNITY_EDITOR || VISUALBRIDGE_RUNTIME_BRIDGE
            // 附录 A.4：double 默认值按位判断，只有 +0.0 是默认值，-0.0 必须写出（D3 的编码前置契约）。
            if (BitConverter.DoubleToInt64Bits(value) != 0L)
            {
                VisualBridgeDebugSession.PushParam(name, tag, value);
            }
#endif
        }

        public static void PushParam(string name, ushort tag, Enum value)
        {
#if UNITY_EDITOR || VISUALBRIDGE_RUNTIME_BRIDGE
            if (!IsDefaultEnumValue(value))
            {
                VisualBridgeDebugSession.PushParam(name, tag, value);
            }
#endif
        }

        public static void PushParam(string name, ushort tag, string value)
        {
#if UNITY_EDITOR || VISUALBRIDGE_RUNTIME_BRIDGE
            if (!string.IsNullOrEmpty(value))
            {
                VisualBridgeDebugSession.PushParam(name, tag, value);
            }
#endif
        }

        public static void PushParam(string name, ushort tag, byte[] value)
        {
#if UNITY_EDITOR || VISUALBRIDGE_RUNTIME_BRIDGE
            if (value != null && value.Length != 0)
            {
                VisualBridgeDebugSession.PushParam(name, tag, value);
            }
#endif
        }

#if UNITY_EDITOR || VISUALBRIDGE_RUNTIME_BRIDGE
        /// <summary>枚举默认值 = 底层整型 0；按底层类型的有无符号分别比较，避免 Convert 在 ulong 上溢出。</summary>
        private static bool IsDefaultEnumValue(Enum value)
        {
            if (value == null)
            {
                return true;
            }

            switch (Type.GetTypeCode(Enum.GetUnderlyingType(value.GetType())))
            {
                case TypeCode.Byte:
                case TypeCode.UInt16:
                case TypeCode.UInt32:
                case TypeCode.UInt64:
                    return Convert.ToUInt64(value) == 0UL;
                case TypeCode.SByte:
                case TypeCode.Int16:
                case TypeCode.Int32:
                case TypeCode.Int64:
                    return Convert.ToInt64(value) == 0L;
                default:
                    return false;
            }
        }
#endif
    }
}
