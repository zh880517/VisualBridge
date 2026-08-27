export interface GraphEditorMetadata {
  readonly projectId: string;
  readonly documentType: string;
  readonly relativePath: string;
}

export interface GraphEditorHtmlOptions {
  readonly cspSource: string;
  readonly nonce: string;
  readonly scriptUri: string;
  readonly styleUri: string;
  readonly metadata: GraphEditorMetadata;
}

export function createGraphEditorHtml(options: GraphEditorHtmlOptions): string {
  const projectId = escapeHtml(options.metadata.projectId);
  const documentType = escapeHtml(options.metadata.documentType);
  const relativePath = escapeHtml(options.metadata.relativePath);
  const cspSource = escapeHtml(options.cspSource);
  const scriptUri = escapeHtml(options.scriptUri);
  const styleUri = escapeHtml(options.styleUri);

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${options.nonce}';">
  <title>VisualBridge Graph</title>
  <link rel="stylesheet" href="${styleUri}">
</head>
<body>
  <div
    id="root"
    data-project-id="${projectId}"
    data-document-type="${documentType}"
    data-relative-path="${relativePath}"
  ></div>
  <script nonce="${options.nonce}" src="${scriptUri}"></script>
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
