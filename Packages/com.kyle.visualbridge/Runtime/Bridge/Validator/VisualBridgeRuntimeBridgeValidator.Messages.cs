using System;
using System.Collections.Generic;
using Newtonsoft.Json.Linq;

namespace VisualBridge.Runtime
{
    public static partial class VisualBridgeRuntimeBridgeValidator
    {
        private static VisualBridgeRuntimeBridgeMessage ValidateHello(JObject value)
        {
            RequireOnlyKeys(value, "$",
                new[] { "type", "protocolVersion", "role", "clientEndpointId", "contractHash", "payloads" },
                new[] { "token", "debugCategories", "debugInstances", "resumeSessionId" });
            var protocolVersion = RequireVersion(value, "protocolVersion", "$.protocolVersion", ProtocolVersion);
            var role = RequireDialerRole(value, "role", "$.role");
            var clientEndpointId = RequireEndpointId(value, "clientEndpointId", "$.clientEndpointId");
            string token = null;
            if (value["token"] != null)
            {
                token = RequireString(value, "token", "$.token");
                if (!TokenPattern.IsMatch(token))
                {
                    throw Error("runtime.invalidToken", "$.token", "Expected a hex authentication token of at least 192 bits.");
                }
            }

            var contractHash = RequireContractHash(value, "contractHash", "$.contractHash");
            var payloads = RequirePayloads(value, "payloads", "$.payloads");
            var debugCategories = RequireDebugFilter(value, "debugCategories", "$.debugCategories");
            var debugInstances = RequireDebugFilter(value, "debugInstances", "$.debugInstances");
            string resumeSessionId = null;
            if (value["resumeSessionId"] != null)
            {
                resumeSessionId = RequireSessionId(value, "resumeSessionId", "$.resumeSessionId");
            }

            return new VisualBridgeRuntimeBridgeMessage
            {
                Type = VisualBridgeRuntimeBridgeMessageType.Hello,
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

        private static VisualBridgeRuntimeBridgeMessage ValidateWelcome(JObject value)
        {
            RequireOnlyKeys(value, "$", "type", "protocolVersion", "endpointId", "sessionId", "resumed",
                "connectType", "generation", "bootId", "contractHash", "payloads", "debugEnabled", "startedAt");
            var protocolVersion = RequireVersion(value, "protocolVersion", "$.protocolVersion", ProtocolVersion);
            var endpointId = RequireString(value, "endpointId", "$.endpointId");
            if (!InstanceIdPattern.IsMatch(endpointId))
            {
                throw Error("runtime.invalidMessage", "$.endpointId", "Expected an 'editor-<pid>' or 'player-<pid>' endpoint identifier.");
            }

            var sessionId = RequireSessionId(value, "sessionId", "$.sessionId");
            var resumed = RequireBoolean(value, "resumed", "$.resumed");
            var connectType = RequireConnectType(value, "connectType", "$.connectType");
            var generation = RequireInteger(value, "generation", "$.generation");
            if (generation < 1)
            {
                throw Error("runtime.invalidMessage", "$.generation", "Expected a positive instance generation.");
            }

            var bootId = RequireString(value, "bootId", "$.bootId");
            if (!StableIdPattern.IsMatch(bootId))
            {
                throw Error("runtime.invalidMessage", "$.bootId", "Expected a boot identifier.");
            }

            var contractHash = RequireContractHash(value, "contractHash", "$.contractHash");
            var payloads = RequirePayloads(value, "payloads", "$.payloads");
            var debugEnabled = RequireBoolean(value, "debugEnabled", "$.debugEnabled");
            var startedAtText = RequireString(value, "startedAt", "$.startedAt");
            if (!IsUtcDateTime(startedAtText))
            {
                throw Error("runtime.invalidMessage", "$.startedAt", "Expected a UTC ISO date-time.");
            }

            return new VisualBridgeRuntimeBridgeMessage
            {
                Type = VisualBridgeRuntimeBridgeMessageType.Welcome,
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
                StartedAt = startedAtText,
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

            // 字段与动作耦合（Schema allOf）：documentTypeIds 仅 getSnapshot。
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

                // documents / sources 互斥；都缺省为租约控制的 ok（无载荷响应）。
                var hasDocuments = value.Property("documents", StringComparison.Ordinal) != null;
                var hasSources = value.Property("sources", StringComparison.Ordinal) != null;
                var payloadCount = (hasDocuments ? 1 : 0) + (hasSources ? 1 : 0);
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

            throw Error("runtime.invalidMessage", "$.event", $"Unknown event '{eventName}'.");
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
    }
}
