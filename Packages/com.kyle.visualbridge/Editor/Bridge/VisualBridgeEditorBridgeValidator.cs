using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using Newtonsoft.Json.Linq;

namespace VisualBridge.Editor
{
    public enum VisualBridgeBridgeMessageType
    {
        Hello,
        Welcome,
        Open,
        Reveal,
        Response,
        Error,
    }

    /// <summary>
    /// 已通过校验的 Editor Bridge 消息；wire 校验在填充本模型之前
    /// 由 <see cref="VisualBridgeEditorBridgeValidator"/> 完成。
    /// </summary>
    public sealed class VisualBridgeBridgeMessage
    {
        public VisualBridgeBridgeMessageType Type { get; internal set; }

        public int ProtocolVersion { get; internal set; }

        public string Role { get; internal set; }

        public string ClientEndpointId { get; internal set; }

        public string Token { get; internal set; }

        public string ContractHash { get; internal set; }

        public IReadOnlyList<string> Payloads { get; internal set; }

        public IReadOnlyList<string> DebugCategories { get; internal set; }

        public IReadOnlyList<string> DebugInstances { get; internal set; }

        public string ResumeSessionId { get; internal set; }

        public string EndpointId { get; internal set; }

        public string SessionId { get; internal set; }

        public bool Resumed { get; internal set; }

        public string ConnectType { get; internal set; }

        public int Generation { get; internal set; }

        public string BootId { get; internal set; }

        public bool DebugEnabled { get; internal set; }

        public DateTime StartedAt { get; internal set; }

        public string RequestId { get; internal set; }

        public string DocumentPath { get; internal set; }

        public string ReferenceValue { get; internal set; }

        public bool ReferenceIsNumber { get; internal set; }

        public bool IsOk { get; internal set; }

        public string ErrorCode { get; internal set; }

        public string ErrorDetail { get; internal set; }

        public JObject ToJson()
        {
            return VisualBridgeEditorBridgeValidator.SerializeMessage(this);
        }

        public string ToLine()
        {
            return ToJson().ToString(Newtonsoft.Json.Formatting.None);
        }
    }

    /// <summary>
    /// 已通过校验的、由 VS Code Extension Host 发布的按窗口划分的发现记录（v2）。
    /// </summary>
    public sealed class VisualBridgeBridgeWindow
    {
        public string WindowId { get; internal set; }

        public int ProtocolVersion { get; internal set; }

        public string Role { get; internal set; }

        public IReadOnlyList<string> ProjectRoots { get; internal set; }

        public int TcpPort { get; internal set; }

        public string Token { get; internal set; }

        public int Pid { get; internal set; }

        public int Generation { get; internal set; }

        public string RecordPath { get; internal set; }
    }

    /// <summary>
    /// 统一连接协议（协议版本 4）的 Editor 腿消息与发现记录 v2 的严格 JSON 校验器。
    /// 与 Protocol/Schema/visualbridge-editor-bridge.schema.json 保持镜像；
    /// 共享 parity fixture 同时由 AJV（generator）与 Unity EditMode 测试执行。
    /// </summary>
    public static class VisualBridgeEditorBridgeValidator
    {
        /// <summary>
        /// 连接层版本：唯一来源是 Runtime 腿的
        /// <see cref="VisualBridge.Runtime.VisualBridgeRuntimeBridgeValidator.ProtocolVersion"/>
        /// （附录 A.1/A.3 只有一个 <c>protocolVersion</c>）；编辑器腿只别名，不再各写一份字面量。
        /// </summary>
        public const int ProtocolVersion = VisualBridge.Runtime.VisualBridgeRuntimeBridgeValidator.ProtocolVersion;

        /// <summary>发现记录格式版本（附录 A.7）；旧格式视为无记录。</summary>
        public const int DiscoveryFormatVersion = 2;

        /// <summary>
        /// 附录 A.5：`reveal` 的数字 reference 必须是不越安全整数的整数（TS 用
        /// <c>Number.isSafeInteger</c>）；越界值上线会被 TS 侧判 <c>bridge.invalidMessage</c> 并断连。
        /// </summary>
        private const long MaxSafeInteger = 9007199254740991L;

