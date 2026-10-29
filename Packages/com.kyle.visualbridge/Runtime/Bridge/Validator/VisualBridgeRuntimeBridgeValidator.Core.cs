using System;
using System.Collections.Generic;
using System.IO;
using System.Text.RegularExpressions;
using Newtonsoft.Json.Linq;

namespace VisualBridge.Runtime
{
    /// <summary>
    /// Runtime Bridge V1 消息与发现记录的严格 JSON 校验器。
    /// 与 Protocol/Schema/visualbridge-runtime-bridge.schema.json 保持镜像；
    /// 共享 parity fixture 同时由 AJV（generator）、Unity EditMode 测试
    /// 与扩展宿主测试执行。JSON 解析固定 DateParseHandling.None +
    /// FloatParseHandling.Decimal（Editor Bridge 同款教训：禁止日期伪装与浮点精度漂移）。
    /// </summary>
    public static partial class VisualBridgeRuntimeBridgeValidator
    {
        // 连接层版本与 Editor 腿共用同一个 4（附录 A.1/A.3）；握手形状也与 Editor 腿统一。
        public const int ProtocolVersion = 4;

        /// <summary>仅 v1 运行时发现记录仍携带 coreVersion；握手消息不再有该字段。</summary>
        public const int CoreVersion = 1;
        public const int DiscoveryFormatVersion = 1;

        private static readonly Regex StableIdPattern = new Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$", RegexOptions.Compiled);
        private static readonly Regex TokenPattern = new Regex("^[0-9a-f]{48,64}$", RegexOptions.Compiled);

        /// <summary>发现记录里的 token：Player 无认证时为空串（附录 E.3）。</summary>
        private static readonly Regex OptionalTokenPattern = new Regex("^([0-9a-f]{48,64})?$", RegexOptions.Compiled);
        private static readonly Regex UuidPattern = new Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", RegexOptions.Compiled | RegexOptions.IgnoreCase);
        private static readonly Regex InstanceIdPattern = new Regex("^(editor|player)-[0-9]+$", RegexOptions.Compiled);
        private static readonly Regex SessionIdPattern = new Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,127}#[A-Za-z0-9][A-Za-z0-9._-]{0,127}$", RegexOptions.Compiled);
        private static readonly Regex ContractHashPattern = new Regex("^(?:[0-9a-f]{16})?$", RegexOptions.Compiled);
        private static readonly Regex CompiledKindPattern = new Regex("^visualbridge\\.(structured|entity|table|graph)\\.compiled$", RegexOptions.Compiled);
        private static readonly Regex StartedAtPattern = new Regex("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$", RegexOptions.Compiled);
        // normalizedPath 语义（primitives Schema）：无前导/、无盘符冒号、无反斜杠、
        // 无点段（./ ../）、无重复斜杠、无尾斜杠。
        private static readonly Regex NormalizedPathPattern = new Regex("^(?!/)(?!.*:)(?!.*\\\\)(?!.*(?:^|/)\\.{1,2}(?:/|$))(?!.*//)(?!.*/$).+$", RegexOptions.Compiled);
        private static readonly Regex Sha256Pattern = new Regex("^[a-f0-9]{64}$", RegexOptions.Compiled);

        private static readonly HashSet<string> Capabilities = new HashSet<string>(StringComparer.Ordinal) { "snapshot", "events", "lease", "sources" };
        private static readonly HashSet<string> InstanceKinds = new HashSet<string>(StringComparer.Ordinal) { "editor-play", "player" };
        private static readonly HashSet<string> ConnectTypes = new HashSet<string>(StringComparer.Ordinal) { "editor-player", "player" };
        private static readonly HashSet<string> PayloadKinds = new HashSet<string>(StringComparer.Ordinal) { "json", "binary" };
        private static readonly HashSet<string> DialerRoles = new HashSet<string>(StringComparer.Ordinal) { "vscode" };
        private static readonly HashSet<string> RequestActions = new HashSet<string>(StringComparer.Ordinal)
        {
            "getSnapshot",
            "acquireLease",
            "releaseLease",
            "getDocumentSources",
        };

