/**
 * Webview 骨架：生命周期握手（ready proposal + token 回显）、postMessage 封装与
 * `--vb-*` 主题 Token。
 *
 * `referenceBridge` 的迁移不在本骨架内；宿主先处理生命周期握手、reference bridge
 * 与调试窗口消息，这三类消息不会转发给会话控制器。
 */

import { MODULE_API_VERSION } from "../index";

export const WEBVIEW_READY_TYPE = "visualbridge.ready" as const;
export const WEBVIEW_READY_ACK_TYPE = "visualbridge.readyAck" as const;

/** 宿主生成的 HTML 中 `#root` 上的 token 属性名。 */
export const WEBVIEW_TOKEN_ATTRIBUTE = "data-vb-token";

export interface WebviewReadyProposal {
  readonly type: typeof WEBVIEW_READY_TYPE;
  readonly apiVersion: number;
  readonly token: string;
}

export interface WebviewReadyAcknowledgement {
  readonly type: typeof WEBVIEW_READY_ACK_TYPE;
  readonly token: string;
}

/** 与宿主通信的最小目标面；VS Code 的 `acquireVsCodeApi()` 或 `window.parent` 均可实现。 */
export interface WebviewMessageTarget {
  postMessage(message: unknown, targetOrigin?: string): void;
}

/** `window` 的消息监听面。 */
export interface WebviewMessageSource {
  addEventListener(type: "message", listener: (event: WebviewMessageEventLike) => void): void;
  removeEventListener(type: "message", listener: (event: WebviewMessageEventLike) => void): void;
}

export interface WebviewMessageEventLike {
  readonly data: unknown;
}

export interface VsCodeWebviewApi extends WebviewMessageTarget {
  getState?(): unknown;
  setState?(state: unknown): void;
}

interface VsCodeApiGlobal {
  acquireVsCodeApi?: () => VsCodeWebviewApi;
}

export interface WebviewBridgeOptions {
  /** 消息发送目标；默认使用 `acquireVsCodeApi()`，否则 `window.parent`。 */
  readonly target?: WebviewMessageTarget;
  /** 消息监听源；默认 `window`。 */
  readonly source?: WebviewMessageSource;
  /** 自定义握手 token；省略时从 `#root[data-vb-token]` 读取，再否则随机生成。 */
  readonly token?: string;
  /** 期望的 `apiVersion`；默认 `MODULE_API_VERSION`。 */
  readonly apiVersion?: number;
  /** 等待 ready ack 的超时毫秒数；设为 0 关闭超时。默认 15000。 */
  readonly readyTimeoutMs?: number;
}

export interface WebviewBridge {
  /** ready ack 已回显 token 后 resolve。 */
  readonly ready: Promise<void>;
  readonly token: string;
  postMessage(message: unknown): void;
  /** 订阅握手之外的消息；返回取消订阅函数。 */
  onMessage(listener: (message: unknown) => void): () => void;
  dispose(): void;
}

/** 生成 ready proposal；token 用于让宿主原样回显。 */
export function createReadyProposal(
  token: string = createWebviewToken(),
  apiVersion: number = MODULE_API_VERSION,
): WebviewReadyProposal {
  return { type: WEBVIEW_READY_TYPE, apiVersion, token };
}

export function isWebviewReadyProposal(value: unknown): value is WebviewReadyProposal {
  return isRecord(value)
    && value.type === WEBVIEW_READY_TYPE
    && typeof value.apiVersion === "number"
    && typeof value.token === "string";
}

export function isWebviewReadyAcknowledgement(value: unknown): value is WebviewReadyAcknowledgement {
  return isRecord(value)
    && value.type === WEBVIEW_READY_ACK_TYPE
    && typeof value.token === "string";
}

/**
 * 连接宿主并完成生命周期握手。
 *
 * 握手期间（包括 ack）的消息不会交给 `onMessage` 订阅者。
 */