        private static readonly Regex RequestIdPattern = new Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$", RegexOptions.Compiled);
        private static readonly Regex EndpointIdPattern = new Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$", RegexOptions.Compiled);
        private static readonly Regex SessionIdPattern = new Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,127}#[A-Za-z0-9][A-Za-z0-9._-]{0,127}$", RegexOptions.Compiled);
        private static readonly Regex ContractHashPattern = new Regex("^(?:[0-9a-f]{16})?$", RegexOptions.Compiled);
        private static readonly Regex TokenPattern = new Regex("^[0-9a-f]{48,64}$", RegexOptions.Compiled);
        private static readonly Regex UuidPattern = new Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", RegexOptions.Compiled | RegexOptions.IgnoreCase);
        private static readonly Regex AbsolutePathPattern = new Regex("^(?:[A-Za-z]:)?/(?!.*//)(?!.*(?:^|/)\\.{1,2}(?:/|$))(?!.*\\\\)(?!.*/$)(?:[^/]+/)*[^/]+$", RegexOptions.Compiled);
        private static readonly Regex StartedAtPattern = new Regex("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$", RegexOptions.Compiled);

        private static readonly HashSet<string> Roles = new HashSet<string>(StringComparer.Ordinal) { "editor", "vscode" };
        private static readonly HashSet<string> ConnectTypes = new HashSet<string>(StringComparer.Ordinal) { "editor", "editor-player", "player" };
        private static readonly HashSet<string> PayloadKinds = new HashSet<string>(StringComparer.Ordinal) { "json", "binary" };
        private static readonly HashSet<string> ErrorCodes = new HashSet<string>(StringComparer.Ordinal)
        {
            "bridge.capabilityMissing",
            "bridge.documentAmbiguous",
            "bridge.documentUnresolved",
            "bridge.internalError",
            "bridge.invalidJson",
            "bridge.invalidMessage",
            "bridge.invalidToken",
            "bridge.protocolVersionMismatch",
            "bridge.unknownMessageType",
            "runtime.alreadyConnected",
            "runtime.contractHashMismatch",
            "runtime.invalidToken",
            "runtime.roleMismatch",
            "runtime.unsupportedPayload",
            "runtime.unsupportedProtocolVersion",
        };

        public static VisualBridgeBridgeMessage ValidateMessage(JObject value)
        {
            if (value == null)
            {
                throw Error("bridge.invalidMessage", "$", "Expected a message object.");
            }

            var typeToken = value["type"];
            if (typeToken == null || typeToken.Type != JTokenType.String)
            {
                throw Error("bridge.missingProperty", "$.type", "Expected a message 'type' string.");
            }

            var type = typeToken.Value<string>();
            switch (type)
            {
                case "hello": return ValidateHello(value);
                case "welcome": return ValidateWelcome(value);
                case "open": return ValidateOpen(value);
                case "reveal": return ValidateReveal(value);
                case "response": return ValidateResponse(value);
                case "error": return ValidateError(value);
                default:
                    throw Error("bridge.unknownMessageType", "$.type", $"Unknown message type '{type}'.");
            }
        }

