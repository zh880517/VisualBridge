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

    /// <summary>
    /// Runtime Bridge V1 消息与发现记录的严格 JSON 校验器。
    /// 与 Protocol/Schema/visualbridge-runtime-bridge.schema.json 保持镜像；
    /// 共享 parity fixture 同时由 AJV（generator）、Unity EditMode 测试
    /// 与扩展宿主测试执行。JSON 解析固定 DateParseHandling.None +
    /// FloatParseHandling.Decimal（Editor Bridge 同款教训：禁止日期伪装与浮点精度漂移）。
    /// </summary>
    public static class VisualBridgeRuntimeBridgeValidator
    {
        public const int ProtocolVersion = 1;
        public const int CoreVersion = 1;
        public const int DiscoveryFormatVersion = 1;

        private static readonly Regex StableIdPattern = new Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$", RegexOptions.Compiled);
        private static readonly Regex TokenPattern = new Regex("^[0-9a-f]{48,64}$", RegexOptions.Compiled);
        private static readonly Regex UuidPattern = new Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", RegexOptions.Compiled | RegexOptions.IgnoreCase);
        private static readonly Regex InstanceIdPattern = new Regex("^(editor|player)-[0-9]+$", RegexOptions.Compiled);
        private static readonly Regex CompiledKindPattern = new Regex("^visualbridge\\.(structured|entity|table|graph)\\.compiled$", RegexOptions.Compiled);
        private static readonly Regex StartedAtPattern = new Regex("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$", RegexOptions.Compiled);
        // normalizedPath 语义（primitives Schema）：无前导/、无盘符冒号、无反斜杠、
        // 无点段（./ ../）、无重复斜杠、无尾斜杠。
        private static readonly Regex NormalizedPathPattern = new Regex("^(?!/)(?!.*:)(?!.*\\\\)(?!.*(?:^|/)\\.{1,2}(?:/|$))(?!.*//)(?!.*/$).+$", RegexOptions.Compiled);
        private static readonly Regex Sha256Pattern = new Regex("^[a-f0-9]{64}$", RegexOptions.Compiled);
        private static readonly Regex ExecutionIdPattern = new Regex("^exec-[0-9]+$", RegexOptions.Compiled);

        private static readonly HashSet<string> Capabilities = new HashSet<string>(StringComparer.Ordinal) { "snapshot", "events", "lease", "sources", "graphExecution" };
        private static readonly HashSet<string> InstanceKinds = new HashSet<string>(StringComparer.Ordinal) { "editor-play", "player" };
        private static readonly HashSet<string> RequestActions = new HashSet<string>(StringComparer.Ordinal)
        {
            "getSnapshot",
            "acquireLease",
            "releaseLease",
            "getDocumentSources",
            "getGraphExecutionInstances",
            "subscribeGraphExecution",
            "unsubscribeGraphExecution",
            "getGraphExecutionSnapshot",
        };

        private static readonly HashSet<string> GraphExecutionStates = new HashSet<string>(StringComparer.Ordinal) { "running", "stopped" };
        private static readonly HashSet<string> GraphExecutionEventKinds = new HashSet<string>(StringComparer.Ordinal)
        {
            "instanceStarted",
            "instanceStopped",
            "nodeStart",
            "nodeOutput",
            "dataNode",
            "edgeValueChanged",
        };

        private static readonly HashSet<string> ErrorCodes = new HashSet<string>(StringComparer.Ordinal)
        {
            "runtime.capabilityMissing",
            "runtime.executionNotFound",
            "runtime.internalError",
            "runtime.invalidJson",
            "runtime.invalidMessage",
            "runtime.invalidToken",
            "runtime.leaseDenied",
            "runtime.leaseNotHeld",
            "runtime.leaseRequired",
            "runtime.protocolVersionMismatch",
            "runtime.unknownMessageType",
            "runtime.unknownRequest",
        };

        /// <summary>解析并校验一行 NDJSON 消息；非法 JSON 报 runtime.invalidJson。</summary>
        public static VisualBridgeRuntimeBridgeMessage ParseMessage(string line)
        {
            return ValidateMessage(ParseObject(line, "runtime.invalidJson"));
        }

        /// <summary>校验一条已解析的消息对象。</summary>
        public static VisualBridgeRuntimeBridgeMessage ValidateMessage(JObject value)
        {
            if (value == null)
            {
                throw Error("runtime.invalidMessage", "$", "Expected a message object.");
            }

            var typeToken = value["type"];
            if (typeToken == null || typeToken.Type != JTokenType.String)
            {
                throw Error("runtime.missingProperty", "$.type", "Expected a message 'type' string.");
            }

            var type = typeToken.Value<string>();
            switch (type)
            {
                case "hello": return ValidateHello(value);
                case "welcome": return ValidateWelcome(value);
                case "request": return ValidateRequest(value);
                case "response": return ValidateResponse(value);
                case "event": return ValidateEvent(value);
                case "error": return ValidateError(value);
                default:
                    throw Error("runtime.unknownMessageType", "$.type", $"Unknown message type '{type}'.");
            }
        }

        /// <summary>解析并校验一份发现记录文本；非法 JSON 报 runtime.invalidJson。</summary>
        public static VisualBridgeRuntimeInstance ParseDiscoveryRecord(string text)
        {
            return ValidateDiscoveryRecord(ParseObject(text, "runtime.invalidJson"));
        }

        /// <summary>校验一份已解析的发现记录。多余键报 runtime.unknownProperty，其余违规一律 runtime.invalidMessage（fixture 冻结）。</summary>
        public static VisualBridgeRuntimeInstance ValidateDiscoveryRecord(JObject value)
        {
            if (value == null)
            {
                throw Error("runtime.invalidMessage", "$", "Expected a discovery record object.");
            }

            RequireOnlyDiscoveryKeys(value);
            var formatVersion = RequireInteger(value, "formatVersion", "$.formatVersion");
            if (formatVersion != DiscoveryFormatVersion)
            {
                throw Error("runtime.invalidMessage", "$.formatVersion", $"Expected formatVersion {DiscoveryFormatVersion}.");
            }

            var protocolVersion = RequireInteger(value, "protocolVersion", "$.protocolVersion");
            if (protocolVersion != ProtocolVersion)
            {
                throw Error("runtime.invalidMessage", "$.protocolVersion", $"Expected protocolVersion {ProtocolVersion}.");
            }

            var coreVersion = RequireInteger(value, "coreVersion", "$.coreVersion");
            if (coreVersion != CoreVersion)
            {
                throw Error("runtime.invalidMessage", "$.coreVersion", $"Expected coreVersion {CoreVersion}.");
            }

            var instanceId = RequireString(value, "instanceId", "$.instanceId");
            if (!InstanceIdPattern.IsMatch(instanceId))
            {
                throw Error("runtime.invalidMessage", "$.instanceId", "Expected an 'editor-<pid>' or 'player-<pid>' instance identifier.");
            }

            var kind = RequireString(value, "kind", "$.kind");
            if (!InstanceKinds.Contains(kind))
            {
                throw Error("runtime.invalidMessage", "$.kind", "Expected instance kind 'editor-play' or 'player'.");
            }

            var capabilities = RequireCapabilities(value, "$.capabilities");
            var tcpPort = RequireInteger(value, "tcpPort", "$.tcpPort");
            if (tcpPort < 1 || tcpPort > 65535)
            {
                throw Error("runtime.invalidMessage", "$.tcpPort", "Expected a TCP port between 1 and 65535.");
            }

            var token = RequireString(value, "token", "$.token");
            if (!TokenPattern.IsMatch(token))
            {
                throw Error("runtime.invalidToken", "$.token", "Expected a hex authentication token.");
            }

            var pid = RequireInteger(value, "pid", "$.pid");
            if (pid < 1)
            {
                throw Error("runtime.invalidMessage", "$.pid", "Expected a positive process id.");
            }

            var generation = RequireInteger(value, "generation", "$.generation");
            if (generation < 1)
            {
                throw Error("runtime.invalidMessage", "$.generation", "Expected a positive instance generation.");
            }

            var startedAtText = RequireString(value, "startedAt", "$.startedAt");
            if (!IsUtcDateTime(startedAtText))
            {
                throw Error("runtime.invalidMessage", "$.startedAt", "Expected a UTC ISO date-time.");
            }

            return new VisualBridgeRuntimeInstance
            {
                InstanceId = instanceId,
                Kind = kind,
                ProtocolVersion = protocolVersion,
                CoreVersion = coreVersion,
                Capabilities = capabilities,
                TcpPort = tcpPort,
                Token = token,
                Pid = pid,
                Generation = generation,
                StartedAt = startedAtText,
            };
        }

        /// <summary>序列化消息；输出必须通过与 wire 输入相同的严格校验。</summary>
        public static JObject SerializeMessage(VisualBridgeRuntimeBridgeMessage message)
        {
            if (message == null)
            {
                throw Error("runtime.invalidMessage", "$", "Cannot serialize a null message.");
            }

            var value = new JObject();
            switch (message.Type)
            {
                case VisualBridgeRuntimeBridgeMessageType.Hello:
                    value["type"] = "hello";
                    value["protocolVersion"] = message.ProtocolVersion;
                    value["coreVersion"] = message.CoreVersion;
                    value["token"] = message.Token;
                    value["clientInstanceId"] = message.ClientInstanceId;
                    value["capabilities"] = new JArray(message.Capabilities);
                    break;
                case VisualBridgeRuntimeBridgeMessageType.Welcome:
                    value["type"] = "welcome";
                    value["protocolVersion"] = message.ProtocolVersion;
                    value["coreVersion"] = message.CoreVersion;
                    value["instanceId"] = message.InstanceId;
                    value["kind"] = message.Kind;
                    value["generation"] = message.Generation;
                    value["capabilities"] = new JArray(message.Capabilities);
                    value["startedAt"] = message.StartedAt;
                    break;
                case VisualBridgeRuntimeBridgeMessageType.Request:
                    value["type"] = "request";
                    value["requestId"] = message.RequestId;
                    value["action"] = message.Action;
                    if (message.DocumentTypeIds != null)
                    {
                        value["documentTypeIds"] = new JArray(message.DocumentTypeIds);
                    }
                    if (message.DocumentId != null)
                    {
                        value["documentId"] = message.DocumentId;
                    }
                    if (message.ExecutionId != null)
                    {
                        value["executionId"] = message.ExecutionId;
                    }
                    break;
                case VisualBridgeRuntimeBridgeMessageType.Response:
                    value["type"] = "response";
                    value["requestId"] = message.RequestId;
                    value["status"] = message.IsOk ? "ok" : "error";
                    if (message.IsOk)
                    {
                        // documents / sources / executions / execution 互斥；都缺省为
                        // 租约与订阅控制的 ok（无载荷）。
                        if (message.Sources != null)
                        {
                            var sources = new JArray();
                            foreach (var source in message.Sources)
                            {
                                sources.Add(source.ToJson());
                            }

                            value["sources"] = sources;
                        }
                        else if (message.Documents != null)
                        {
                            var documents = new JArray();
                            foreach (var document in message.Documents)
                            {
                                documents.Add(document.ToJson());
                            }

                            value["documents"] = documents;
                        }
                        else if (message.Executions != null)
                        {
                            var executions = new JArray();
                            foreach (var execution in message.Executions)
                            {
                                executions.Add(execution.ToJson());
                            }

                            value["executions"] = executions;
                        }
                        else if (message.Execution != null)
                        {
                            value["execution"] = message.Execution.ToJson();
                        }
                    }
                    else
                    {
                        value["error"] = message.ErrorCode;
                        if (message.ErrorDetail != null)
                        {
                            value["detail"] = message.ErrorDetail;
                        }
                    }
                    break;
                case VisualBridgeRuntimeBridgeMessageType.Event:
                    value["type"] = "event";
                    value["event"] = message.EventName;
                    if (message.EventName == "graphExecution")
                    {
                        var executionEvents = new JArray();
                        foreach (var executionEvent in message.ExecutionEvents ?? Array.Empty<VisualBridgeRuntimeGraphExecutionEvent>())
                        {
                            executionEvents.Add(executionEvent.ToJson());
                        }

                        value["executionEvents"] = executionEvents;
                    }
                    else
                    {
                        var eventDocuments = new JArray();
                        foreach (var document in message.Documents ?? Array.Empty<VisualBridgeRuntimeDocumentSnapshot>())
                        {
                            eventDocuments.Add(document.ToJson());
                        }

                        value["documents"] = eventDocuments;
                    }

                    break;
                case VisualBridgeRuntimeBridgeMessageType.Error:
                    value["type"] = "error";
                    value["code"] = message.ErrorCode;
                    if (message.ErrorDetail != null)
                    {
                        value["detail"] = message.ErrorDetail;
                    }
                    break;
                default:
                    throw Error("runtime.invalidMessage", "$.type", "Cannot serialize an unknown message type.");
            }

            ValidateMessage(value);
            return value;
        }

        /// <summary>加载器错误码是否可作为 wire 错误码回发（Schema errorCode 枚举成员）。</summary>
        public static bool IsWireErrorCode(string code)
        {
            return code != null && ErrorCodes.Contains(code);
        }

        /// <summary>把校验错误码折叠为可回发的 wire 错误码；missingProperty/unknownProperty 等 loader 专属码折叠为 invalidMessage。</summary>
        public static string MapWireCode(string code)
        {
            return IsWireErrorCode(code) ? code : "runtime.invalidMessage";
        }

        public static VisualBridgeRuntimeBridgeMessage CreateHello(string clientInstanceId, string token, IReadOnlyList<string> capabilities)
        {
            return new VisualBridgeRuntimeBridgeMessage
            {
                Type = VisualBridgeRuntimeBridgeMessageType.Hello,
                ProtocolVersion = ProtocolVersion,
                CoreVersion = CoreVersion,
                Token = token,
                ClientInstanceId = clientInstanceId,
                Capabilities = capabilities,
            };
        }

        public static VisualBridgeRuntimeBridgeMessage CreateWelcome(string instanceId, string kind, int generation, IReadOnlyList<string> capabilities, string startedAt)
        {
            return new VisualBridgeRuntimeBridgeMessage
            {
                Type = VisualBridgeRuntimeBridgeMessageType.Welcome,
                ProtocolVersion = ProtocolVersion,
                CoreVersion = CoreVersion,
                InstanceId = instanceId,
                Kind = kind,
                Generation = generation,
                Capabilities = capabilities,
                StartedAt = startedAt,
            };
        }

        public static VisualBridgeRuntimeBridgeMessage CreateSnapshotRequest(string requestId, IReadOnlyList<string> documentTypeIds)
        {
            return new VisualBridgeRuntimeBridgeMessage
            {
                Type = VisualBridgeRuntimeBridgeMessageType.Request,
                RequestId = requestId,
                Action = "getSnapshot",
                DocumentTypeIds = documentTypeIds,
            };
        }

        /// <summary>租约请求（action 限定 acquireLease/releaseLease，不带 documentTypeIds）。</summary>
        public static VisualBridgeRuntimeBridgeMessage CreateLeaseRequest(string requestId, string action)
        {
            if (action != "acquireLease" && action != "releaseLease")
            {
                throw new ArgumentException("Lease request action must be 'acquireLease' or 'releaseLease'.", nameof(action));
            }

            return new VisualBridgeRuntimeBridgeMessage
            {
                Type = VisualBridgeRuntimeBridgeMessageType.Request,
                RequestId = requestId,
                Action = action,
            };
        }

        /// <summary>getDocumentSources 请求（不带 documentTypeIds）。</summary>
        public static VisualBridgeRuntimeBridgeMessage CreateSourcesRequest(string requestId)
        {
            return new VisualBridgeRuntimeBridgeMessage
            {
                Type = VisualBridgeRuntimeBridgeMessageType.Request,
                RequestId = requestId,
                Action = "getDocumentSources",
            };
        }

        /// <summary>租约 ok 响应：无 documents/sources 载荷。</summary>
        public static VisualBridgeRuntimeBridgeMessage CreateLeaseResponse(string requestId)
        {
            return new VisualBridgeRuntimeBridgeMessage
            {
                Type = VisualBridgeRuntimeBridgeMessageType.Response,
                RequestId = requestId,
                IsOk = true,
            };
        }

        /// <summary>getDocumentSources ok 响应：仅携带 sources 数组。</summary>
        public static VisualBridgeRuntimeBridgeMessage CreateSourcesResponse(string requestId, IReadOnlyList<VisualBridgeRuntimeDocumentSource> sources)
        {
            return new VisualBridgeRuntimeBridgeMessage
            {
                Type = VisualBridgeRuntimeBridgeMessageType.Response,
                RequestId = requestId,
                IsOk = true,
                Sources = sources,
            };
        }

        public static VisualBridgeRuntimeBridgeMessage CreateSnapshotResponseOk(string requestId, IReadOnlyList<VisualBridgeRuntimeDocumentSnapshot> documents)
        {
            return new VisualBridgeRuntimeBridgeMessage
            {
                Type = VisualBridgeRuntimeBridgeMessageType.Response,
                RequestId = requestId,
                IsOk = true,
                Documents = documents,
            };
        }

        /// <summary>请求级 error 响应（任意 runtime.* wire 错误码）。</summary>
        public static VisualBridgeRuntimeBridgeMessage CreateResponseError(string requestId, string errorCode, string detail)
        {
            return new VisualBridgeRuntimeBridgeMessage
            {
                Type = VisualBridgeRuntimeBridgeMessageType.Response,
                RequestId = requestId,
                IsOk = false,
                ErrorCode = errorCode,
                ErrorDetail = detail,
            };
        }

        public static VisualBridgeRuntimeBridgeMessage CreateArtifactsChangedEvent(IReadOnlyList<VisualBridgeRuntimeDocumentSnapshot> documents)
        {
            return new VisualBridgeRuntimeBridgeMessage
            {
                Type = VisualBridgeRuntimeBridgeMessageType.Event,
                EventName = "artifactsChanged",
                Documents = documents,
            };
        }

        /// <summary>getGraphExecutionInstances 请求；documentId 过滤可空。</summary>
        public static VisualBridgeRuntimeBridgeMessage CreateGraphExecutionInstancesRequest(string requestId, string documentId)
        {
            return new VisualBridgeRuntimeBridgeMessage
            {
                Type = VisualBridgeRuntimeBridgeMessageType.Request,
                RequestId = requestId,
                Action = "getGraphExecutionInstances",
                DocumentId = documentId,
            };
        }

        /// <summary>subscribe/unsubscribeGraphExecution 请求（必须携带 executionId）。</summary>
        public static VisualBridgeRuntimeBridgeMessage CreateGraphExecutionSubscriptionRequest(string requestId, string action, string executionId)
        {
            if (action != "subscribeGraphExecution" && action != "unsubscribeGraphExecution")
            {
                throw new ArgumentException("Subscription action must be 'subscribeGraphExecution' or 'unsubscribeGraphExecution'.", nameof(action));
            }

            return new VisualBridgeRuntimeBridgeMessage
            {
                Type = VisualBridgeRuntimeBridgeMessageType.Request,
                RequestId = requestId,
                Action = action,
                ExecutionId = executionId,
            };
        }

        /// <summary>getGraphExecutionSnapshot 请求（浅快照）。</summary>
        public static VisualBridgeRuntimeBridgeMessage CreateGraphExecutionSnapshotRequest(string requestId, string executionId)
        {
            return new VisualBridgeRuntimeBridgeMessage
            {
                Type = VisualBridgeRuntimeBridgeMessageType.Request,
                RequestId = requestId,
                Action = "getGraphExecutionSnapshot",
                ExecutionId = executionId,
            };
        }

        /// <summary>getGraphExecutionInstances ok 响应：仅携带 executions 数组。</summary>
        public static VisualBridgeRuntimeBridgeMessage CreateGraphExecutionInstancesResponse(string requestId, IReadOnlyList<VisualBridgeRuntimeGraphExecutionInstance> executions)
        {
            return new VisualBridgeRuntimeBridgeMessage
            {
                Type = VisualBridgeRuntimeBridgeMessageType.Response,
                RequestId = requestId,
                IsOk = true,
                Executions = executions,
            };
        }

        /// <summary>getGraphExecutionSnapshot ok 响应：仅携带 execution 浅快照。</summary>
        public static VisualBridgeRuntimeBridgeMessage CreateGraphExecutionSnapshotResponse(string requestId, VisualBridgeRuntimeGraphExecutionInstance execution)
        {
            return new VisualBridgeRuntimeBridgeMessage
            {
                Type = VisualBridgeRuntimeBridgeMessageType.Response,
                RequestId = requestId,
                IsOk = true,
                Execution = execution,
            };
        }

        /// <summary>graphExecution 批量事件；载荷必须非空。</summary>
        public static VisualBridgeRuntimeBridgeMessage CreateGraphExecutionEvent(IReadOnlyList<VisualBridgeRuntimeGraphExecutionEvent> executionEvents)
        {
            if (executionEvents == null || executionEvents.Count == 0)
            {
                throw new ArgumentException("Graph execution event batches must not be empty.", nameof(executionEvents));
            }

            return new VisualBridgeRuntimeBridgeMessage
            {
                Type = VisualBridgeRuntimeBridgeMessageType.Event,
                EventName = "graphExecution",
                ExecutionEvents = executionEvents,
            };
        }

        public static VisualBridgeRuntimeBridgeMessage CreateError(string code, string detail)
        {
            return new VisualBridgeRuntimeBridgeMessage
            {
                Type = VisualBridgeRuntimeBridgeMessageType.Error,
                ErrorCode = code,
                ErrorDetail = detail,
            };
        }

        internal static VisualBridgeRuntimeDocumentSnapshot ValidateDocumentSnapshot(JObject value, string path)
        {
            RequireOnlyKeys(value, path, "documentTypeId", "documentId", "kind", "data");
            var documentTypeId = RequireString(value, "documentTypeId", path + ".documentTypeId");
            if (!StableIdPattern.IsMatch(documentTypeId))
            {
                throw Error("runtime.invalidMessage", path + ".documentTypeId", "Expected a stable document type identifier.");
            }

            var documentId = RequireString(value, "documentId", path + ".documentId");
            if (!StableIdPattern.IsMatch(documentId))
            {
                throw Error("runtime.invalidMessage", path + ".documentId", "Expected a document identifier.");
            }

            var kind = RequireString(value, "kind", path + ".kind");
            if (!CompiledKindPattern.IsMatch(kind))
            {
                throw Error("runtime.invalidMessage", path + ".kind", "Expected a compiled artifact kind.");
            }

            if (!(value["data"] is JObject data))
            {
                throw Error("runtime.invalidMessage", path + ".data", "Expected an object payload.");
            }

            return new VisualBridgeRuntimeDocumentSnapshot
            {
                DocumentTypeId = documentTypeId,
                DocumentId = documentId,
                Kind = kind,
                Data = data,
            };
        }

        internal static VisualBridgeRuntimeDocumentSource ValidateDocumentSource(JObject value, string path)
        {
            RequireOnlyKeys(value, path, "documentTypeId", "documentId", "sourcePath", "sourceSha256");
            var documentTypeId = RequireString(value, "documentTypeId", path + ".documentTypeId");
            if (!StableIdPattern.IsMatch(documentTypeId))
            {
                throw Error("runtime.invalidMessage", path + ".documentTypeId", "Expected a stable document type identifier.");
            }

            var documentId = RequireString(value, "documentId", path + ".documentId");
            if (!StableIdPattern.IsMatch(documentId))
            {
                throw Error("runtime.invalidMessage", path + ".documentId", "Expected a document identifier.");
            }

            var sourcePath = RequireString(value, "sourcePath", path + ".sourcePath");
            if (sourcePath.Length > 1024 || !NormalizedPathPattern.IsMatch(sourcePath))
            {
                throw Error("runtime.invalidMessage", path + ".sourcePath", "Expected a normalized relative source path.");
            }

            var sourceSha256 = RequireString(value, "sourceSha256", path + ".sourceSha256");
            if (!Sha256Pattern.IsMatch(sourceSha256))
            {
                throw Error("runtime.invalidMessage", path + ".sourceSha256", "Expected a lowercase 64-hex SHA-256 digest.");
            }

            return new VisualBridgeRuntimeDocumentSource
            {
                DocumentTypeId = documentTypeId,
                DocumentId = documentId,
                SourcePath = sourcePath,
                SourceSha256 = sourceSha256,
            };
        }

        private static VisualBridgeRuntimeBridgeMessage ValidateHello(JObject value)
        {
            RequireOnlyKeys(value, "$", "type", "protocolVersion", "coreVersion", "token", "clientInstanceId", "capabilities");
            var protocolVersion = RequireVersion(value, "protocolVersion", "$.protocolVersion");
            var coreVersion = RequireVersion(value, "coreVersion", "$.coreVersion");
            var token = RequireString(value, "token", "$.token");
            if (!TokenPattern.IsMatch(token))
            {
                throw Error("runtime.invalidToken", "$.token", "Expected a hex authentication token of at least 192 bits.");
            }

            var clientInstanceId = RequireString(value, "clientInstanceId", "$.clientInstanceId");
            if (!UuidPattern.IsMatch(clientInstanceId))
            {
                throw Error("runtime.invalidMessage", "$.clientInstanceId", "Expected a UUID client instance identifier.");
            }

            return new VisualBridgeRuntimeBridgeMessage
            {
                Type = VisualBridgeRuntimeBridgeMessageType.Hello,
                ProtocolVersion = protocolVersion,
                CoreVersion = coreVersion,
                Token = token,
                ClientInstanceId = clientInstanceId,
                Capabilities = RequireCapabilities(value, "$.capabilities"),
            };
        }

        private static VisualBridgeRuntimeBridgeMessage ValidateWelcome(JObject value)
        {
            RequireOnlyKeys(value, "$", "type", "protocolVersion", "coreVersion", "instanceId", "kind", "generation", "capabilities", "startedAt");
            var protocolVersion = RequireVersion(value, "protocolVersion", "$.protocolVersion");
            var coreVersion = RequireVersion(value, "coreVersion", "$.coreVersion");
            var instanceId = RequireString(value, "instanceId", "$.instanceId");
            if (!InstanceIdPattern.IsMatch(instanceId))
            {
                throw Error("runtime.invalidMessage", "$.instanceId", "Expected an 'editor-<pid>' or 'player-<pid>' instance identifier.");
            }

            var kind = RequireString(value, "kind", "$.kind");
            if (!InstanceKinds.Contains(kind))
            {
                throw Error("runtime.invalidMessage", "$.kind", "Expected instance kind 'editor-play' or 'player'.");
            }

            var generation = RequireInteger(value, "generation", "$.generation");
            if (generation < 1)
            {
                throw Error("runtime.invalidMessage", "$.generation", "Expected a positive instance generation.");
            }

            var startedAtText = RequireString(value, "startedAt", "$.startedAt");
            if (!IsUtcDateTime(startedAtText))
            {
                throw Error("runtime.invalidMessage", "$.startedAt", "Expected a UTC ISO date-time.");
            }

            return new VisualBridgeRuntimeBridgeMessage
            {
                Type = VisualBridgeRuntimeBridgeMessageType.Welcome,
                ProtocolVersion = protocolVersion,
                CoreVersion = coreVersion,
                InstanceId = instanceId,
                Kind = kind,
                Generation = generation,
                StartedAt = startedAtText,
                Capabilities = RequireCapabilities(value, "$.capabilities"),
            };
        }

        private static VisualBridgeRuntimeBridgeMessage ValidateRequest(JObject value)
        {
            RequireOnlyKeys(value, "$", new[] { "type", "requestId", "action" }, new[] { "documentTypeIds", "documentId", "executionId" });
            var requestId = RequireRequestId(value);
            var actionToken = value["action"];
            if (actionToken == null)
            {
                throw Error("runtime.missingProperty", "$.action", "Missing property 'action'.");
            }

            if (actionToken.Type != JTokenType.String)
            {
                throw Error("runtime.invalidMessage", "$.action", "Expected an action string.");
            }

            var action = actionToken.Value<string>();
            if (!RequestActions.Contains(action))
            {
                throw Error("runtime.unknownRequest", "$.action", $"Unknown request action '{action}'.");
            }

            // 字段与动作耦合（Schema allOf）：documentTypeIds 仅 getSnapshot、
            // documentId 仅 getGraphExecutionInstances、executionId 仅执行订阅三动作。
            var filterToken = value["documentTypeIds"];
            if (filterToken != null && action != "getSnapshot")
            {
                throw Error("runtime.invalidMessage", "$.documentTypeIds", $"Action '{action}' must not carry documentTypeIds.");
            }

            var documentIdToken = value["documentId"];
            if (documentIdToken != null && action != "getGraphExecutionInstances")
            {
                throw Error("runtime.invalidMessage", "$.documentId", $"Action '{action}' must not carry documentId.");
            }

            var requiresExecutionId = action == "subscribeGraphExecution" || action == "unsubscribeGraphExecution" || action == "getGraphExecutionSnapshot";
            var executionIdToken = value["executionId"];
            if (executionIdToken != null && !requiresExecutionId)
            {
                throw Error("runtime.invalidMessage", "$.executionId", $"Action '{action}' must not carry executionId.");
            }

            if (requiresExecutionId)
            {
                if (executionIdToken == null)
                {
                    throw Error("runtime.missingProperty", "$.executionId", "Missing property 'executionId'.");
                }

                if (executionIdToken.Type != JTokenType.String || !ExecutionIdPattern.IsMatch(executionIdToken.Value<string>()))
                {
                    throw Error("runtime.invalidMessage", "$.executionId", "Expected an 'exec-<n>' execution identifier.");
                }

                return new VisualBridgeRuntimeBridgeMessage
                {
                    Type = VisualBridgeRuntimeBridgeMessageType.Request,
                    RequestId = requestId,
                    Action = action,
                    ExecutionId = executionIdToken.Value<string>(),
                };
            }

            if (action == "getGraphExecutionInstances")
            {
                string documentId = null;
                if (documentIdToken != null)
                {
                    if (documentIdToken.Type != JTokenType.String || !StableIdPattern.IsMatch(documentIdToken.Value<string>()))
                    {
                        throw Error("runtime.invalidMessage", "$.documentId", "Expected a graph document identifier.");
                    }

                    documentId = documentIdToken.Value<string>();
                }

                return new VisualBridgeRuntimeBridgeMessage
                {
                    Type = VisualBridgeRuntimeBridgeMessageType.Request,
                    RequestId = requestId,
                    Action = action,
                    DocumentId = documentId,
                };
            }

            IReadOnlyList<string> documentTypeIds = null;
            if (filterToken != null)
            {
                if (!(filterToken is JArray filter) || filter.Count == 0)
                {
                    throw Error("runtime.invalidMessage", "$.documentTypeIds", "Expected a non-empty document type filter array.");
                }

                var ids = new List<string>(filter.Count);
                var unique = new HashSet<string>(StringComparer.Ordinal);
                for (var index = 0; index < filter.Count; index++)
                {
                    if (filter[index].Type != JTokenType.String || !StableIdPattern.IsMatch(filter[index].Value<string>()))
                    {
                        throw Error("runtime.invalidMessage", $"$.documentTypeIds[{index}]", "Expected a stable document type identifier.");
                    }

                    if (!unique.Add(filter[index].Value<string>()))
                    {
                        throw Error("runtime.invalidMessage", $"$.documentTypeIds[{index}]", "Duplicate document type identifier.");
                    }

                    ids.Add(filter[index].Value<string>());
                }

                documentTypeIds = ids;
            }

            return new VisualBridgeRuntimeBridgeMessage
            {
                Type = VisualBridgeRuntimeBridgeMessageType.Request,
                RequestId = requestId,
                Action = action,
                DocumentTypeIds = documentTypeIds,
            };
        }

        private static VisualBridgeRuntimeBridgeMessage ValidateResponse(JObject value)
        {
            RequireOnlyKeys(value, "$", new[] { "type", "requestId", "status" }, new[] { "documents", "sources", "executions", "execution", "error", "detail" });
            var requestId = RequireRequestId(value);
            var statusToken = value["status"];
            if (statusToken == null)
            {
                throw Error("runtime.missingProperty", "$.status", "Missing property 'status'.");
            }

            if (statusToken.Type != JTokenType.String)
            {
                throw Error("runtime.invalidMessage", "$.status", "Expected a status string.");
            }

            var status = statusToken.Value<string>();
            if (status == "ok")
            {
                if (value.Property("error", StringComparison.Ordinal) != null || value.Property("detail", StringComparison.Ordinal) != null)
                {
                    throw Error("runtime.invalidMessage", "$", "An ok response must not carry error fields.");
                }

                // documents / sources / executions / execution 互斥；都缺省为
                // 租约与订阅控制的 ok（无载荷响应）。
                var hasDocuments = value.Property("documents", StringComparison.Ordinal) != null;
                var hasSources = value.Property("sources", StringComparison.Ordinal) != null;
                var hasExecutions = value.Property("executions", StringComparison.Ordinal) != null;
                var hasExecution = value.Property("execution", StringComparison.Ordinal) != null;
                var payloadCount = (hasDocuments ? 1 : 0) + (hasSources ? 1 : 0) + (hasExecutions ? 1 : 0) + (hasExecution ? 1 : 0);
                if (payloadCount > 1)
                {
                    throw Error("runtime.invalidMessage", "$", "An ok response must carry at most one payload shape.");
                }

                if (hasDocuments)
                {
                    return new VisualBridgeRuntimeBridgeMessage
                    {
                        Type = VisualBridgeRuntimeBridgeMessageType.Response,
                        RequestId = requestId,
                        IsOk = true,
                        Documents = ValidateDocuments(value["documents"], "$.documents"),
                    };
                }

                if (hasSources)
                {
                    return new VisualBridgeRuntimeBridgeMessage
                    {
                        Type = VisualBridgeRuntimeBridgeMessageType.Response,
                        RequestId = requestId,
                        IsOk = true,
                        Sources = ValidateSources(value["sources"], "$.sources"),
                    };
                }

                if (hasExecutions)
                {
                    return new VisualBridgeRuntimeBridgeMessage
                    {
                        Type = VisualBridgeRuntimeBridgeMessageType.Response,
                        RequestId = requestId,
                        IsOk = true,
                        Executions = ValidateGraphExecutionInstances(value["executions"], "$.executions"),
                    };
                }

                if (hasExecution)
                {
                    if (!(value["execution"] is JObject execution))
                    {
                        throw Error("runtime.invalidMessage", "$.execution", "Expected a graph execution instance object.");
                    }

                    return new VisualBridgeRuntimeBridgeMessage
                    {
                        Type = VisualBridgeRuntimeBridgeMessageType.Response,
                        RequestId = requestId,
                        IsOk = true,
                        Execution = ValidateGraphExecutionInstance(execution, "$.execution"),
                    };
                }

                return new VisualBridgeRuntimeBridgeMessage
                {
                    Type = VisualBridgeRuntimeBridgeMessageType.Response,
                    RequestId = requestId,
                    IsOk = true,
                };
            }

            if (status == "error")
            {
                if (value.Property("documents", StringComparison.Ordinal) != null || value.Property("sources", StringComparison.Ordinal) != null
                    || value.Property("executions", StringComparison.Ordinal) != null || value.Property("execution", StringComparison.Ordinal) != null)
                {
                    throw Error("runtime.invalidMessage", "$", "An error response must not carry a payload.");
                }

                var errorToken = value["error"];
                if (errorToken == null || errorToken.Type != JTokenType.String || !ErrorCodes.Contains(errorToken.Value<string>()))
                {
                    throw Error("runtime.invalidMessage", "$.error", "Expected a registered runtime error code.");
                }

                var detail = value["detail"];
                if (detail != null && (detail.Type != JTokenType.String || detail.Value<string>().Length == 0 || detail.Value<string>().Length > 512))
                {
                    throw Error("runtime.invalidMessage", "$.detail", "Expected a non-empty detail string of at most 512 characters.");
                }

                return new VisualBridgeRuntimeBridgeMessage
                {
                    Type = VisualBridgeRuntimeBridgeMessageType.Response,
                    RequestId = requestId,
                    IsOk = false,
                    ErrorCode = errorToken.Value<string>(),
                    ErrorDetail = detail?.Value<string>(),
                };
            }

            throw Error("runtime.invalidMessage", "$.status", "Expected status 'ok' or 'error'.");
        }

        private static IReadOnlyList<VisualBridgeRuntimeDocumentSnapshot> ValidateDocuments(JToken token, string path)
        {
            if (!(token is JArray documentsArray))
            {
                throw Error("runtime.invalidMessage", path, "Expected a documents array.");
            }

            var documents = new List<VisualBridgeRuntimeDocumentSnapshot>(documentsArray.Count);
            for (var index = 0; index < documentsArray.Count; index++)
            {
                if (!(documentsArray[index] is JObject document))
                {
                    throw Error("runtime.invalidMessage", $"{path}[{index}]", "Expected a document snapshot object.");
                }

                documents.Add(ValidateDocumentSnapshot(document, $"{path}[{index}]"));
            }

            return documents;
        }

        private static IReadOnlyList<VisualBridgeRuntimeDocumentSource> ValidateSources(JToken token, string path)
        {
            if (!(token is JArray sourcesArray))
            {
                throw Error("runtime.invalidMessage", path, "Expected a sources array.");
            }

            var sources = new List<VisualBridgeRuntimeDocumentSource>(sourcesArray.Count);
            for (var index = 0; index < sourcesArray.Count; index++)
            {
                if (!(sourcesArray[index] is JObject source))
                {
                    throw Error("runtime.invalidMessage", $"{path}[{index}]", "Expected a document source object.");
                }

                sources.Add(ValidateDocumentSource(source, $"{path}[{index}]"));
            }

            return sources;
        }

        private static VisualBridgeRuntimeBridgeMessage ValidateEvent(JObject value)
        {
            var eventToken = value["event"];
            if (eventToken == null)
            {
                throw Error("runtime.missingProperty", "$.event", "Missing property 'event'.");
            }

            if (eventToken.Type != JTokenType.String)
            {
                throw Error("runtime.invalidMessage", "$.event", "Expected an event string.");
            }

            var eventName = eventToken.Value<string>();
            if (eventName == "artifactsChanged")
            {
                RequireOnlyKeys(value, "$", "type", "event", "documents");
                if (!(value["documents"] is JArray documentsArray))
                {
                    throw Error("runtime.invalidMessage", "$.documents", "Expected a documents array.");
                }

                var documents = new List<VisualBridgeRuntimeDocumentSnapshot>(documentsArray.Count);
                for (var index = 0; index < documentsArray.Count; index++)
                {
                    if (!(documentsArray[index] is JObject document))
                    {
                        throw Error("runtime.invalidMessage", $"$.documents[{index}]", "Expected a document snapshot object.");
                    }

                    documents.Add(ValidateDocumentSnapshot(document, $"$.documents[{index}]"));
                }

                return new VisualBridgeRuntimeBridgeMessage
                {
                    Type = VisualBridgeRuntimeBridgeMessageType.Event,
                    EventName = "artifactsChanged",
                    Documents = documents,
                };
            }

            if (eventName == "graphExecution")
            {
                RequireOnlyKeys(value, "$", "type", "event", "executionEvents");
                if (!(value["executionEvents"] is JArray eventsArray) || eventsArray.Count == 0)
                {
                    throw Error("runtime.invalidMessage", "$.executionEvents", "Expected a non-empty execution event array.");
                }

                var executionEvents = new List<VisualBridgeRuntimeGraphExecutionEvent>(eventsArray.Count);
                for (var index = 0; index < eventsArray.Count; index++)
                {
                    if (!(eventsArray[index] is JObject executionEvent))
                    {
                        throw Error("runtime.invalidMessage", $"$.executionEvents[{index}]", "Expected a graph execution event object.");
                    }

                    executionEvents.Add(ValidateGraphExecutionEvent(executionEvent, $"$.executionEvents[{index}]"));
                }

                return new VisualBridgeRuntimeBridgeMessage
                {
                    Type = VisualBridgeRuntimeBridgeMessageType.Event,
                    EventName = "graphExecution",
                    ExecutionEvents = executionEvents,
                };
            }

            throw Error("runtime.invalidMessage", "$.event", $"Unknown event '{eventName}'.");
        }

        private static IReadOnlyList<VisualBridgeRuntimeGraphExecutionInstance> ValidateGraphExecutionInstances(JToken token, string path)
        {
            if (!(token is JArray instancesArray))
            {
                throw Error("runtime.invalidMessage", path, "Expected an executions array.");
            }

            var instances = new List<VisualBridgeRuntimeGraphExecutionInstance>(instancesArray.Count);
            for (var index = 0; index < instancesArray.Count; index++)
            {
                if (!(instancesArray[index] is JObject instance))
                {
                    throw Error("runtime.invalidMessage", $"{path}[{index}]", "Expected a graph execution instance object.");
                }

                instances.Add(ValidateGraphExecutionInstance(instance, $"{path}[{index}]"));
            }

            return instances;
        }

        internal static VisualBridgeRuntimeGraphExecutionInstance ValidateGraphExecutionInstance(JObject value, string path)
        {
            RequireOnlyKeys(value, path, "executionId", "documentTypeId", "documentId", "graphName", "debugKey", "state", "currentNodeId", "frameIndex");
            var executionId = RequireString(value, "executionId", path + ".executionId");
            if (!ExecutionIdPattern.IsMatch(executionId))
            {
                throw Error("runtime.invalidMessage", path + ".executionId", "Expected an 'exec-<n>' execution identifier.");
            }

            var documentTypeId = RequireString(value, "documentTypeId", path + ".documentTypeId");
            if (!StableIdPattern.IsMatch(documentTypeId))
            {
                throw Error("runtime.invalidMessage", path + ".documentTypeId", "Expected a stable document type identifier.");
            }

            var documentId = RequireString(value, "documentId", path + ".documentId");
            if (!StableIdPattern.IsMatch(documentId))
            {
                throw Error("runtime.invalidMessage", path + ".documentId", "Expected a stable document identifier.");
            }

            var graphName = RequireString(value, "graphName", path + ".graphName");
            if (graphName.Length < 1 || graphName.Length > 256)
            {
                throw Error("runtime.invalidMessage", path + ".graphName", "Expected a graph name of 1 to 256 characters.");
            }

            var debugKey = RequireString(value, "debugKey", path + ".debugKey");
            if (debugKey.Length > 256)
            {
                throw Error("runtime.invalidMessage", path + ".debugKey", "Expected a debug key of at most 256 characters.");
            }

            var state = RequireString(value, "state", path + ".state");
            if (!GraphExecutionStates.Contains(state))
            {
                throw Error("runtime.invalidMessage", path + ".state", "Expected an execution state 'running' or 'stopped'.");
            }

            var currentNodeIdToken = value["currentNodeId"];
            string currentNodeId = null;
            if (currentNodeIdToken != null && currentNodeIdToken.Type != JTokenType.Null)
            {
                if (currentNodeIdToken.Type != JTokenType.String || !StableIdPattern.IsMatch(currentNodeIdToken.Value<string>()))
                {
                    throw Error("runtime.invalidMessage", path + ".currentNodeId", "Expected a node identifier or null.");
                }

                currentNodeId = currentNodeIdToken.Value<string>();
            }

            var frameIndex = RequireInteger(value, "frameIndex", path + ".frameIndex");
            if (frameIndex < 0)
            {
                throw Error("runtime.invalidMessage", path + ".frameIndex", "Expected a non-negative frame index.");
            }

            return new VisualBridgeRuntimeGraphExecutionInstance
            {
                ExecutionId = executionId,
                DocumentTypeId = documentTypeId,
                DocumentId = documentId,
                GraphName = graphName,
                DebugKey = debugKey,
                State = state,
                CurrentNodeId = currentNodeId,
                FrameIndex = frameIndex,
            };
        }

        internal static VisualBridgeRuntimeGraphExecutionEvent ValidateGraphExecutionEvent(JObject value, string path)
        {
            RequireOnlyKeys(value, path, new[] { "executionId", "frameIndex", "kind" }, new[] { "nodeId", "outputIndex", "value" });
            var executionId = RequireString(value, "executionId", path + ".executionId");
            if (!ExecutionIdPattern.IsMatch(executionId))
            {
                throw Error("runtime.invalidMessage", path + ".executionId", "Expected an 'exec-<n>' execution identifier.");
            }

            var frameIndex = RequireInteger(value, "frameIndex", path + ".frameIndex");
            if (frameIndex < 0)
            {
                throw Error("runtime.invalidMessage", path + ".frameIndex", "Expected a non-negative frame index.");
            }

            var kind = RequireString(value, "kind", path + ".kind");
            if (!GraphExecutionEventKinds.Contains(kind))
            {
                throw Error("runtime.invalidMessage", path + ".kind", "Expected a graph execution event kind.");
            }

            var requiresNodeId = kind == "nodeStart" || kind == "nodeOutput" || kind == "dataNode" || kind == "edgeValueChanged";
            var requiresOutputIndex = kind == "nodeOutput" || kind == "edgeValueChanged";
            var requiresValue = kind == "edgeValueChanged";
            var nodeIdToken = value["nodeId"];
            if (nodeIdToken != null && !requiresNodeId)
            {
                throw Error("runtime.invalidMessage", path + ".nodeId", $"Event kind '{kind}' must not carry a nodeId.");
            }

            var outputIndexToken = value["outputIndex"];
            if (outputIndexToken != null && !requiresOutputIndex)
            {
                throw Error("runtime.invalidMessage", path + ".outputIndex", $"Event kind '{kind}' must not carry an outputIndex.");
            }

            var valueToken = value["value"];
            if (valueToken != null && !requiresValue)
            {
                throw Error("runtime.invalidMessage", path + ".value", $"Event kind '{kind}' must not carry a value.");
            }

            string nodeId = null;
            if (requiresNodeId)
            {
                if (nodeIdToken == null)
                {
                    throw Error("runtime.missingProperty", path + ".nodeId", "Missing property 'nodeId'.");
                }

                if (nodeIdToken.Type != JTokenType.String || !StableIdPattern.IsMatch(nodeIdToken.Value<string>()))
                {
                    throw Error("runtime.invalidMessage", path + ".nodeId", "Expected a node identifier.");
                }

                nodeId = nodeIdToken.Value<string>();
            }

            int? outputIndex = null;
            if (requiresOutputIndex)
            {
                if (outputIndexToken == null)
                {
                    throw Error("runtime.missingProperty", path + ".outputIndex", "Missing property 'outputIndex'.");
                }

                if (outputIndexToken.Type != JTokenType.Integer || outputIndexToken.Value<int>() < 0)
                {
                    throw Error("runtime.invalidMessage", path + ".outputIndex", "Expected a non-negative output index.");
                }

                outputIndex = outputIndexToken.Value<int>();
            }

            string eventValue = null;
            if (requiresValue)
            {
                if (valueToken == null)
                {
                    throw Error("runtime.missingProperty", path + ".value", "Missing property 'value'.");
                }

                if (valueToken.Type != JTokenType.String)
                {
                    throw Error("runtime.invalidMessage", path + ".value", "Expected a value string.");
                }

                eventValue = valueToken.Value<string>();
                if (eventValue.Length < 1 || eventValue.Length > 4096)
                {
                    throw Error("runtime.invalidMessage", path + ".value", "Expected a value string of 1 to 4096 characters.");
                }
            }

            return new VisualBridgeRuntimeGraphExecutionEvent
            {
                ExecutionId = executionId,
                FrameIndex = frameIndex,
                Kind = kind,
                NodeId = nodeId,
                OutputIndex = outputIndex,
                Value = eventValue,
            };
        }

        private static VisualBridgeRuntimeBridgeMessage ValidateError(JObject value)
        {
            RequireOnlyKeys(value, "$", new[] { "type", "code" }, new[] { "detail" });
            var codeToken = value["code"];
            if (codeToken == null)
            {
                throw Error("runtime.missingProperty", "$.code", "Missing property 'code'.");
            }

            if (codeToken.Type != JTokenType.String || !ErrorCodes.Contains(codeToken.Value<string>()))
            {
                throw Error("runtime.invalidMessage", "$.code", "Expected a registered runtime error code.");
            }

            var detail = value["detail"];
            if (detail != null && (detail.Type != JTokenType.String || detail.Value<string>().Length == 0 || detail.Value<string>().Length > 512))
            {
                throw Error("runtime.invalidMessage", "$.detail", "Expected a non-empty detail string of at most 512 characters.");
            }

            return new VisualBridgeRuntimeBridgeMessage
            {
                Type = VisualBridgeRuntimeBridgeMessageType.Error,
                ErrorCode = codeToken.Value<string>(),
                ErrorDetail = detail?.Value<string>(),
            };
        }

        /// <summary>发现记录专用的键约束：多余键 runtime.unknownProperty，缺键/类型错 runtime.invalidMessage（fixture 冻结）。</summary>
        private static void RequireOnlyDiscoveryKeys(JObject value)
        {
            var allowed = new HashSet<string>(StringComparer.Ordinal)
            {
                "formatVersion", "protocolVersion", "coreVersion", "instanceId", "kind",
                "capabilities", "tcpPort", "token", "pid", "generation", "startedAt",
            };

            foreach (var property in value.Properties())
            {
                if (!allowed.Contains(property.Name))
                {
                    throw Error("runtime.unknownProperty", "$." + property.Name, $"Unknown property '{property.Name}'.");
                }
            }

            foreach (var property in allowed)
            {
                if (value.Property(property, StringComparison.Ordinal) == null)
                {
                    throw Error("runtime.invalidMessage", "$." + property, $"Missing property '{property}'.");
                }
            }
        }

        private static int RequireVersion(JObject value, string property, string path)
        {
            var token = value[property];
            if (token == null)
            {
                throw Error("runtime.missingProperty", path, $"Missing property '{property}'.");
            }

            if (token.Type != JTokenType.Integer)
            {
                throw Error("runtime.invalidMessage", path, "Expected an integer version.");
            }

            var version = token.Value<int>();
            if (version != ProtocolVersion)
            {
                // protocolVersion 与 coreVersion 都是版本协商声明，不匹配共用同一错误码。
                throw Error("runtime.protocolVersionMismatch", path, $"Expected {property} {ProtocolVersion}.");
            }

            return version;
        }

        private static string RequireRequestId(JObject value)
        {
            var requestId = RequireString(value, "requestId", "$.requestId");
            if (!StableIdPattern.IsMatch(requestId))
            {
                throw Error("runtime.invalidMessage", "$.requestId", "Expected a request identifier.");
            }

            return requestId;
        }

        private static IReadOnlyList<string> RequireCapabilities(JObject value, string path)
        {
            if (!(value["capabilities"] is JArray array) || array.Count == 0)
            {
                throw Error("runtime.invalidMessage", path, "Expected a non-empty capabilities array.");
            }

            var capabilities = new List<string>(array.Count);
            var unique = new HashSet<string>(StringComparer.Ordinal);
            for (var index = 0; index < array.Count; index++)
            {
                if (array[index].Type != JTokenType.String || !Capabilities.Contains(array[index].Value<string>()))
                {
                    throw Error("runtime.invalidMessage", $"{path}[{index}]", "Expected a registered capability.");
                }

                if (!unique.Add(array[index].Value<string>()))
                {
                    throw Error("runtime.invalidMessage", $"{path}[{index}]", "Duplicate capability.");
                }

                capabilities.Add(array[index].Value<string>());
            }

            return capabilities;
        }

        private static void RequireOnlyKeys(JObject value, string path, params string[] required)
        {
            RequireOnlyKeys(value, path, required, null);
        }

        private static void RequireOnlyKeys(JObject value, string path, string[] required, string[] optional)
        {
            var allowedSet = new HashSet<string>(required, StringComparer.Ordinal);
            if (optional != null)
            {
                allowedSet.UnionWith(optional);
            }

            foreach (var property in value.Properties())
            {
                if (!allowedSet.Contains(property.Name))
                {
                    throw Error("runtime.unknownProperty", path + "." + property.Name, $"Unknown property '{property.Name}'.");
                }
            }

            foreach (var property in required)
            {
                if (value.Property(property, StringComparison.Ordinal) == null)
                {
                    throw Error("runtime.missingProperty", path + "." + property, $"Missing property '{property}'.");
                }
            }
        }

        private static int RequireInteger(JObject value, string property, string path)
        {
            var token = value[property];
            if (token == null)
            {
                throw Error("runtime.invalidMessage", path, $"Missing property '{property}'.");
            }

            if (token.Type != JTokenType.Integer)
            {
                throw Error("runtime.invalidMessage", path, "Expected an integer.");
            }

            return token.Value<int>();
        }

        private static string RequireString(JObject value, string property, string path)
        {
            var token = value[property];
            if (token == null || token.Type != JTokenType.String)
            {
                throw Error("runtime.invalidMessage", path, "Expected a string.");
            }

            return token.Value<string>();
        }

        private static bool IsUtcDateTime(string text)
        {
            return StartedAtPattern.IsMatch(text)
                && DateTime.TryParse(text, null, System.Globalization.DateTimeStyles.AssumeUniversal | System.Globalization.DateTimeStyles.AdjustToUniversal, out _);
        }

        internal static JObject ParseObject(string text, string invalidJsonCode)
        {
            try
            {
                using (var stringReader = new StringReader(text ?? string.Empty))
                using (var reader = new Newtonsoft.Json.JsonTextReader(stringReader))
                {
                    reader.DateParseHandling = Newtonsoft.Json.DateParseHandling.None;
                    reader.FloatParseHandling = Newtonsoft.Json.FloatParseHandling.Decimal;
                    return JObject.Load(reader);
                }
            }
            catch
            {
                throw Error(invalidJsonCode, "$", "Peer sent a non-JSON line.");
            }
        }

        internal static VisualBridgeRuntimeBridgeException Error(string code, string path, string message)
        {
            return new VisualBridgeRuntimeBridgeException(code, path, message);
        }
    }
}
