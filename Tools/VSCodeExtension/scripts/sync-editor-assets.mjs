import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const graphEditorDist = path.resolve(extensionRoot, "..", "..", "Editors", "Graph", "dist");
const entityEditorDist = path.resolve(extensionRoot, "..", "..", "Editors", "Entity", "dist");
const tableEditorDist = path.resolve(extensionRoot, "..", "..", "Editors", "Table", "dist");
const webviewDist = path.join(extensionRoot, "dist", "webview");

await mkdir(webviewDist, { recursive: true });
await Promise.all([
  copyFile(path.join(graphEditorDist, "graphEditor.js"), path.join(webviewDist, "graphEditor.js")),
  copyFile(path.join(graphEditorDist, "graphEditor.css"), path.join(webviewDist, "graphEditor.css")),
  copyFile(path.join(entityEditorDist, "entityEditor.js"), path.join(webviewDist, "entityEditor.js")),
  copyFile(path.join(entityEditorDist, "entityEditor.css"), path.join(webviewDist, "entityEditor.css")),
  copyFile(path.join(tableEditorDist, "tableEditor.js"), path.join(webviewDist, "tableEditor.js")),
  copyFile(path.join(tableEditorDist, "tableEditor.css"), path.join(webviewDist, "tableEditor.css")),
]);