        public static VisualBridgeBridgeWindow ValidateDiscoveryRecord(JObject value, string recordPath)
        {
            if (value == null)
            {
                throw Error("bridge.invalidMessage", "$", "Expected a discovery record object.");
            }

            RequireOnlyKeys(
                value,
                "$",
                "formatVersion",
                "protocolVersion",
                "role",
                "tcpPort",
                "token",
                "pid",
                "generation",
                "windowId",
                "projectRoots");

            var formatVersion = RequireInteger(value, "formatVersion", "$.formatVersion");
            if (formatVersion != DiscoveryFormatVersion)
            {
                throw Error("bridge.unsupportedFormatVersion", "$.formatVersion", $"Expected formatVersion {DiscoveryFormatVersion}.");
            }

            var protocolVersion = RequireInteger(value, "protocolVersion", "$.protocolVersion");
            if (protocolVersion != ProtocolVersion)
            {
                throw Error("bridge.unsupportedProtocolVersion", "$.protocolVersion", $"Expected protocolVersion {ProtocolVersion}.");
            }

            var role = RequireRole(value, "$.role");
            var tcpPort = RequireInteger(value, "tcpPort", "$.tcpPort");
            if (tcpPort < 1 || tcpPort > 65535)
            {
                throw Error("bridge.invalidMessage", "$.tcpPort", "Expected a TCP port between 1 and 65535.");
            }

            var token = RequireString(value, "token", "$.token");
            if (!TokenPattern.IsMatch(token))
            {
                throw Error("bridge.invalidToken", "$.token", "Expected a hex authentication token.");
            }

            var pid = RequireInteger(value, "pid", "$.pid");
            if (pid < 1)
            {
                throw Error("bridge.invalidMessage", "$.pid", "Expected a positive process id.");
            }

            var generation = RequireInteger(value, "generation", "$.generation");
            if (generation < 1)
            {
                throw Error("bridge.invalidMessage", "$.generation", "Expected a positive listener generation.");
            }

            var windowId = RequireString(value, "windowId", "$.windowId");
            if (!UuidPattern.IsMatch(windowId))
            {
                throw Error("bridge.invalidMessage", "$.windowId", "Expected a UUID window identifier.");
            }

            var projectRoots = RequireProjectRoots(value, "$.projectRoots");
            return new VisualBridgeBridgeWindow
            {
                WindowId = windowId,
                ProtocolVersion = protocolVersion,
                Role = role,
                ProjectRoots = projectRoots,
                TcpPort = tcpPort,
                Token = token,
                Pid = pid,
                Generation = generation,
                RecordPath = recordPath,
            };
        }

        public static JObject SerializeMessage(VisualBridgeBridgeMessage message)
        {
            var value = new JObject();
            switch (message.Type)
            {
                case VisualBridgeBridgeMessageType.Hello:
                    value["type"] = "hello";
                    value["protocolVersion"] = message.ProtocolVersion;
                    value["role"] = message.Role;
                    value["clientEndpointId"] = message.ClientEndpointId;
                    if (message.Token != null)
                    {
                        value["token"] = message.Token;
                    }

                    value["contractHash"] = message.ContractHash;
                    value["payloads"] = new JArray(message.Payloads);
                    if (message.DebugCategories != null)
                    {
                        value["debugCategories"] = new JArray(message.DebugCategories);
                    }

                    if (message.DebugInstances != null)
                    {
                        value["debugInstances"] = new JArray(message.DebugInstances);
                    }

                    if (message.ResumeSessionId != null)
                    {
                        value["resumeSessionId"] = message.ResumeSessionId;
                    }

                    break;
                case VisualBridgeBridgeMessageType.Welcome:
                    value["type"] = "welcome";
                    value["protocolVersion"] = message.ProtocolVersion;
                    value["endpointId"] = message.EndpointId;
                    value["sessionId"] = message.SessionId;
                    value["resumed"] = message.Resumed;
                    value["connectType"] = message.ConnectType;
                    value["generation"] = message.Generation;
                    value["bootId"] = message.BootId;
                    value["contractHash"] = message.ContractHash;
                    value["payloads"] = new JArray(message.Payloads);
                    value["debugEnabled"] = message.DebugEnabled;
                    value["startedAt"] = message.StartedAt.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", System.Globalization.CultureInfo.InvariantCulture);
                    break;
                case VisualBridgeBridgeMessageType.Open:
                    value["type"] = "open";
                    value["requestId"] = message.RequestId;
                    value["documentPath"] = message.DocumentPath;
                    break;
                case VisualBridgeBridgeMessageType.Reveal:
                    value["type"] = "reveal";
                    value["requestId"] = message.RequestId;
                    value["reference"] = message.ReferenceIsNumber ? (JToken)new JValue(long.Parse(message.ReferenceValue)) : new JValue(message.ReferenceValue);
                    break;
                case VisualBridgeBridgeMessageType.Response:
                    value["type"] = "response";
                    value["requestId"] = message.RequestId;
                    value["status"] = message.IsOk ? "ok" : "error";
                    if (!message.IsOk)
                    {
                        value["error"] = message.ErrorCode;
                    }

                    break;
                case VisualBridgeBridgeMessageType.Error:
                    value["type"] = "error";
                    value["code"] = message.ErrorCode;
                    if (message.ErrorDetail != null)
                    {
                        value["detail"] = message.ErrorDetail;
                    }

                    break;
                default:
                    throw Error("bridge.invalidMessage", "$.type", "Cannot serialize an unknown message type.");
            }

            // 序列化输出必须通过与 wire 输入相同的严格校验。
            ValidateMessage(value);
            return value;
        }

