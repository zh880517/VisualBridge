/**
 * 把宿主自己仍要托管的 Webview 资产复制进 `dist/webview`。
 *
 * C2 之后四个领域编辑器的脚本/样式来自各自 `.vbmodule.js` 里内嵌的 webview 文本，由宿主解包到
 * `<globalStorage>/modules/<sha256>/`（见 `src/modules/webviewAssets.ts`）。这里只剩 Project
 * Settings 面板：它是宿主内建 UI，不是模块。
 */
import { copyFile, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectEditorDist = path.resolve(extensionRoot, "..", "..", "Editors", "Project", "dist");
const webviewDist = path.join(extensionRoot, "dist", "webview");

await mkdir(webviewDist, { recursive: true });
// 旧版本把按 editor 命名的静态产物放在这里；不清理会让"已不再托管领域 Webview"的断言失真。
await Promise.all([
  rm(path.join(webviewDist, "graphEditor.js"), { force: true }),
  rm(path.join(webviewDist, "graphEditor.css"), { force: true }),
  rm(path.join(webviewDist, "entityEditor.js"), { force: true }),
  rm(path.join(webviewDist, "entityEditor.css"), { force: true }),
  rm(path.join(webviewDist, "structuredEditor.js"), { force: true }),
  rm(path.join(webviewDist, "structuredEditor.css"), { force: true }),
  rm(path.join(webviewDist, "tableEditor.js"), { force: true }),
  rm(path.join(webviewDist, "tableEditor.css"), { force: true }),
]);
await Promise.all([
  copyFile(path.join(projectEditorDist, "projectEditor.js"), path.join(webviewDist, "projectEditor.js")),
  copyFile(path.join(projectEditorDist, "projectEditor.css"), path.join(webviewDist, "projectEditor.css")),
]);
