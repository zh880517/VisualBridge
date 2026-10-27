using System;
using System.Collections.Generic;
using Newtonsoft.Json.Linq;

namespace VisualBridge.Runtime
{
    public static partial class VisualBridgeRuntimeBridgeValidator
    {
        /// <summary>hello（附录 A.3）：Runtime 腿的拨号方恒为 VS Code，载荷固定 json。</summary>
        public static VisualBridgeRuntimeBridgeMessage CreateHello(string clientEndpointId, string token, string contractHash,
            IReadOnlyList<string> payloads, string resumeSessionId = null, IReadOnlyList<string> debugCategories = null,
            IReadOnlyList<string> debugInstances = null)
        {
            return new VisualBridgeRuntimeBridgeMessage
            {
                Type = VisualBridgeRuntimeBridgeMessageType.Hello,
                ProtocolVersion = ProtocolVersion,
                Role = "vscode",
                ClientEndpointId = clientEndpointId,
                Token = token,
                ContractHash = contractHash ?? string.Empty,
                Payloads = payloads,
                DebugCategories = debugCategories,
                DebugInstances = debugInstances,
                ResumeSessionId = resumeSessionId,
            };
        }

        /// <summary>welcome（附录 A.3）：监听方端点、会话身份与协商结果。</summary>
        public static VisualBridgeRuntimeBridgeMessage CreateWelcome(string endpointId, string sessionId, string bootId,
            bool resumed, string connectType, int generation, string contractHash, IReadOnlyList<string> payloads,
            bool debugEnabled, string startedAt)
        {
            return new VisualBridgeRuntimeBridgeMessage
            {
                Type = VisualBridgeRuntimeBridgeMessageType.Welcome,
                ProtocolVersion = ProtocolVersion,
                EndpointId = endpointId,
                SessionId = sessionId,
                Resumed = resumed,
                ConnectType = connectType,
                Generation = generation,
                BootId = bootId,
                ContractHash = contractHash ?? string.Empty,
                Payloads = payloads,
                DebugEnabled = debugEnabled,
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

    }
}
