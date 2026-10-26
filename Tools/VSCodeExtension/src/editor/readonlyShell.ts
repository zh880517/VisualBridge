/**
 * 模块未加载时的只读 Shell。
 *
 * DocumentEditorProvider 与 TableEditorGate 共用同一份 HTML：Restricted Mode / 模块失败时
 * 两个入口都必须给出同样的"只读 + 原因"体验，且不启用脚本、不加载任何领域资源。
 */
import * as nodePath from "node:path";
import * as vscode from "vscode";
import type { DocumentMatch } from "../project/projectRegistry";

export function readonlyShellTitle(match: DocumentMatch, uri: vscode.Uri): string {
  return `${match.documentType.id}: ${nodePath.basename(uri.fsPath)}`;
}

export function createReadonlyShellHtml(
  webview: vscode.Webview,
  match: DocumentMatch,
  documentText: string,
  message: string,
): string {
  const projectId = escapeHtml(match.project.definition.projectId);
  const documentType = escapeHtml(match.documentType.id);
  const editor = escapeHtml(match.documentType.editor);
  const relativePath = escapeHtml(match.relativePath);
  const notice = escapeHtml(message);
  // 表格文档可能是 XLSX 二进制源；只读视图不预览内容，避免把二进制当文本渲染。
  const sourceBlock = match.documentType.editor === "table"
    ? `<p class="hint">表格源文件可能是 CSV/XLSX 等二进制源，只读视图不展示内容。</p>`
    : `<pre>${escapeHtml(documentText)}</pre>`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'none';">
  <title>VisualBridge Document</title>
  <style>
    body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); }
    header { padding: 16px 20px; border-bottom: 1px solid var(--vscode-panel-border); }
    h1 { margin: 0 0 10px; font-size: 18px; font-weight: 600; }
    dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 14px; margin: 0; font-size: 12px; color: var(--vscode-descriptionForeground); }
    dt { font-weight: 600; }
    dd { margin: 0; font-family: var(--vscode-editor-font-family); }
    main { padding: 20px; }
    .notice { margin: 0 0 6px; color: var(--vscode-inputValidation-warningForeground, var(--vscode-foreground)); font-weight: 600; }
    .hint { margin: 0 0 14px; color: var(--vscode-descriptionForeground); }
    pre { box-sizing: border-box; min-height: 240px; margin: 0; padding: 14px; overflow: auto; white-space: pre-wrap; border: 1px solid var(--vscode-input-border); background: var(--vscode-textCodeBlock-background); font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
  </style>
</head>
<body>
  <header>
    <h1>VisualBridge Document（只读）</h1>
    <dl>
      <dt>Project</dt><dd>${projectId}</dd>
      <dt>Type</dt><dd>${documentType}</dd>
      <dt>Editor module</dt><dd>${editor}</dd>
      <dt>Path</dt><dd>${relativePath}</dd>
    </dl>
  </header>
  <main>
    <p class="notice">${notice}</p>
    <p class="hint">模块未加载时 VisualBridge 只提供只读视图；文档内容仍以源文件为准。</p>
    ${sourceBlock}
  </main>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#039;");
}