        internal static VisualBridgeBridgeMessage CreateHello(
            string clientEndpointId,
            string token,
            string contractHash,
            IReadOnlyList<string> payloads,
            IReadOnlyList<string> debugCategories = null,
            IReadOnlyList<string> debugInstances = null,
            string resumeSessionId = null)
        {
            return new VisualBridgeBridgeMessage
            {
                Type = VisualBridgeBridgeMessageType.Hello,
                ProtocolVersion = ProtocolVersion,
                Role = "editor",
                ClientEndpointId = clientEndpointId,
                Token = token,
                ContractHash = contractHash,
                Payloads = payloads,
                DebugCategories = debugCategories,
                DebugInstances = debugInstances,
                ResumeSessionId = resumeSessionId,
            };
        }

        internal static VisualBridgeBridgeMessage CreateOpen(string requestId, string documentPath)
        {
            return new VisualBridgeBridgeMessage
            {
                Type = VisualBridgeBridgeMessageType.Open,
                RequestId = requestId,
                DocumentPath = documentPath,
            };
        }

        internal static VisualBridgeBridgeMessage CreateReveal(string requestId, string referenceValue, bool referenceIsNumber)
        {
            return new VisualBridgeBridgeMessage
            {
                Type = VisualBridgeBridgeMessageType.Reveal,
                RequestId = requestId,
                ReferenceValue = referenceValue,
                ReferenceIsNumber = referenceIsNumber,
            };
        }

        private static VisualBridgeBridgeMessage ValidateHello(JObject value)
        {
            PrecheckProtocolVersion(value);
            RequireOnlyKeys(
                value,
                "$",
                new[] { "type", "protocolVersion", "role", "clientEndpointId", "contractHash", "payloads" },
                new[] { "token", "debugCategories", "debugInstances", "resumeSessionId" });

            var protocolVersion = RequireProtocolVersion(value, "$.protocolVersion");
            var role = RequireRole(value, "$.role");
            var clientEndpointId = RequireEndpointId(value, "clientEndpointId", "$.clientEndpointId");
            string token = null;
            if (value.Property("token", StringComparison.Ordinal) != null)
            {
                token = RequireString(value, "token", "$.token");
                if (!TokenPattern.IsMatch(token))
                {
                    throw Error("bridge.invalidToken", "$.token", "Expected a hex authentication token.");
                }
            }

            var contractHash = RequireContractHash(value);
            var payloads = RequirePayloads(value, "$.payloads");
            var debugCategories = value.Property("debugCategories", StringComparison.Ordinal) == null
                ? null
                : RequireDebugFilter(value, "debugCategories", "$.debugCategories");
            var debugInstances = value.Property("debugInstances", StringComparison.Ordinal) == null
                ? null
                : RequireDebugFilter(value, "debugInstances", "$.debugInstances");
            string resumeSessionId = null;
            if (value.Property("resumeSessionId", StringComparison.Ordinal) != null)
            {
                resumeSessionId = RequireSessionId(value, "resumeSessionId", "$.resumeSessionId");
            }

            return new VisualBridgeBridgeMessage
            {
                Type = VisualBridgeBridgeMessageType.Hello,
                ProtocolVersion = protocolVersion,
                Role = role,
                ClientEndpointId = clientEndpointId,
                Token = token,
                ContractHash = contractHash,
                Payloads = payloads,
                DebugCategories = debugCategories,
                DebugInstances = debugInstances,
                ResumeSessionId = resumeSessionId,
            };
        }

