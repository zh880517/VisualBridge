import assert from "node:assert/strict";
import test from "node:test";
import {
  createModuleWebviewHtml,
  moduleWebviewCsp,
  type ModuleWebviewHtmlInput,
  type ModuleWebviewMetadata,
} from "../../src/editor/moduleWebviewHtml";

/**
 * 旧模板的**逐字节**输出。
 *
 * 采集方法：用 esbuild 把 `Editors/{Graph,Entity,Structured,Table,Project}/src/*EditorHtml.ts`
 * 各自打成 CJS 后以同一组入参调用（C2 提交前的那一版源码），把返回值原样抄到这里。因此这组
 * 常量是"退役模板的现状"，不是用本生成器反推出来的，比对才有意义。
 */
const CSP_SOURCE = "vscode-resource://csp-source";
const NONCE = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const SCRIPT_URI = "vscode-resource://script.js";
const STYLE_URI = "vscode-resource://style.css";
const METADATA: ModuleWebviewMetadata = {
  projectId: "proj-1",
  documentType: "logicGraph",
  relativePath: "Graph/Main.vbgraph",
};

const OLD_CSP_PLAIN = "default-src 'none'; style-src vscode-resource://csp-source 'unsafe-inline'; "
  + "script-src 'nonce-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';";
const OLD_CSP_GRAPH = "default-src 'none'; img-src vscode-resource://csp-source data:; "
  + "style-src vscode-resource://csp-source 'unsafe-inline'; "
  + "script-src 'nonce-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';";
const OLD_CSP_TABLE = "default-src 'none'; img-src data:; style-src vscode-resource://csp-source 'unsafe-inline'; "
  + "script-src 'nonce-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';";

function head(title: string, csp: string): string[] {
  return [
    "<!doctype html>",
    '<html lang="zh-CN">',
    "<head>",
    '  <meta charset="UTF-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
    `  <meta http-equiv="Content-Security-Policy" content="${csp}">`,
    `  <title>${title}</title>`,
    `  <link rel="stylesheet" href="${STYLE_URI}">`,
    "</head>",
  ];
}

const MULTILINE_BODY = [
  "<body>",
  "  <div",
  '    id="root"',
  '    data-project-id="proj-1"',
  '    data-document-type="logicGraph"',
  '    data-relative-path="Graph/Main.vbgraph"',
  "  ></div>",
  `  <script nonce="${NONCE}" src="${SCRIPT_URI}"></script>`,
  "</body>",
];
const SINGLE_LINE_BODY = [
  `<body><div id="root" data-project-id="proj-1" data-document-type="logicGraph" `
  + `data-relative-path="Graph/Main.vbgraph"></div>`
  + `<script nonce="${NONCE}" src="${SCRIPT_URI}"></script></body>`,
];
const PROJECT_BODY = [
  `<body><div id="root"></div><script nonce="${NONCE}" src="${SCRIPT_URI}"></script></body>`,
];

function html(title: string, csp: string, body: readonly string[]): string {
  return [...head(title, csp), ...body, "</html>"].join("\n");
}

function input(title: string, metadata?: ModuleWebviewMetadata): ModuleWebviewHtmlInput {
  return {
    title,
    cspSource: CSP_SOURCE,
    nonce: NONCE,
    scriptUri: SCRIPT_URI,
    styleUri: STYLE_URI,
    ...(metadata === undefined ? {} : { metadata }),
  };
}

/** 返回两个等长 HTML 的行级差异下标（只用于"头部线路一致"这类同形比较）。 */
function differingLines(before: readonly string[], after: readonly string[]): number[] {
  assert.equal(before.length, after.length);
  const indexes: number[] = [];
  for (const [index, line] of before.entries()) {
    if (line !== after[index]!) indexes.push(index);
  }
  return indexes;
}

test("renders Graph byte-for-byte identically to the retired template", () => {
  const expected = html("VisualBridge Graph", OLD_CSP_GRAPH, MULTILINE_BODY);
  assert.equal(createModuleWebviewHtml(input("VisualBridge Graph", METADATA)), expected);
});

