import * as vscode from "vscode";
import { parseReferenceDefinition, type DocumentDiagnostic } from "@visualbridge/core";
import type { ProjectContext } from "../project/projectRegistry";
import type { WorkspaceReferenceService } from "./workspaceReferenceService";

export interface ReferenceWebviewMessage {
  readonly type?: unknown;
  readonly requestId?: unknown;
  readonly definition?: unknown;
  readonly value?: unknown;
}

export async function handleReferenceMessage(
  message: ReferenceWebviewMessage,
  webview: vscode.Webview,
  project: ProjectContext,
  references: WorkspaceReferenceService,
): Promise<boolean> {
  if (message.type !== "pickReference" && message.type !== "revealReference") {
    return false;
  }
  const diagnostics: DocumentDiagnostic[] = [];
  const definition = parseReferenceDefinition(message.definition, "reference", diagnostics);
  const value = message.value;
  if (definition === undefined || (typeof value !== "string" && typeof value !== "number")) {
    if (message.type === "pickReference" && typeof message.requestId === "string") {
      await webview.postMessage({ type: "referenceCancelled", requestId: message.requestId });
    }
    throw new Error(formatDiagnostics(diagnostics));
  }
  if (message.type === "revealReference") {
    await references.reveal(project, definition, value);
    return true;
  }
  if (typeof message.requestId !== "string") {
    throw new Error("Reference selection requires a requestId.");
  }
  const candidate = await references.pick(project, definition, value);
  await webview.postMessage(candidate === undefined
    ? { type: "referenceCancelled", requestId: message.requestId }
    : { type: "referenceSelected", requestId: message.requestId, value: candidate.value });
  return true;
}

function formatDiagnostics(diagnostics: readonly DocumentDiagnostic[]): string {
  const first = diagnostics[0];
  return first === undefined ? "Invalid reference request." : `${first.path}: ${first.message}`;
}