        private static VisualBridgeBridgeMessage ValidateWelcome(JObject value)
        {
            PrecheckProtocolVersion(value);
            RequireOnlyKeys(
                value,
                "$",
                "type",
                "protocolVersion",
                "endpointId",
                "sessionId",
                "resumed",
                "connectType",
                "generation",
                "bootId",
                "contractHash",
                "payloads",
                "debugEnabled",
                "startedAt");

            var protocolVersion = RequireProtocolVersion(value, "$.protocolVersion");
            var endpointId = RequireEndpointId(value, "endpointId", "$.endpointId");
            var bootId = RequireEndpointId(value, "bootId", "$.bootId");
            var sessionId = RequireSessionId(value, "sessionId", "$.sessionId");
            if (!string.Equals(sessionId, endpointId + "#" + bootId, StringComparison.Ordinal))
            {
                throw Error("bridge.invalidMessage", "$.sessionId", "sessionId must equal endpointId#bootId.");
            }

            var resumed = RequireBoolean(value, "resumed", "$.resumed");
            var connectType = RequireString(value, "connectType", "$.connectType");
            if (!ConnectTypes.Contains(connectType))
            {
                throw Error("bridge.invalidMessage", "$.connectType", "Expected connectType 'editor', 'editor-player', or 'player'.");
            }

            var generation = RequireInteger(value, "generation", "$.generation");
            if (generation < 1)
            {
                throw Error("bridge.invalidMessage", "$.generation", "Expected a positive listener generation.");
            }

            var contractHash = RequireContractHash(value);
            var payloads = RequirePayloads(value, "$.payloads");
            var debugEnabled = RequireBoolean(value, "debugEnabled", "$.debugEnabled");
            var startedAtText = RequireString(value, "startedAt", "$.startedAt");
            if (!StartedAtPattern.IsMatch(startedAtText)
                || !DateTime.TryParse(
                    startedAtText,
                    null,
                    System.Globalization.DateTimeStyles.AssumeUniversal | System.Globalization.DateTimeStyles.AdjustToUniversal,
                    out var startedAt))
            {
                throw Error("bridge.invalidMessage", "$.startedAt", "Expected a UTC ISO date-time.");
            }

            return new VisualBridgeBridgeMessage
            {
                Type = VisualBridgeBridgeMessageType.Welcome,
                ProtocolVersion = protocolVersion,
                EndpointId = endpointId,
                SessionId = sessionId,
                Resumed = resumed,
                ConnectType = connectType,
                Generation = generation,
                BootId = bootId,
                ContractHash = contractHash,
                Payloads = payloads,
                DebugEnabled = debugEnabled,
                StartedAt = startedAt,
            };
        }

        private static VisualBridgeBridgeMessage ValidateOpen(JObject value)
        {
            RequireOnlyKeys(value, "$", "type", "requestId", "documentPath");
            var requestId = RequireRequestId(value);
            var documentPath = RequireString(value, "documentPath", "$.documentPath");
            if (documentPath.Length == 0
                || documentPath.Length > 1024
                || documentPath.StartsWith("/", StringComparison.Ordinal)
                || documentPath.Contains(":")
                || documentPath.Contains("\\")
                || documentPath.Contains("//")
                || documentPath.EndsWith("/", StringComparison.Ordinal)
                || documentPath.Split('/').Any(segment => segment.Length == 0 || segment == "." || segment == ".."))
            {
                throw Error("bridge.invalidMessage", "$.documentPath", "Expected a normalized project-relative forward-slash path.");
            }

            return new VisualBridgeBridgeMessage
            {
                Type = VisualBridgeBridgeMessageType.Open,
                RequestId = requestId,
                DocumentPath = documentPath,
            };
        }

