import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.join(extensionRoot, ".test-dist");
const tsc = path.resolve(extensionRoot, "..", "..", "node_modules", "typescript", "bin", "tsc");
const compiledTest = path.join(outputRoot, "test", "unit", "webviewEpoch.test.js");

await rm(outputRoot, { recursive: true, force: true });
try {
  await run(process.execPath, [tsc, "-p", path.join(extensionRoot, "tsconfig.test.json")]);
  await run(process.execPath, ["--test", compiledTest]);
} finally {
  await rm(outputRoot, { recursive: true, force: true });
}

async function run(executable, args) {
  const child = await execute(executable, args, { cwd: extensionRoot, windowsHide: true });
  if (child.stdout.length > 0) process.stdout.write(child.stdout);
  if (child.stderr.length > 0) process.stderr.write(child.stderr);
}