        private static readonly HashSet<string> ErrorCodes = new HashSet<string>(StringComparer.Ordinal)
        {
            "runtime.alreadyConnected",
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

        /// <summary>解析并校验一条消息 JSON 文本；非法 JSON 报 runtime.invalidJson。</summary>
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
            if (!OptionalTokenPattern.IsMatch(token))
            {
                throw Error("runtime.invalidToken", "$.token", "Expected a hex authentication token or an empty string for an unauthenticated Player.");
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
                    value["role"] = message.Role;
                    value["clientEndpointId"] = message.ClientEndpointId;
                    if (message.Token != null)
                    {
                        value["token"] = message.Token;
                    }
                    value["contractHash"] = message.ContractHash ?? string.Empty;
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
                case VisualBridgeRuntimeBridgeMessageType.Welcome:
                    value["type"] = "welcome";
                    value["protocolVersion"] = message.ProtocolVersion;
                    value["endpointId"] = message.EndpointId;
                    value["sessionId"] = message.SessionId;
                    value["resumed"] = message.Resumed;
                    value["connectType"] = message.ConnectType;
                    value["generation"] = message.Generation;
                    value["bootId"] = message.BootId;
                    value["contractHash"] = message.ContractHash ?? string.Empty;
                    value["payloads"] = new JArray(message.Payloads);
                    value["debugEnabled"] = message.DebugEnabled;
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
                        // documents / sources 互斥；都缺省为租约控制的 ok（无载荷）。
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

        private static int RequireVersion(JObject value, string property, string path, int expected)
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
            if (version != expected)
            {
                // protocolVersion 与 coreVersion 都是版本协商声明，不匹配共用同一错误码；
                // 两者期望值不同（连接层 4 / 契约核心 1），不能共用同一个常量。
                throw Error("runtime.protocolVersionMismatch", path, $"Expected {property} {expected}.");
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

        /// <summary>拨号方身份（附录 A.3 的方向层）：Runtime 腿只接受 vscode 拨号。</summary>
        private static string RequireDialerRole(JObject value, string property, string path)
        {
            var role = RequireString(value, property, path);
            if (!DialerRoles.Contains(role))
            {
                throw Error("runtime.invalidMessage", path, "Expected dialer role 'vscode' for the runtime leg.");
            }

            return role;
        }

        /// <summary>端点是标识而不是调试实例 id：与请求 id 同一字符集。</summary>
        private static string RequireEndpointId(JObject value, string property, string path)
        {
            var endpointId = RequireString(value, property, path);
            if (!StableIdPattern.IsMatch(endpointId))
            {
                throw Error("runtime.invalidMessage", path, "Expected an endpoint identifier.");
            }

            return endpointId;
        }

        private static string RequireContractHash(JObject value, string property, string path)
        {
            var contractHash = RequireString(value, property, path);
            if (!ContractHashPattern.IsMatch(contractHash))
            {
                throw Error("runtime.invalidMessage", path, "Expected 16 lowercase hex characters or an empty string.");
            }

            return contractHash;
        }

        /// <summary>协商载荷：json 必选，binary 可选（与 Editor 腿同一规则）。</summary>
        private static IReadOnlyList<string> RequirePayloads(JObject value, string property, string path)
        {
            if (!(value[property] is JArray array) || array.Count == 0)
            {
                throw Error("runtime.invalidMessage", path, "Expected a non-empty payloads array.");
            }

            var payloads = new List<string>(array.Count);
            var unique = new HashSet<string>(StringComparer.Ordinal);
            for (var index = 0; index < array.Count; index++)
            {
                if (array[index].Type != JTokenType.String || !PayloadKinds.Contains(array[index].Value<string>()))
                {
                    throw Error("runtime.invalidMessage", $"{path}[{index}]", "Expected 'json' or 'binary'.");
                }

                if (!unique.Add(array[index].Value<string>()))
                {
                    throw Error("runtime.invalidMessage", $"{path}[{index}]", "Duplicate payload.");
                }

                payloads.Add(array[index].Value<string>());
            }

            if (!unique.Contains("json"))
            {
                throw Error("runtime.invalidMessage", path, "Payloads must contain 'json'.");
            }

            return payloads;
        }

        private static string RequireSessionId(JObject value, string property, string path)
        {
            var sessionId = RequireString(value, property, path);
            if (!SessionIdPattern.IsMatch(sessionId))
            {
                throw Error("runtime.invalidMessage", path, "Expected '<endpointId>#<bootId>'.");
            }

            return sessionId;
        }

        private static string RequireConnectType(JObject value, string property, string path)
        {
            var connectType = RequireString(value, property, path);
            if (!ConnectTypes.Contains(connectType))
            {
                throw Error("runtime.invalidMessage", path, "Expected connectType 'editor-player' or 'player'.");
            }

            return connectType;
        }

        private static bool RequireBoolean(JObject value, string property, string path)
        {
            var token = value[property];
            if (token == null || token.Type != JTokenType.Boolean)
            {
                throw Error("runtime.invalidMessage", path, "Expected a boolean.");
            }

            return token.Value<bool>();
        }

        private static IReadOnlyList<string> RequireDebugFilter(JObject value, string property, string path)
        {
            var token = value[property];
            if (token == null)
            {
                return null;
            }

            if (!(token is JArray array))
            {
                throw Error("runtime.invalidMessage", path, "Expected an array of filter strings.");
            }

            var filters = new List<string>(array.Count);
            var unique = new HashSet<string>(StringComparer.Ordinal);
            for (var index = 0; index < array.Count; index++)
            {
                if (array[index].Type != JTokenType.String)
                {
                    throw Error("runtime.invalidMessage", $"{path}[{index}]", "Expected a filter string.");
                }

                var filter = array[index].Value<string>();
                if (string.IsNullOrEmpty(filter) || filter.Length > 256)
                {
                    throw Error("runtime.invalidMessage", $"{path}[{index}]", "Filter strings must be 1..256 characters.");
                }

                if (!unique.Add(filter))
                {
                    throw Error("runtime.invalidMessage", $"{path}[{index}]", "Duplicate filter entry.");
                }

                filters.Add(filter);
            }

            return filters;
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
