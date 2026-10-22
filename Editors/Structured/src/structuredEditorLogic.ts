import type { DocumentDiagnostic } from "@visualbridge/core";
import type {
  RegisteredStructuredConfigTypeDefinition,
  StructuredDocument,
  StructuredOperation,
} from "@visualbridge/structured";

export interface StructuredStateMessage {
  readonly type: "structuredState";
  readonly documentVersion: number;
  readonly document: StructuredDocument;
  readonly configType: RegisteredStructuredConfigTypeDefinition;
  readonly isDirty: boolean;
  readonly diagnostics: readonly DocumentDiagnostic[];
}

export interface StructuredInvalidMessage {
  readonly type: "structuredInvalid";
  readonly documentVersion: number;
  readonly isDirty: boolean;
  readonly diagnostics: readonly DocumentDiagnostic[];
}

export type StructuredHostMessage = StructuredStateMessage | StructuredInvalidMessage | {
  readonly type: "operationRejected";
  readonly message: string;
} | {
  readonly type: "operationCompleted";
  readonly changed: boolean;
} | {
  readonly type: "requestReady";
  readonly webviewToken: string;
};

export interface StructuredEditorState {
  readonly state?: StructuredStateMessage;
  readonly invalid?: StructuredInvalidMessage;
  readonly pending: boolean;
  readonly status: string;
}

export const initialStructuredEditorState: StructuredEditorState = {
  pending: false,
  status: "正在加载结构化配置…",
};

export function reduceStructuredHostMessage(
  current: StructuredEditorState,
  message: StructuredHostMessage,
): StructuredEditorState {
  switch (message.type) {
    case "requestReady":
      return current;
    case "structuredState":
      return { state: message, pending: false, status: "就绪" };
    case "structuredInvalid":
      return { invalid: message, pending: false, status: "结构化配置无效" };
    case "operationRejected":
      return { ...current, pending: false, status: message.message };
    case "operationCompleted":
      return message.changed
        ? { ...current, pending: false }
        : { ...current, pending: false, status: "没有产生文档修改" };
  }
}

export function createSetFieldOperation(
  fieldId: string,
  value: StructuredOperation["value"],
): StructuredOperation {
  return { type: "structured.setField", fieldId, value };
}

export function formatDiagnosticSummary(diagnostics: readonly DocumentDiagnostic[]): string {
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
  const warnings = diagnostics.filter((diagnostic) => diagnostic.severity === "warning").length;
  return errors === 0 && warnings === 0 ? "无诊断" : `${errors} 错误 · ${warnings} 警告`;
}

export function withWebviewToken(message: unknown, token: string | undefined): unknown {
  return token === undefined || typeof message !== "object" || message === null || Array.isArray(message)
    ? message
    : { ...message, webviewToken: token };
}
