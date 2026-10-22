import { fileURLToPath } from "node:url";
import { buildEditor, run } from "../../../Tools/Build/editorBuild.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

await run(() =>
  buildEditor({
    root,
    entryPoints: ["src/webview/index.tsx"],
    outfile: "dist/entityEditor.js",
  }),
);