export function connectWebviewBridge(options: WebviewBridgeOptions = {}): WebviewBridge {
  const source = options.source ?? defaultMessageSource();
  const token = options.token ?? readWebviewToken() ?? createWebviewToken();
  const apiVersion = options.apiVersion ?? MODULE_API_VERSION;
  const target = options.target ?? defaultMessageTarget();
  const messageListeners = new Set<(message: unknown) => void>();
  let settled = false;
  let disposed = false;
  let resolveReady: () => void = () => undefined;
  let rejectReady: (error: Error) => void = () => undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const onMessage = (event: WebviewMessageEventLike): void => {
    if (disposed) return;
    const message = event.data;
    if (isWebviewReadyAcknowledgement(message)) {
      if (message.token !== token || settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolveReady();
      return;
    }
    for (const listener of messageListeners) {
      listener(message);
    }
  };

  source.addEventListener("message", onMessage);
  target.postMessage(createReadyProposal(token, apiVersion), "*");

  const timeoutMs = options.readyTimeoutMs ?? 15_000;
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      if (settled || disposed) return;
      settled = true;
      rejectReady(new Error(
        `VisualBridge webview ready handshake timed out after ${timeoutMs} ms (token '${token}').`,
      ));
    }, timeoutMs);
  }

  return {
    ready,
    token,
    postMessage(message: unknown): void {
      if (disposed) return;
      target.postMessage(message, "*");
    },
    onMessage(listener: (message: unknown) => void): () => void {
      messageListeners.add(listener);
      return () => {
        messageListeners.delete(listener);
      };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      source.removeEventListener("message", onMessage);
      messageListeners.clear();
      if (!settled) {
        settled = true;
        rejectReady(new Error("VisualBridge webview bridge was disposed before the ready acknowledgement."));
      }
    },
  };
}

/** 从 `#root` 的 `data-vb-token` 读取宿主下发的 token。 */
export function readWebviewToken(documentValue: Document | undefined = globalThis.document): string | undefined {
  const root = documentValue?.getElementById("root");
  const token = root?.getAttribute(WEBVIEW_TOKEN_ATTRIBUTE);
  return token === null || token === undefined || token === "" ? undefined : token;
}

/** 主题 Token 名称；Webview 应只消费这些变量，不硬编码 VS Code 变量名。 */
export const WEBVIEW_THEME_TOKENS = {
  background: "--vb-background",
  foreground: "--vb-foreground",
  mutedForeground: "--vb-muted-foreground",
  border: "--vb-border",
  accent: "--vb-accent",
  accentForeground: "--vb-accent-foreground",
  focusRing: "--vb-focus-ring",
  fontFamily: "--vb-font-family",
  fontSize: "--vb-font-size",
  borderRadius: "--vb-border-radius",
} as const;

export type WebviewThemeToken = keyof typeof WEBVIEW_THEME_TOKENS;

export type WebviewTheme = Partial<Record<WebviewThemeToken, string>>;

/**
 * 默认主题映射：`--vb-*` 一律回落到 VS Code 主题变量，并在缺失时给出可读的
 * 浅色/深色兜底。
 */
export const WEBVIEW_THEME_STYLE = `:root {
  --vb-background: var(--vscode-editor-background, #1f1f1f);
  --vb-foreground: var(--vscode-editor-foreground, #cccccc);
  --vb-muted-foreground: var(--vscode-descriptionForeground, #9d9d9d);
  --vb-border: var(--vscode-panel-border, #3c3c3c);
  --vb-accent: var(--vscode-focusBorder, #007acc);
  --vb-accent-foreground: var(--vscode-button-foreground, #ffffff);
  --vb-focus-ring: var(--vscode-focusBorder, #007acc);
  --vb-font-family: var(--vscode-font-family, sans-serif);
  --vb-font-size: var(--vscode-font-size, 13px);
  --vb-border-radius: var(--vscode-cornerRadius, 2px);
}`;

/** 把主题值写到目标元素的 CSS 变量上；只接受已声明的 `--vb-*` Token。 */
export function applyWebviewTheme(
  theme: WebviewTheme,
  target: HTMLElement | undefined = globalThis.document?.documentElement,
): void {
  if (target === undefined) {
    throw new Error("applyWebviewTheme requires an HTMLElement when no document is available.");
  }
  for (const token of Object.keys(theme) as WebviewThemeToken[]) {
    const value = theme[token];
    if (value !== undefined) {
      target.style.setProperty(WEBVIEW_THEME_TOKENS[token], value);
    }
  }
}

function createWebviewToken(): string {
  const cryptoValue = globalThis.crypto;
  if (typeof cryptoValue?.randomUUID === "function") {
    return cryptoValue.randomUUID();
  }
  return `vb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function defaultMessageSource(): WebviewMessageSource {
  const windowValue = globalThis.window;
  if (windowValue === undefined) {
    throw new Error("connectWebviewBridge requires a WebviewMessageSource outside a browser window.");
  }
  return windowValue;
}

function defaultMessageTarget(): WebviewMessageTarget {
  const api = (globalThis as VsCodeApiGlobal).acquireVsCodeApi?.();
  if (api !== undefined) return api;
  const windowValue = globalThis.window;
  if (windowValue === undefined) {
    throw new Error("connectWebviewBridge requires a WebviewMessageTarget outside a browser window.");
  }
  return windowValue.parent ?? windowValue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
