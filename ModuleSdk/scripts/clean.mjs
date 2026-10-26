import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sdkRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
await rm(path.join(sdkRoot, "dist"), { recursive: true, force: true });
await rm(path.join(sdkRoot, "tsconfig.tsbuildinfo"), { force: true });