test("changes only the CSP meta line for the editors whose old template lacked a fixed CSP", () => {
  const fixedCsp = moduleWebviewCsp(CSP_SOURCE, NONCE);
  // 附录 D.6 的固定 CSP 与旧 Graph 模板一致（四个领域编辑器的并集）。
  assert.equal(fixedCsp, OLD_CSP_GRAPH);

  for (const title of ["VisualBridge Entity", "VisualBridge Structured Config"]) {
    const before = html(title, OLD_CSP_PLAIN, MULTILINE_BODY).split("\n");
    const after = createModuleWebviewHtml(input(title, METADATA)).split("\n");
    assert.deepEqual(differingLines(before, after), [5], `${title}: only the CSP line may differ`);
    assert.equal(after[5], `  <meta http-equiv="Content-Security-Policy" content="${fixedCsp}">`);
  }

  // Project Settings 没有 metadata：body 保持旧模板的单行形态，同样只差 CSP 一行。
  const projectBefore = html("VisualBridge Project Settings", OLD_CSP_PLAIN, PROJECT_BODY).split("\n");
  const projectAfter = createModuleWebviewHtml(input("VisualBridge Project Settings")).split("\n");
  assert.deepEqual(differingLines(projectBefore, projectAfter), [5]);
  assert.equal(projectAfter.slice(9).join("\n"), PROJECT_BODY.join("\n") + "\n</html>");
});

test("normalizes the Table root node to the multi-line form and widens img-src to cspSource", () => {
  const expected = html("VisualBridge Table", OLD_CSP_GRAPH, MULTILINE_BODY);
  const actual = createModuleWebviewHtml(input("VisualBridge Table", METADATA));
  assert.equal(actual, expected);
  // 旧 Table 模板的 body 是单行，这里显式记录被归一化的那一处（不是静默改写）。
  const oldTable = html("VisualBridge Table", OLD_CSP_TABLE, SINGLE_LINE_BODY);
  assert.notEqual(actual, oldTable);
  assert.equal(oldTable.split("\n")[5], `  <meta http-equiv="Content-Security-Policy" content="${OLD_CSP_TABLE}">`);
});

test("keeps the CSP fixed: only the host-supplied cspSource and nonce are interpolated", () => {
  const first = moduleWebviewCsp("vscode-resource://a", "aa");
  assert.match(first, /^default-src 'none'; img-src vscode-resource:\/\/a data:;/u);
  assert.match(first, /style-src vscode-resource:\/\/a 'unsafe-inline';/u);
  assert.match(first, /script-src 'nonce-aa';$/u);
  // 没有 `unsafe-eval`、没有 http(s) 源、没有 `*`/`data:` 出现在 script-src。
  assert.doesNotMatch(first, /unsafe-eval|https?:|\*/u);
  assert.doesNotMatch(first.split("script-src")[1]!, /data:/u);

  const rendered = createModuleWebviewHtml(input("VisualBridge Graph", METADATA));
  const scripts = rendered.match(/<script\b/gu) ?? [];
  assert.equal(scripts.length, 1, "exactly one script tag");
  assert.match(rendered, /<script nonce="0123456789abcdef[0-9a-f]+" src="vscode-resource:\/\/script\.js"><\/script>/u);
});

test("escapes every interpolated attribute so module titles cannot break out", () => {
  const rendered = createModuleWebviewHtml({
    title: '"><script>alert(1)</script>',
    cspSource: CSP_SOURCE + "\"><img src=x onerror=alert(1)>",
    nonce: '"><script>alert(1)</script>',
    scriptUri: '"><script>alert(1)</script>',
    styleUri: '"><script>alert(1)</script>',
    metadata: {
      projectId: '"><script>alert(1)</script>',
      documentType: '"><script>alert(1)</script>',
      relativePath: '"><script>alert(1)</script>',
    },
  });
  const scripts = rendered.match(/<script\b/gu) ?? [];
  assert.equal(scripts.length, 1, "escaping must not introduce a second script tag");
  assert.doesNotMatch(rendered, /"><script>alert/u);
  // 注入载荷只能以实体形式出现：输出里不得有真的 <img> 标签被浏览器解析。
  assert.doesNotMatch(rendered, /<img\b/u);
});
