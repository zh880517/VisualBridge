export interface StructuredEditorMetadata {
  readonly projectId: string;
  readonly documentType: string;
  readonly relativePath: string;
}

export interface StructuredEditorHtmlOptions {
  readonly cspSource: string;
  readonly nonce: string;
  readonly scriptUri: string;
  readonly styleUri: string;
  readonly metadata: StructuredEditorMetadata;
}

export function createStructuredEditorHtml(options: StructuredEditorHtmlOptions): string {
  const cspSource = escapeHtml(options.cspSource);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${options.nonce}';">
  <title>VisualBridge Structured Config</title>
  <link rel="stylesheet" href="${escapeHtml(options.styleUri)}">
</head>
<body>
  <div
    id="root"
    data-project-id="${escapeHtml(options.metadata.projectId)}"
    data-document-type="${escapeHtml(options.metadata.documentType)}"
    data-relative-path="${escapeHtml(options.metadata.relativePath)}"
  ></div>
  <script nonce="${options.nonce}" src="${escapeHtml(options.scriptUri)}"></script>
</body>
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
