import type {
  DocumentTypeDefinition,
  JsonValue,
  ProjectFileIssue,
  ProjectModuleDefinition,
  ProjectModuleOptions,
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
  readonly moduleDraft?: ProjectModuleDefinition;
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
      const moduleDraft = current.moduleDraft !== undefined
        && !moduleDraftIsPersisted(message.project, current.moduleDraft)
        ? current.moduleDraft
        : undefined;
      return {
        state: message,
        pending: false,
        status: "配置有效",
        ...(providerDraft === undefined ? {} : { providerDraft }),
        ...(moduleDraft === undefined ? {} : { moduleDraft }),
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

export function moduleDraftIsPersisted(
  project: VisualBridgeProjectDefinition,
  draft: ProjectModuleDefinition | undefined,
): boolean {
  return draft !== undefined && project.modules.some((module) => module.id === draft.id);
}

export function clearModuleDraft(state: ProjectEditorState): ProjectEditorState {
  const { moduleDraft: _draft, ...rest } = state;
  return rest;
}

/**
 * 新建模块的默认条目。模块 ID 必须与 bundle manifest 一致，因此编辑器不提供既有模块的重命名，
 * 只在草稿阶段允许编辑 ID。
 */
export function createModule(project: VisualBridgeProjectDefinition): ProjectModuleDefinition {
  let index = project.modules.length + 1;
  while (project.modules.some((entry) => entry.id === `project.module.${index}`)) index += 1;
  return { id: `project.module.${index}`, entry: `Modules/module-${index}.vbmodule.js` };
}

/** 模块 options 的编辑文本；未声明时显示空对象。 */
export function moduleOptionsText(module: ProjectModuleDefinition): string {
  return `${JSON.stringify(module.options ?? {}, undefined, 2)}`;
}

/**
 * 解析编辑器里的 options JSON。返回 undefined 表示不是 JSON 对象，调用方应保留草稿并提示。
 * 空对象表示清空 options（Project Operation 省略 options 字段）。
 */
export function parseModuleOptions(text: string): ProjectModuleOptions | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, JsonValue>>
    : undefined;
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
