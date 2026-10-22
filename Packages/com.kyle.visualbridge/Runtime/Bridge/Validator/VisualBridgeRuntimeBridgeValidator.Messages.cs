using System;
using System.Collections.Generic;
using Newtonsoft.Json.Linq;

namespace VisualBridge.Runtime
{
    public static partial class VisualBridgeRuntimeBridgeValidator
    {
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
