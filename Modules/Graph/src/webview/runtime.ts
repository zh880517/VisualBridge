import { createContext } from "react";
import { WebviewReferenceBridge } from "../../../Shared/Form/index";
import {
  GRAPH_INTERFACE_INPUT_NODE_ID,
  GRAPH_INTERFACE_OUTPUT_NODE_ID,
  type GraphRevealPlan,
} from "../graphReveal";
import type { DataTypeDefinition, GraphDebugHighlight, VsCodeApi } from "./types";

declare function acquireVsCodeApi(): VsCodeApi;

const rawVscode = acquireVsCodeApi();
export const webviewInstanceId = crypto.randomUUID();
let webviewToken: string | undefined;
export const vscode: VsCodeApi = {
  postMessage: (message) => rawVscode.postMessage(withWebviewToken(message, webviewToken)),
};
export const referenceBridge = new WebviewReferenceBridge(vscode);
export const INTERFACE_INPUT_NODE_ID = GRAPH_INTERFACE_INPUT_NODE_ID;
export const INTERFACE_OUTPUT_NODE_ID = GRAPH_INTERFACE_OUTPUT_NODE_ID;
export const GraphPendingContext = createContext(false);
export const GraphNodeTypeVisibilityContext = createContext(true);
export const GraphNodeIdVisibilityContext = createContext(false);
export const GraphDataTypesContext = createContext<readonly DataTypeDefinition[]>([]);
export const GraphRevealContext = createContext<GraphRevealPlan | undefined>(undefined);
export const GraphDebugContext = createContext<GraphDebugHighlight | undefined>(undefined);

export function setWebviewToken(token: string | undefined): void {
  webviewToken = token;
}

function withWebviewToken(message: unknown, token: string | undefined): unknown {
  return token === undefined || typeof message !== "object" || message === null || Array.isArray(message)
    ? message
    : { ...message, webviewToken: token };
}
