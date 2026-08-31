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

        public string Token { get; internal set; }

        public string ClientInstanceId { get; internal set; }

        public string WindowId { get; internal set; }

        public int ServerGeneration { get; internal set; }

        public IReadOnlyList<string> Capabilities { get; internal set; }

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
    /// 已通过校验的、由 VS Code Extension Host 发布的按窗口划分的发现记录。
    /// </summary>
    public sealed class VisualBridgeBridgeWindow
    {
        public string WindowId { get; internal set; }

        public int ProtocolVersion { get; internal set; }

        public IReadOnlyList<string> Capabilities { get; internal set; }

        public IReadOnlyList<string> ProjectRoots { get; internal set; }

        public string PipePath { get; internal set; }

        public int TcpPort { get; internal set; }

        public string Token { get; internal set; }

        public int Pid { get; internal set; }

        public int Generation { get; internal set; }

        public DateTime StartedAt { get; internal set; }

        public string RecordPath { get; internal set; }

        public bool Supports(string capability)
        {
            return Capabilities.Contains(capability, StringComparer.Ordinal);
        }
    }

    /// <summary>
    /// Editor Bridge V1 消息与发现记录的严格 JSON 校验器。
    /// 与 Protocol/Schema/visualbridge-editor-bridge.schema.json 保持镜像；
    /// 共享 parity fixture 同时由 AJV（generator）与 Unity EditMode 测试执行。
    /// </summary>
    public static class VisualBridgeEditorBridgeValidator
    {
        public const int ProtocolVersion = 1;
        public const int DiscoveryFormatVersion = 1;

        private static readonly Regex RequestIdPattern = new Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$", RegexOptions.Compiled);
        private static readonly Regex TokenPattern = new Regex("^[0-9a-f]{48,64}$", RegexOptions.Compiled);
        private static readonly Regex UuidPattern = new Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", RegexOptions.Compiled | RegexOptions.IgnoreCase);
        private static readonly Regex PipePathPattern = new Regex("^\\\\\\\\.\\\\pipe\\\\[A-Za-z0-9][A-Za-z0-9._-]{0,200}$", RegexOptions.Compiled);
        private static readonly Regex AbsolutePathPattern = new Regex("^(?:[A-Za-z]:)?/(?!.*//)(?!.*(?:^|/)\\.{1,2}(?:/|$))(?!.*\\\\)(?!.*/$)(?:[^/]+/)*[^/]+$", RegexOptions.Compiled);
        private static readonly Regex StartedAtPattern = new Regex("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$", RegexOptions.Compiled);

        private static readonly HashSet<string> Capabilities = new HashSet<string>(StringComparer.Ordinal) { "open", "reveal" };
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

            RequireOnlyKeys(value, "$", "formatVersion", "protocolVersion", "windowId", "capabilities", "projectRoots", "pipePath", "tcpPort", "token", "pid", "generation", "startedAt");
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

            var windowId = RequireString(value, "windowId", "$.windowId");
            if (!UuidPattern.IsMatch(windowId))
            {
                throw Error("bridge.invalidMessage", "$.windowId", "Expected a UUID window identifier.");
            }

            var capabilities = RequireCapabilities(value, "$.capabilities");
            var projectRoots = RequireProjectRoots(value, "$.projectRoots");
            var pipePath = RequireString(value, "pipePath", "$.pipePath");
            if (!PipePathPattern.IsMatch(pipePath))
            {
                throw Error("bridge.invalidMessage", "$.pipePath", "Expected a Windows named pipe path.");
            }

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
                throw Error("bridge.invalidMessage", "$.generation", "Expected a positive server generation.");
            }

            var startedAtText = RequireString(value, "startedAt", "$.startedAt");
            if (!StartedAtPattern.IsMatch(startedAtText) || !DateTime.TryParse(startedAtText, null, System.Globalization.DateTimeStyles.AssumeUniversal | System.Globalization.DateTimeStyles.AdjustToUniversal, out var startedAt))
            {
                throw Error("bridge.invalidMessage", "$.startedAt", "Expected a UTC ISO date-time.");
            }

            return new VisualBridgeBridgeWindow
            {
                WindowId = windowId,
                ProtocolVersion = protocolVersion,
                Capabilities = capabilities,
                ProjectRoots = projectRoots,
                PipePath = pipePath,
                TcpPort = tcpPort,
                Token = token,
                Pid = pid,
                Generation = generation,
                StartedAt = startedAt,
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
                    value["token"] = message.Token;
                    value["clientInstanceId"] = message.ClientInstanceId;
                    value["capabilities"] = new JArray(message.Capabilities);
                    break;
                case VisualBridgeBridgeMessageType.Welcome:
                    value["type"] = "welcome";
                    value["protocolVersion"] = message.ProtocolVersion;
                    value["windowId"] = message.WindowId;
                    value["serverGeneration"] = message.ServerGeneration;
                    value["capabilities"] = new JArray(message.Capabilities);
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

        internal static VisualBridgeBridgeMessage CreateHello(string clientInstanceId, string token, IReadOnlyList<string> capabilities)
        {
            return new VisualBridgeBridgeMessage
            {
                Type = VisualBridgeBridgeMessageType.Hello,
                ProtocolVersion = ProtocolVersion,
                Token = token,
                ClientInstanceId = clientInstanceId,
                Capabilities = capabilities,
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
            RequireOnlyKeys(value, "$", "type", "protocolVersion", "token", "clientInstanceId", "capabilities");
            var protocolVersion = RequireVersion(value, "$.protocolVersion");
            var token = RequireString(value, "token", "$.token");
            if (!TokenPattern.IsMatch(token))
            {
                throw Error("bridge.invalidToken", "$.token", "Expected a hex authentication token.");
            }

            var clientInstanceId = RequireString(value, "clientInstanceId", "$.clientInstanceId");
            if (!UuidPattern.IsMatch(clientInstanceId))
            {
                throw Error("bridge.invalidMessage", "$.clientInstanceId", "Expected a UUID client instance identifier.");
            }

            return new VisualBridgeBridgeMessage
            {
                Type = VisualBridgeBridgeMessageType.Hello,
                ProtocolVersion = protocolVersion,
                Token = token,
                ClientInstanceId = clientInstanceId,
                Capabilities = RequireCapabilities(value, "$.capabilities"),
            };
        }

        private static VisualBridgeBridgeMessage ValidateWelcome(JObject value)
        {
            RequireOnlyKeys(value, "$", "type", "protocolVersion", "windowId", "serverGeneration", "capabilities");
            var protocolVersion = RequireVersion(value, "$.protocolVersion");
            var windowId = RequireString(value, "windowId", "$.windowId");
            if (!UuidPattern.IsMatch(windowId))
            {
                throw Error("bridge.invalidMessage", "$.windowId", "Expected a UUID window identifier.");
            }

            var serverGeneration = RequireInteger(value, "serverGeneration", "$.serverGeneration");
            if (serverGeneration < 1)
            {
                throw Error("bridge.invalidMessage", "$.serverGeneration", "Expected a positive server generation.");
            }

            return new VisualBridgeBridgeMessage
            {
                Type = VisualBridgeBridgeMessageType.Welcome,
                ProtocolVersion = protocolVersion,
                WindowId = windowId,
                ServerGeneration = serverGeneration,
                Capabilities = RequireCapabilities(value, "$.capabilities"),
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
                return new VisualBridgeBridgeMessage
                {
                    Type = VisualBridgeBridgeMessageType.Reveal,
                    RequestId = requestId,
                    ReferenceValue = reference.Value<long>().ToString(System.Globalization.CultureInfo.InvariantCulture),
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

        private static int RequireVersion(JObject value, string path)
        {
            var protocolVersion = RequireInteger(value, "protocolVersion", path);
            if (protocolVersion != ProtocolVersion)
            {
                throw Error("bridge.unsupportedProtocolVersion", path, $"Expected protocolVersion {ProtocolVersion}.");
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

        private static IReadOnlyList<string> RequireCapabilities(JObject value, string path)
        {
            var token = value["capabilities"];
            if (!(token is JArray array) || array.Count == 0)
            {
                throw Error("bridge.invalidMessage", path, "Expected a non-empty capabilities array.");
            }

            var capabilities = new List<string>(array.Count);
            var unique = new HashSet<string>(StringComparer.Ordinal);
            for (var index = 0; index < array.Count; index++)
            {
                if (array[index].Type != JTokenType.String || !Capabilities.Contains(array[index].Value<string>(), StringComparer.Ordinal))
                {
                    throw Error("bridge.invalidMessage", $"{path}[{index}]", "Expected a registered capability.");
                }

                if (!unique.Add(array[index].Value<string>()))
                {
                    throw Error("bridge.invalidMessage", $"{path}[{index}]", "Duplicate capability.");
                }

                capabilities.Add(array[index].Value<string>());
            }

            return capabilities;
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