        private static VisualBridgeBridgeMessage ValidateReveal(JObject value)
        {
            RequireOnlyKeys(value, "$", "type", "requestId", "reference");
            var requestId = RequireRequestId(value);
            var reference = value["reference"];
            if (reference == null)
            {
                throw Error("bridge.missingProperty", "$.reference", "Missing property 'reference'.");
            }

            if (reference.Type == JTokenType.String)
            {
                var text = reference.Value<string>();
                if (text.Length == 0 || text.Length > 1024)
                {
                    throw Error("bridge.invalidMessage", "$.reference", "Expected a non-empty reference value.");
                }

                return new VisualBridgeBridgeMessage
                {
                    Type = VisualBridgeBridgeMessageType.Reveal,
                    RequestId = requestId,
                    ReferenceValue = text,
                    ReferenceIsNumber = false,
                };
            }

            if (reference.Type == JTokenType.Integer)
            {
                long integer;
                try
                {
                    integer = reference.Value<long>();
                }
                catch (OverflowException)
                {
                    // 超出 long 的整数字面量（Newtonsoft 存为 BigInteger）同样不是安全整数。
                    throw Error("bridge.invalidMessage", "$.reference", "Expected a safe integer reference value.");
                }

                if (integer < -MaxSafeInteger || integer > MaxSafeInteger)
                {
                    throw Error("bridge.invalidMessage", "$.reference", "Expected a safe integer reference value.");
                }

                return new VisualBridgeBridgeMessage
                {
                    Type = VisualBridgeBridgeMessageType.Reveal,
                    RequestId = requestId,
                    ReferenceValue = integer.ToString(System.Globalization.CultureInfo.InvariantCulture),
                    ReferenceIsNumber = true,
                };
            }

            throw Error("bridge.invalidMessage", "$.reference", "Expected a string or number reference value.");
        }

        private static VisualBridgeBridgeMessage ValidateResponse(JObject value)
        {
            RequireOnlyKeys(value, "$", new[] { "type", "requestId", "status" }, new[] { "error" });
            var requestId = RequireRequestId(value);
            var statusToken = value["status"];
            if (statusToken == null)
            {
                throw Error("bridge.missingProperty", "$.status", "Missing property 'status'.");
            }

            if (statusToken.Type != JTokenType.String)
            {
                throw Error("bridge.invalidMessage", "$.status", "Expected a status string.");
            }

            var status = statusToken.Value<string>();
            if (status == "ok")
            {
                // 附录 A.5：ok 分支不携带 error（schema 的 ok 分支 additionalProperties:false），
                // 与 TS parseResponse 同判据——出现即按未知属性拒绝，避免双分支字段被静默忽略。
                if (value.Property("error", StringComparison.Ordinal) != null)
                {
                    throw Error("bridge.unknownProperty", "$.error", "Unknown property 'error'.");
                }

                return new VisualBridgeBridgeMessage
                {
                    Type = VisualBridgeBridgeMessageType.Response,
                    RequestId = requestId,
                    IsOk = true,
                };
            }

            if (status == "error")
            {
                var errorToken = value["error"];
                if (errorToken == null || errorToken.Type != JTokenType.String || !ErrorCodes.Contains(errorToken.Value<string>(), StringComparer.Ordinal))
                {
                    throw Error("bridge.invalidMessage", "$.error", "Expected a registered bridge error code.");
                }

                return new VisualBridgeBridgeMessage
                {
                    Type = VisualBridgeBridgeMessageType.Response,
                    RequestId = requestId,
                    IsOk = false,
                    ErrorCode = errorToken.Value<string>(),
                };
            }

            throw Error("bridge.invalidMessage", "$.status", "Expected status 'ok' or 'error'.");
        }

