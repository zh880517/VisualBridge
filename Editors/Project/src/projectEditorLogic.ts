import type {
  DocumentTypeDefinition,
  ProjectFileIssue,
  ProjectProviderDefinition,
  VisualBridgeProjectDefinition,
} from "@visualbridge/core";

export interface ProjectStateMessage {
  readonly type: "projectState";
  readonly documentVersion: number;
  readonly sourceHash: string;
  readonly project: VisualBridgeProjectDefinition;
  readonly isDirty: boolean;
  readonly issues: readonly ProjectFileIssue[];
}

export interface ProjectInvalidMessage {
  readonly type: "projectInvalid";
  readonly documentVersion: number;
  readonly sourceHash: string;
  readonly isDirty: boolean;
  readonly issues: readonly ProjectFileIssue[];
}

export type ProjectHostMessage = ProjectStateMessage | ProjectInvalidMessage
  | { readonly type: "operationRejected"; readonly message: string }
  | { readonly type: "requestReady"; readonly webviewToken: string };

export interface ProjectEditorState {
  readonly state?: ProjectStateMessage;
  readonly invalid?: ProjectInvalidMessage;
  readonly pending: boolean;
  readonly status: string;
  readonly providerDraft?: ProjectProviderDefinition;
}

export const initialProjectEditorState: ProjectEditorState = {
  pending: false,
  status: "正在加载工程设置…",
};

export function reduceProjectHostMessage(
  current: ProjectEditorState,
  message: ProjectHostMessage,
): ProjectEditorState {
  switch (message.type) {
    case "requestReady":
      return current;
    case "projectState": {
      const providerDraft = current.providerDraft !== undefined
        && !providerDraftIsPersisted(message.project, current.providerDraft)
        ? current.providerDraft
        : undefined;
      return {
        state: message,
        pending: false,
        status: "配置有效",
        ...(providerDraft === undefined ? {} : { providerDraft }),
      };
    }
    case "projectInvalid":
      return {
        invalid: message,
        pending: false,
        status: "工程文件无效",
      };
    case "operationRejected":
      return { ...current, pending: false, status: message.message };
  }
}

export function providerDraftIsPersisted(
  project: VisualBridgeProjectDefinition,
  draft: ProjectProviderDefinition | undefined,
): boolean {
  return draft !== undefined && project.providers.some((provider) => provider.id === draft.id);
}

export function clearProviderDraft(state: ProjectEditorState): ProjectEditorState {
  const { providerDraft: _draft, ...rest } = state;
  return rest;
}

export function createDocumentType(project: VisualBridgeProjectDefinition): DocumentTypeDefinition {
  let index = project.documentTypes.length + 1;
  while (project.documentTypes.some((entry) => entry.id === `document.type.${index}`)) index += 1;
  return {
    id: `document.type.${index}`,
    editor: "structured",
    include: [`Config/**/*.type${index}`],
    exclude: [],
    catalogs: [],
  };
}

export function createProvider(project: VisualBridgeProjectDefinition): ProjectProviderDefinition {
  let index = project.providers.length + 1;
  while (project.providers.some((entry) => entry.id === `project.provider.${index}`)) index += 1;
  return {
    id: `project.provider.${index}`,
    entry: `Providers/provider-${index}.mjs`,
    args: [],
    capabilities: { reference: { kinds: [`custom.reference.${index}`] } },
  };
}

export function withReferenceKinds(
  provider: ProjectProviderDefinition,
  kinds: readonly string[],
): ProjectProviderDefinition["capabilities"] {
  return {
    ...(kinds.length === 0 ? {} : { reference: { kinds } }),
    ...(provider.capabilities.validator === undefined ? {} : { validator: provider.capabilities.validator }),
  };
}

export function withValidatorTypes(
  provider: ProjectProviderDefinition,
  documentTypes: readonly string[],
): ProjectProviderDefinition["capabilities"] {
  return {
    ...(provider.capabilities.reference === undefined ? {} : { reference: provider.capabilities.reference }),
    ...(documentTypes.length === 0 ? {} : { validator: { documentTypes } }),
  };
}

export function move<T>(values: readonly T[], from: number, to: number): T[] {
  const result = [...values];
  const [entry] = result.splice(from, 1);
  if (entry !== undefined) result.splice(to, 0, entry);
  return result;
}

export function withWebviewToken(message: unknown, token: string | undefined): unknown {
  return token === undefined || typeof message !== "object" || message === null || Array.isArray(message)
    ? message
    : { ...message, webviewToken: token };
}
