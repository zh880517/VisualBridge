import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const editorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

await build({
  absWorkingDir: editorRoot,
  entryPoints: ["src/webview/index.tsx"],
  bundle: true,
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  format: "iife",
  minify: true,
  outfile: "dist/structuredEditor.js",
  platform: "browser",
  sourcemap: true,
  target: "es2022",
});
