import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await mkdir(path.join(root, "dist"), { recursive: true });
await Promise.all([
  build({
    absWorkingDir: root,
    entryPoints: ["src/webview/index.tsx"],
    bundle: true,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    format: "iife",
    minify: true,
    outfile: "dist/projectEditor.js",
    platform: "browser",
    sourcemap: true,
    target: "es2022"
  }),
  copyFile(path.join(root, "src", "styles.css"), path.join(root, "dist", "projectEditor.css")),
]);
