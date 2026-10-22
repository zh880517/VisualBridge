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