        private static VisualBridgeBridgeMessage ValidateError(JObject value)
        {
            RequireOnlyKeys(value, "$", new[] { "type", "code" }, new[] { "detail" });
            var codeToken = value["code"];
            if (codeToken == null)
            {
                throw Error("bridge.missingProperty", "$.code", "Missing property 'code'.");
            }

            if (codeToken.Type != JTokenType.String || !ErrorCodes.Contains(codeToken.Value<string>(), StringComparer.Ordinal))
            {
                throw Error("bridge.invalidMessage", "$.code", "Expected a registered bridge error code.");
            }

            var detail = value["detail"];
            if (detail != null && (detail.Type != JTokenType.String || detail.Value<string>().Length == 0 || detail.Value<string>().Length > 512))
            {
                throw Error("bridge.invalidMessage", "$.detail", "Expected a non-empty detail string of at most 512 characters.");
            }

            return new VisualBridgeBridgeMessage
            {
                Type = VisualBridgeBridgeMessageType.Error,
                ErrorCode = codeToken.Value<string>(),
                ErrorDetail = detail?.Value<string>(),
            };
        }

        /// <summary>
        /// 连接层优先：旧版本 peer 的字段集合可能不同，先按版本拒绝，
        /// 避免把"版本不符"误报成缺字段/未知字段（附录 A.3 的拒绝层级）。
        /// </summary>
        private static void PrecheckProtocolVersion(JObject value)
        {
            var token = value["protocolVersion"];
            if (token != null && token.Type == JTokenType.Integer && token.Value<int>() != ProtocolVersion)
            {
                throw Error("runtime.unsupportedProtocolVersion", "$.protocolVersion", $"Expected protocolVersion {ProtocolVersion}.");
            }
        }

        private static int RequireProtocolVersion(JObject value, string path)
        {
            var protocolVersion = RequireInteger(value, "protocolVersion", path);
            if (protocolVersion != ProtocolVersion)
            {
                throw Error("runtime.unsupportedProtocolVersion", path, $"Expected protocolVersion {ProtocolVersion}.");
            }

            return protocolVersion;
        }

        private static string RequireRequestId(JObject value)
        {
            var requestId = RequireString(value, "requestId", "$.requestId");
            if (!RequestIdPattern.IsMatch(requestId))
            {
                throw Error("bridge.invalidMessage", "$.requestId", "Expected a request identifier.");
            }

            return requestId;
        }

        private static string RequireRole(JObject value, string path)
        {
            var role = RequireString(value, "role", path);
            if (!Roles.Contains(role, StringComparer.Ordinal))
            {
                throw Error("bridge.invalidMessage", path, "Expected role 'editor' or 'vscode'.");
            }

            return role;
        }

        private static string RequireEndpointId(JObject value, string property, string path)
        {
            var endpointId = RequireString(value, property, path);
            if (!EndpointIdPattern.IsMatch(endpointId))
            {
                throw Error("bridge.invalidMessage", path, "Expected a stable endpoint identifier.");
            }

            return endpointId;
        }

        private static string RequireSessionId(JObject value, string property, string path)
        {
            var sessionId = RequireString(value, property, path);
            if (!SessionIdPattern.IsMatch(sessionId))
            {
                throw Error("bridge.invalidMessage", path, "Expected an 'endpointId#bootId' session identifier.");
            }

            return sessionId;
        }

        private static string RequireContractHash(JObject value)
        {
            var contractHash = RequireString(value, "contractHash", "$.contractHash");
            if (!ContractHashPattern.IsMatch(contractHash))
            {
                throw Error("bridge.invalidMessage", "$.contractHash", "Expected 16 lowercase hex characters or an empty string.");
            }

            return contractHash;
        }

        private static IReadOnlyList<string> RequirePayloads(JObject value, string path)
        {
            var token = value[path.Substring(2)];
            if (!(token is JArray array))
            {
                throw Error("bridge.invalidMessage", path, "Expected a payload array.");
            }

            // 空交集与缺 json 同属载荷协商失败（附录 A.3），不是形状错误。
            if (array.Count == 0)
            {
                throw Error("runtime.unsupportedPayload", path, "No supported payload kind; 'json' is mandatory.");
            }

            var payloads = new List<string>(array.Count);
            var unique = new HashSet<string>(StringComparer.Ordinal);
            for (var index = 0; index < array.Count; index++)
            {
                if (array[index].Type != JTokenType.String || !PayloadKinds.Contains(array[index].Value<string>(), StringComparer.Ordinal))
                {
                    throw Error("bridge.invalidMessage", $"{path}[{index}]", "Expected payload kinds 'json' and/or 'binary'.");
                }

                if (!unique.Add(array[index].Value<string>()))
                {
                    throw Error("bridge.invalidMessage", $"{path}[{index}]", "Duplicate payload kind.");
                }

                payloads.Add(array[index].Value<string>());
            }

            if (!unique.Contains("json"))
            {
                throw Error("runtime.unsupportedPayload", path, "The 'json' payload kind is mandatory.");
            }

            return payloads;
        }

