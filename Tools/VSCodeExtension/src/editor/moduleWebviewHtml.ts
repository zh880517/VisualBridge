/**
 * 宿主统一的 Webview HTML 生成（C2）：取代 `Editors/*` 里 5 份复制粘贴的模板。
 *
 * 三条约束（附录 D.6）：
 * 1. **CSP 固定**为四个领域编辑器的并集，模块只能贡献 title/script/style，调用方也不能改写；
 *    这里不接受任何 CSP 参数，唯一的 CSP 文本由 `MODULE_WEBVIEW_CSP` 一处产生。
 * 2. nonce 必须落在唯一的 `<script>` 上（`script-src 'nonce-…'` 是唯一脚本放行方式）。
 * 3. 领域编辑器的根节点必须带 `data-project-id` / `data-document-type` / `data-relative-path`，
 *    因为 Webview 首屏从这三项读 Project 上下文；没有 metadata 的编辑器（Project Settings）
 *    只输出 `<div id="root">`。
 *
 * 排版刻意保留旧模板的字节：有 metadata 时用多行根节点、没有时用单行 body，
 * 这样 Graph 的输出与旧 `graphEditorHtml.ts` **逐字节相同**，Entity/Structured 只差 CSP 一行
 * （旧模板缺少 `img-src`）。改动排版会让"除 CSP 外无差异"的证明失效。
 */
export interface ModuleWebviewMetadata {
  readonly projectId: string;
  readonly documentType: string;
  readonly relativePath: string;
}

export interface ModuleWebviewHtmlInput {
  /** 完整窗口标题；领域编辑器由宿主编成 `VisualBridge <webviewTitle>`。 */
  readonly title: string;
  /** `webview.cspSource`；只允许出现在 CSP 的 `img-src`/`style-src` 与资源链接里。 */
  readonly cspSource: string;
  readonly nonce: string;
  readonly scriptUri: string;
  readonly styleUri: string;
  /** 缺省表示该编辑器不消费 Project 上下文（Project Settings）。 */
  readonly metadata?: ModuleWebviewMetadata;
}

/**
 * 附录 D.6 的固定 CSP（四个领域编辑器的并集）。
 *
 * `data:` 是给 Webview 里内联的图标/图片用的；`'unsafe-inline'` 只作用于 `style-src`
 * （React 按组件写 style 属性），脚本侧仍然只有 nonce 一条路。
 */
export function moduleWebviewCsp(cspSource: string, nonce: string): string {
  return "default-src 'none'; img-src " + escapeHtml(cspSource) + " data:; "
    + "style-src " + escapeHtml(cspSource) + " 'unsafe-inline'; "
    + "script-src 'nonce-" + escapeHtml(nonce) + "';";
}

export function createModuleWebviewHtml(input: ModuleWebviewHtmlInput): string {
  const csp = moduleWebviewCsp(input.cspSource, input.nonce);
  const nonce = escapeHtml(input.nonce);
  const scriptUri = escapeHtml(input.scriptUri);
  const styleUri = escapeHtml(input.styleUri);
  const body = input.metadata === undefined
    ? `<body><div id="root"></div><script nonce="${nonce}" src="${scriptUri}"></script></body>`
    : `<body>
  <div
    id="root"
    data-project-id="${escapeHtml(input.metadata.projectId)}"
    data-document-type="${escapeHtml(input.metadata.documentType)}"
    data-relative-path="${escapeHtml(input.metadata.relativePath)}"
  ></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>${escapeHtml(input.title)}</title>
  <link rel="stylesheet" href="${styleUri}">
</head>
${body}
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
