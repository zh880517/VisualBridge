export interface ProjectEditorHtmlOptions {
  readonly cspSource: string;
  readonly nonce: string;
  readonly scriptUri: string;
  readonly styleUri: string;
}

export function createProjectEditorHtml(options: ProjectEditorHtmlOptions): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${escapeHtml(options.cspSource)} 'unsafe-inline'; script-src 'nonce-${options.nonce}';">
  <title>VisualBridge Project Settings</title>
  <link rel="stylesheet" href="${escapeHtml(options.styleUri)}">
</head>
<body><div id="root"></div><script nonce="${options.nonce}" src="${escapeHtml(options.scriptUri)}"></script></body>
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
