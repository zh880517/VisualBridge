using System.Collections.Generic;
using Newtonsoft.Json.Linq;

namespace VisualBridge.Runtime
{
    public static partial class VisualBridgeRuntimeBridgeValidator
    {
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

    }
}
