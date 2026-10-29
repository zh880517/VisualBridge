using System;
using System.Collections.Generic;
using System.IO;
using System.Text.RegularExpressions;
using Newtonsoft.Json.Linq;

namespace VisualBridge.Runtime
{
    /// <summary>
    /// Runtime Bridge 严格校验失败。Code 取值：
    /// wire 错误码（Schema errorCode 枚举，可直接回发给对端）加上
    /// 仅限加载器内部的 runtime.missingProperty / runtime.unknownProperty
    /// ——后两者不是 wire 错误码，服务端回发前必须经
    /// <see cref="VisualBridgeRuntimeBridgeValidator.MapWireCode"/> 折叠为 runtime.invalidMessage。
    /// </summary>
    public sealed class VisualBridgeRuntimeBridgeException : Exception
    {
        public VisualBridgeRuntimeBridgeException(string code, string path, string message)
            : base($"{code} at {path}: {message}")
        {
            Code = code;
            JsonPath = path;
        }

        public string Code { get; }

        public string JsonPath { get; }
    }

    public enum VisualBridgeRuntimeBridgeMessageType
    {
        Hello,
        Welcome,
        Request,
        Response,
        Event,
        Error,
    }

    /// <summary>
    /// 快照中的单个编译产物；同时是 ArtifactStore 的输出单元与
    /// response/event 消息 documents 数组的元素。Sources 暴露该文档的
    /// Authoring 源映射（非 table 域来自产物 inputs.document；table 域
    /// 来自同名 .vbsource.json 映射产物），不进入 documents 的 wire 形状。
    /// </summary>
    public sealed class VisualBridgeRuntimeDocumentSnapshot
    {
        public string DocumentTypeId { get; internal set; }

        public string DocumentId { get; internal set; }

        public string Kind { get; internal set; }

        public JObject Data { get; internal set; }

        public IReadOnlyList<VisualBridgeRuntimeDocumentSource> Sources { get; internal set; }

        internal JObject ToJson()
        {
            return new JObject
            {
                ["documentTypeId"] = DocumentTypeId,
                ["documentId"] = DocumentId,
                ["kind"] = Kind,
                ["data"] = Data,
            };
        }
    }

    /// <summary>
    /// 单个运行中文档的 Authoring 源映射（documentSource）：
    /// 源相对路径 + 内容 SHA-256，供 VS Code 侧做漂移检测。
    /// </summary>
    public sealed class VisualBridgeRuntimeDocumentSource
    {
        public string DocumentTypeId { get; internal set; }

        public string DocumentId { get; internal set; }

        public string SourcePath { get; internal set; }

        public string SourceSha256 { get; internal set; }

        internal JObject ToJson()
        {
            return new JObject
            {
                ["documentTypeId"] = DocumentTypeId,
                ["documentId"] = DocumentId,
                ["sourcePath"] = SourcePath,
                ["sourceSha256"] = SourceSha256,
            };
        }
    }

    /// <summary>
    /// 一个 Graph 执行实例：游戏侧某个执行者（debugKey）对一张图文档的一次运行；
    /// executionId 由采集门面分配，观察者用它把同一实例的调试事实串起来。
    /// </summary>
    public sealed class VisualBridgeRuntimeGraphExecutionInstance
    {
        public string ExecutionId { get; internal set; }

        public string DocumentTypeId { get; internal set; }

        public string DocumentId { get; internal set; }

        public string GraphName { get; internal set; }

        public string DebugKey { get; internal set; }

        /// <summary>
        /// 当前无读者（恒为 "running"）；保留为公开数据模型（供未来观察者/诊断使用）。
        /// </summary>
        public string State { get; internal set; }

        /// <summary>
        /// 当前无读者；保留为公开数据模型（供未来观察者/诊断使用）。
        /// **不是**「补发时要用」的字段——观察者补发只读 <see cref="FrameIndex"/>，
        /// 且停追踪会清空实例注册表。
        /// </summary>
        public string CurrentNodeId { get; internal set; }

        public int FrameIndex { get; internal set; }
    }

    /// <summary>
    /// 已通过校验的 Runtime Bridge 消息；wire 校验在填充本模型之前
    /// 由 <see cref="VisualBridgeRuntimeBridgeValidator"/> 完成。
    /// </summary>
    public sealed class VisualBridgeRuntimeBridgeMessage
    {
        public VisualBridgeRuntimeBridgeMessageType Type { get; internal set; }

        public int ProtocolVersion { get; internal set; }

        /// <summary>hello：拨号方身份（Runtime 腿恒为 vscode）。</summary>
        public string Role { get; internal set; }

        /// <summary>hello：拨号方端点标识（不是调试实例 id）。</summary>
        public string ClientEndpointId { get; internal set; }

        /// <summary>hello：token；Player 无认证时为空。</summary>
        public string Token { get; internal set; }

        /// <summary>hello / welcome：调试契约指纹（16 位小写十六进制，无契约时为空串）。</summary>
        public string ContractHash { get; internal set; }

        /// <summary>hello / welcome：协商的载荷集合；json 必选。</summary>
        public IReadOnlyList<string> Payloads { get; internal set; }

        /// <summary>hello：调试分类筛选（空/缺省 = 全部）。</summary>
        public IReadOnlyList<string> DebugCategories { get; internal set; }

        /// <summary>hello：调试实例筛选（空/缺省 = 全部）。</summary>
        public IReadOnlyList<string> DebugInstances { get; internal set; }

        /// <summary>hello：Domain Reload 后的续接会话 id。</summary>
        public string ResumeSessionId { get; internal set; }

        /// <summary>welcome：监听方端点标识（= editor-&lt;pid&gt; / player-&lt;pid&gt;）。</summary>
        public string EndpointId { get; internal set; }

        /// <summary>welcome：endpointId#bootId，跨 Domain Reload 稳定。</summary>
        public string SessionId { get; internal set; }

        /// <summary>welcome：本次是否续接了 hello 的 resumeSessionId。</summary>
        public bool Resumed { get; internal set; }

        /// <summary>welcome：editor-player / player。</summary>
        public string ConnectType { get; internal set; }

        /// <summary>welcome：每次传输建立 +1，不参与 sessionId。</summary>
        public int Generation { get; internal set; }

        /// <summary>welcome：每次进程启动随机。</summary>
        public string BootId { get; internal set; }

        /// <summary>welcome：debug 总开关当前值。</summary>
        public bool DebugEnabled { get; internal set; }

        public string StartedAt { get; internal set; }

        public string RequestId { get; internal set; }

        public string Action { get; internal set; }

        public IReadOnlyList<string> DocumentTypeIds { get; internal set; }

        public bool IsOk { get; internal set; }

        public IReadOnlyList<VisualBridgeRuntimeDocumentSnapshot> Documents { get; internal set; }

        public IReadOnlyList<VisualBridgeRuntimeDocumentSource> Sources { get; internal set; }

        public string EventName { get; internal set; }

        public string ErrorCode { get; internal set; }

        public string ErrorDetail { get; internal set; }

        public JObject ToJson()
        {
            return VisualBridgeRuntimeBridgeValidator.SerializeMessage(this);
        }

        public string ToLine()
        {
            return ToJson().ToString(Newtonsoft.Json.Formatting.None);
        }
    }
}