        private static IReadOnlyList<string> RequireDebugFilter(JObject value, string property, string path)
        {
            if (!(value[property] is JArray array))
            {
                throw Error("bridge.invalidMessage", path, "Expected an array of filter names.");
            }

            var filters = new List<string>(array.Count);
            var unique = new HashSet<string>(StringComparer.Ordinal);
            for (var index = 0; index < array.Count; index++)
            {
                if (array[index].Type != JTokenType.String)
                {
                    throw Error("bridge.invalidMessage", $"{path}[{index}]", "Expected a filter name string.");
                }

                var name = array[index].Value<string>();
                if (name.Length == 0 || name.Length > 256)
                {
                    throw Error("bridge.invalidMessage", $"{path}[{index}]", "Expected non-empty filter names of at most 256 characters.");
                }

                if (!unique.Add(name))
                {
                    throw Error("bridge.invalidMessage", $"{path}[{index}]", "Duplicate filter name.");
                }

                filters.Add(name);
            }

            return filters;
        }

        private static IReadOnlyList<string> RequireProjectRoots(JObject value, string path)
        {
            var token = value["projectRoots"];
            if (!(token is JArray array) || array.Count == 0)
            {
                throw Error("bridge.invalidMessage", path, "Expected a non-empty projectRoots array.");
            }

            var roots = new List<string>(array.Count);
            var unique = new HashSet<string>(StringComparer.Ordinal);
            for (var index = 0; index < array.Count; index++)
            {
                if (array[index].Type != JTokenType.String)
                {
                    throw Error("bridge.invalidMessage", $"{path}[{index}]", "Expected an absolute path string.");
                }

                var root = array[index].Value<string>();
                if (!AbsolutePathPattern.IsMatch(root))
                {
                    throw Error("bridge.invalidMessage", $"{path}[{index}]", "Expected a normalized absolute forward-slash path.");
                }

                if (!unique.Add(root))
                {
                    throw Error("bridge.invalidMessage", $"{path}[{index}]", "Duplicate project root.");
                }

                roots.Add(root);
            }

            return roots;
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
                    throw Error("bridge.unknownProperty", path + "." + property.Name, $"Unknown property '{property.Name}'.");
                }
            }

            foreach (var property in required)
            {
                if (value.Property(property, StringComparison.Ordinal) == null)
                {
                    throw Error("bridge.missingProperty", path + "." + property, $"Missing property '{property}'.");
                }
            }
        }

        private static int RequireInteger(JObject value, string property, string path)
        {
            var token = value[property];
            if (token == null || token.Type != JTokenType.Integer)
            {
                throw Error("bridge.invalidMessage", path, "Expected an integer.");
            }

            return token.Value<int>();
        }

        private static bool RequireBoolean(JObject value, string property, string path)
        {
            var token = value[property];
            if (token == null || token.Type != JTokenType.Boolean)
            {
                throw Error("bridge.invalidMessage", path, "Expected a boolean.");
            }

            return token.Value<bool>();
        }

        private static string RequireString(JObject value, string property, string path)
        {
            var token = value[property];
            if (token == null || token.Type != JTokenType.String)
            {
                throw Error("bridge.invalidMessage", path, "Expected a string.");
            }

            return token.Value<string>();
        }

        internal static VisualBridgeIntegrationException Error(string code, string path, string message)
        {
            return new VisualBridgeIntegrationException(code, path, message);
        }
    }
}
