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
    /// 一个 Graph 执行实例（graphExecutionInstance）：游戏侧某个执行者
    /// （debugKey）对一张图文档的一次运行；executionId 由采集门面分配。
    /// 同时是 getGraphExecutionSnapshot 的浅快照载荷（当前节点 + 运行
    /// 状态，不含变量池 dump）。
    /// </summary>
    public sealed class VisualBridgeRuntimeGraphExecutionInstance
    {
        public string ExecutionId { get; internal set; }

        public string DocumentTypeId { get; internal set; }

        public string DocumentId { get; internal set; }

        public string GraphName { get; internal set; }

        public string DebugKey { get; internal set; }

        public string State { get; internal set; }

        /// <summary>当前节点的稳定 ID；无当前节点时为 null。</summary>
        public string CurrentNodeId { get; internal set; }

        public int FrameIndex { get; internal set; }

        internal JObject ToJson()
        {
            return new JObject
            {
                ["executionId"] = ExecutionId,
                ["documentTypeId"] = DocumentTypeId,
                ["documentId"] = DocumentId,
                ["graphName"] = GraphName,
                ["debugKey"] = DebugKey,
                ["state"] = State,
                ["currentNodeId"] = CurrentNodeId == null ? JValue.CreateNull() : new JValue(CurrentNodeId),
                ["frameIndex"] = FrameIndex,
            };
        }
    }

    /// <summary>
    /// 单条 Graph 执行观察事件（graphExecutionEvent）；NodeId 是
    /// VisualBridge 文档的稳定节点 ID，字段出现与事件类型耦合。
    /// </summary>
    public sealed class VisualBridgeRuntimeGraphExecutionEvent
    {
        public string ExecutionId { get; internal set; }

        public int FrameIndex { get; internal set; }

        public string Kind { get; internal set; }

        /// <summary>实例生命周期事件不带节点。</summary>
        public string NodeId { get; internal set; }

        /// <summary>仅 nodeOutput / edgeValueChanged 携带。</summary>
        public int? OutputIndex { get; internal set; }

        /// <summary>仅 edgeValueChanged 携带（引擎侧字符串化的值）。</summary>
        public string Value { get; internal set; }

        internal JObject ToJson()
        {
            var value = new JObject
            {
                ["executionId"] = ExecutionId,
                ["frameIndex"] = FrameIndex,
                ["kind"] = Kind,
            };
            if (NodeId != null)
            {
                value["nodeId"] = NodeId;
            }

            if (OutputIndex.HasValue)
            {
                value["outputIndex"] = OutputIndex.Value;
            }

            if (Value != null)
            {
                value["value"] = Value;
            }

            return value;
        }
    }

    /// <summary>
    /// 已通过校验的 Runtime Bridge 消息；wire 校验在填充本模型之前
    /// 由 <see cref="VisualBridgeRuntimeBridgeValidator"/> 完成。
    /// </summary>
    public sealed class VisualBridgeRuntimeBridgeMessage
    {
        public VisualBridgeRuntimeBridgeMessageType Type { get; internal set; }

        public int ProtocolVersion { get; internal set; }

        public int CoreVersion { get; internal set; }

        public string Token { get; internal set; }

        public string ClientInstanceId { get; internal set; }

        public string InstanceId { get; internal set; }

        public string Kind { get; internal set; }

        public int Generation { get; internal set; }

        public string StartedAt { get; internal set; }

        public IReadOnlyList<string> Capabilities { get; internal set; }

        public string RequestId { get; internal set; }

        public string Action { get; internal set; }

        public IReadOnlyList<string> DocumentTypeIds { get; internal set; }

        /// <summary>getGraphExecutionInstances 的可选图文档过滤。</summary>
        public string DocumentId { get; internal set; }

        /// <summary>subscribe/unsubscribe/getGraphExecutionSnapshot 的执行实例 ID。</summary>
        public string ExecutionId { get; internal set; }

        public bool IsOk { get; internal set; }

        public IReadOnlyList<VisualBridgeRuntimeDocumentSnapshot> Documents { get; internal set; }

        public IReadOnlyList<VisualBridgeRuntimeDocumentSource> Sources { get; internal set; }

        /// <summary>getGraphExecutionInstances ok 响应的实例列表。</summary>
        public IReadOnlyList<VisualBridgeRuntimeGraphExecutionInstance> Executions { get; internal set; }

        /// <summary>getGraphExecutionSnapshot ok 响应的浅快照。</summary>
        public VisualBridgeRuntimeGraphExecutionInstance Execution { get; internal set; }

        /// <summary>graphExecution 事件的批量载荷。</summary>
        public IReadOnlyList<VisualBridgeRuntimeGraphExecutionEvent> ExecutionEvents { get; internal set; }

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
