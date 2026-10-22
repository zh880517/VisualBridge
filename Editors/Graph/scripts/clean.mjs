import { fileURLToPath } from "node:url";
import { cleanEditor, run } from "../../../Tools/Build/editorBuild.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

await run(() => cleanEditor({ root, dist: true, testDist: true }));
