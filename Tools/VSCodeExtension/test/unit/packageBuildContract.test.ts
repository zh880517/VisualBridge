import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

interface PackageManifest {
  readonly scripts?: Readonly<Record<string, string>>;
}

interface TypeScriptConfig {
  readonly compilerOptions?: {
    readonly tsBuildInfoFile?: string;
  };
}

const repositoryRoot = path.resolve(__dirname, "../../../../..");

test("VSIX packaging bootstraps every host runtime dependency from a clean checkout", async () => {
  const rootManifest = await readManifest("package.json");
  const extensionManifest = await readManifest("Tools/VSCodeExtension/package.json");
  const nodeHostTsconfig = await readJson<TypeScriptConfig>("Tools/NodeHost/tsconfig.json");

  assertCommandsInOrder(rootManifest, "package:vscode", [
    "npm run package:vsix --workspace visualbridge",
  ]);
  assertCommandsInOrder(extensionManifest, "package:vsix", [
    "npm run build:host-dependencies",
    "npm run build",
    "npm run prepare:package",
    "vsce package --no-dependencies --out artifacts/visualbridge.vsix",
  ]);
  assertCommandsInOrder(extensionManifest, "build:host-dependencies", [
    "npm run build --workspace @visualbridge/core",
    "npm run build --workspace @visualbridge/node-host",
    "npm run build --workspace @visualbridge/entity",
    "npm run build --workspace @visualbridge/graph",
    "npm run build --workspace @visualbridge/structured",
    "npm run build --workspace @visualbridge/table",
  ]);
  assert.equal(
    nodeHostTsconfig.compilerOptions?.tsBuildInfoFile,
    "dist/tsconfig.tsbuildinfo",
    "NodeHost incremental state must be removed together with dist so a missing runtime entry point is rebuilt.",
  );
});

test("packaged VS Code CLI validation always rebuilds the VSIX first", async () => {
  const rootManifest = await readManifest("package.json");

  assertCommandsInOrder(rootManifest, "test:vscode:cli", [
    "npm run package:vscode",
    "npm run test:cli --workspace visualbridge",
  ]);
});

async function readManifest(relativePath: string): Promise<PackageManifest> {
  return readJson<PackageManifest>(relativePath);
}

async function readJson<T>(relativePath: string): Promise<T> {
  return JSON.parse(await readFile(path.join(repositoryRoot, relativePath), "utf8")) as T;
}

function assertCommandsInOrder(
  manifest: PackageManifest,
  scriptName: string,
  expectedCommands: readonly string[],
): void {
  const script = manifest.scripts?.[scriptName];
  assert.ok(typeof script === "string", `Missing package script '${scriptName}'.`);
  const commands = script.split(/\s*&&\s*/u);

  let previousIndex = -1;
  for (const expectedCommand of expectedCommands) {
    const commandIndex = commands.indexOf(expectedCommand);
    assert.notEqual(commandIndex, -1, `'${scriptName}' must invoke '${expectedCommand}'.`);
    assert.ok(commandIndex > previousIndex, `'${scriptName}' must invoke '${expectedCommand}' in build order.`);
    previousIndex = commandIndex;
  }
}
