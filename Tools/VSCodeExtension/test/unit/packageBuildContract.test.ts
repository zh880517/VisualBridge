import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

interface PackageManifest {
  readonly scripts?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
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
  // C2：宿主 bundle 不再静态包含四个领域包，因此打包只需构建 Core 与 NodeHost；
  // 领域代码改为在运行期由 ModuleLoader 求值 `.vbmodule.js`（附录 D.6）。
  assertCommandsInOrder(extensionManifest, "build:host-dependencies", [
    "npm run build --workspace @visualbridge/core",
    "npm run build --workspace @visualbridge/node-host",
  ]);
  assert.equal(
    nodeHostTsconfig.compilerOptions?.tsBuildInfoFile,
    "dist/tsconfig.tsbuildinfo",
    "NodeHost incremental state must be removed together with dist so a missing runtime entry point is rebuilt.",
  );
});

test("the extension manifest no longer depends on domain or domain-editor packages", async () => {
  const extensionManifest = await readManifest("Tools/VSCodeExtension/package.json");
  const declared = { ...extensionManifest.dependencies, ...extensionManifest.devDependencies };
  for (const forbidden of [
    "@visualbridge/entity",
    "@visualbridge/graph",
    "@visualbridge/structured",
    "@visualbridge/table",
    "@visualbridge/entity-editor",
    "@visualbridge/graph-editor",
    "@visualbridge/project-editor",
    "@visualbridge/structured-editor",
    "@visualbridge/table-editor",
  ]) {
    assert.equal(declared[forbidden], undefined, `'${forbidden}' must not be a host dependency after C2.`);
  }
  // 宿主仍是 SDK 契约的消费者（`EditorRegistration`），因此这一条依赖必须保留。
  assert.notEqual(declared["@visualbridge/module-sdk"], undefined);
  const build = extensionManifest.scripts?.build ?? "";
  assert.doesNotMatch(build, /@visualbridge\/(?:entity|graph|structured|table)(?:-editor)?\b/u);
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
