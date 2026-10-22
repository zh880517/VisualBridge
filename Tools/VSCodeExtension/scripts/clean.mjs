import { fileURLToPath } from "node:url";
import { cleanEditor, run } from "../../Build/editorBuild.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

await run(() => cleanEditor({ root, dist: true, artifacts: true }));
