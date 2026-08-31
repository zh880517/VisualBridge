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

        private static readonly HashSet<string> Capabilities = new HashSet<string>(StringComparer.Ordinal) { "snapshot", "events", "lease", "sources" };
        private static readonly HashSet<string> InstanceKinds = new HashSet<string>(StringComparer.Ordinal) { "editor-play", "player" };
        private static readonly HashSet<string> RequestActions = new HashSet<string>(StringComparer.Ordinal)
        {
            "getSnapshot",
            "acquireLease",
            "releaseLease",
            "getDocumentSources",
        };

        private static readonly HashSet<string> ErrorCodes = new HashSet<string>(StringComparer.Ordinal)
        {
            "runtime.capabilityMissing",
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
                    break;
                case VisualBridgeRuntimeBridgeMessageType.Response:
                    value["type"] = "response";
                    value["requestId"] = message.RequestId;
                    value["status"] = message.IsOk ? "ok" : "error";
                    if (message.IsOk)
                    {
                        // documents 与 sources 互斥；都缺省为租约 ok（无载荷）。
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
                    var eventDocuments = new JArray();
                    foreach (var document in message.Documents ?? Array.Empty<VisualBridgeRuntimeDocumentSnapshot>())
                    {
                        eventDocuments.Add(document.ToJson());
                    }

                    value["documents"] = eventDocuments;
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
            RequireOnlyKeys(value, "$", new[] { "type", "requestId", "action" }, new[] { "documentTypeIds" });
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

            // Schema allOf 约束：documentTypeIds 仅 getSnapshot 允许携带。
            var filterToken = value["documentTypeIds"];
            if (filterToken != null && action != "getSnapshot")
            {
                throw Error("runtime.invalidMessage", "$.documentTypeIds", $"Action '{action}' must not carry documentTypeIds.");
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
            RequireOnlyKeys(value, "$", new[] { "type", "requestId", "status" }, new[] { "documents", "sources", "error", "detail" });
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

                // documents 与 sources 互斥；都缺省为租约 ok（无载荷响应）。
                var hasDocuments = value.Property("documents", StringComparison.Ordinal) != null;
                var hasSources = value.Property("sources", StringComparison.Ordinal) != null;
                if (hasDocuments && hasSources)
                {
                    throw Error("runtime.invalidMessage", "$", "An ok response must not carry both documents and sources.");
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

                return new VisualBridgeRuntimeBridgeMessage
                {
                    Type = VisualBridgeRuntimeBridgeMessageType.Response,
                    RequestId = requestId,
                    IsOk = true,
                };
            }

            if (status == "error")
            {
                if (value.Property("documents", StringComparison.Ordinal) != null || value.Property("sources", StringComparison.Ordinal) != null)
                {
                    throw Error("runtime.invalidMessage", "$", "An error response must not carry documents or sources.");
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
            RequireOnlyKeys(value, "$", "type", "event", "documents");
            var eventToken = value["event"];
            if (eventToken == null)
            {
                throw Error("runtime.missingProperty", "$.event", "Missing property 'event'.");
            }

            if (eventToken.Type != JTokenType.String || eventToken.Value<string>() != "artifactsChanged")
            {
                throw Error("runtime.invalidMessage", "$.event", "Expected event 'artifactsChanged'.");
            }

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
