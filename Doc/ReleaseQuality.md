# Release Quality

This document defines the reproducible PU-07 release gate for the Node.js monorepo and the private VS Code package. It does not add a public license or a Unity release gate.

## Fixed toolchain and dependencies

- `.nvmrc` and the root `engines.node` fix Node.js to `22.22.1`.
- The root `packageManager` fixes npm to `10.9.4`, the npm release shipped by that Node.js distribution.
- `.npmrc` enables `engine-strict` and `save-exact`. Switch to the `.nvmrc` version before running any install; a different local Node.js version is expected to be rejected.
- Every external npm dependency in a workspace manifest uses an exact `major.minor.patch` version. Internal `@visualbridge/*` workspace dependencies remain `*` so npm resolves the local workspace rather than a registry package.
- Root transitive overrides also use exact versions. `exceljs` is constrained to `uuid` 11.1.1 because its declared `^8.3.0` range otherwise selects a release affected by GHSA-w5hq-g745-h8pq; VisualBridge exercises the CommonJS `v4` API through ExcelJS and keeps that path under Table/XLSX tests.
- `package-lock.json` lockfile version 3 is generated with npm 10.9.4 and is the only accepted installation input. Release and CI installs use `npm ci`, never a lockfile-updating install.
- The VS Code compatibility declaration remains `^1.105.1`, while the Extension Host runtime is fixed separately to `1.105.1`, `@types/vscode` to `1.105.0`, and `@vscode/test-electron` to `3.1.0`.

`npm run check:dependencies` enforces these invariants for the root and every declared npm workspace. It also checks each package is private and `UNLICENSED`, verifies lockfile importer and override resolutions, the VS Code test runner defaults, and `virtualWorkspaces.supported=false`. Adding a workspace automatically brings it under this policy. `npm run audit:dependencies` is a separate network-backed gate and fails on moderate-or-higher advisories.

## Local clean reproduction

Use a Node version manager to select the declared runtime, then confirm both executables before installation:

```powershell
nvm use 22.22.1
node --version  # v22.22.1
npm --version   # 10.9.4
npm ci
npm run check
npm run audit:dependencies
npm test
npm run build
npm run package:vscode
npm run test:cli --workspace visualbridge
git diff --check
git status --short --untracked-files=all
```

For an explicit empty-download-cache reproduction, point npm at a newly created temporary directory. `npm ci` always removes and recreates `node_modules`; the separate cache contains downloads only and cannot restore build output or an old dependency tree.

```powershell
$releaseCache = Join-Path ([System.IO.Path]::GetTempPath()) ("visualbridge-npm-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $releaseCache | Out-Null
npm ci --cache $releaseCache
```

The temporary cache can be removed after the gate. Do not update the lockfile from a newer local Node/npm runtime to make a failing environment appear compatible.

## Windows CI gate

`.github/workflows/ci.yml` runs on a fresh GitHub-hosted Windows worker and performs the following ordered gate:

1. checks out the exact revision and installs the Node version from `.nvmrc`;
2. verifies the observed Node and npm versions before dependency installation;
3. runs `npm ci` from the committed lockfile;
4. runs dependency policy, a moderate-or-higher dependency audit, monorepo type checks, all tests, and the complete build;
5. creates the VSIX and exercises it through the installed VS Code CLI;
6. rejects whitespace errors, tracked-file changes, and unexpected untracked files created by generation/build/test/package;
7. uploads only the resulting VSIX artifact.

The workflow pins third-party GitHub Actions by full commit SHA. `setup-node` may cache npm downloads keyed by `package-lock.json`, but it never caches `node_modules`, build output, VS Code user data, or installed extensions. Tests create isolated user-data, extension, workspace, and Provider process state.

## VSIX evidence and distribution boundary

The ordinary Extension Host suite uses the fixed official VS Code runtime and covers trusted and Restricted Mode activation against copied fixtures. The packaged test then installs the produced VSIX into an isolated extensions directory, checks its exact `kyl.visualbridge` identity and required packaged files, launches the fixed VS Code runtime, waits for `workspaceContains` activation, invokes a registered command, and opens a Graph through the installed custom editor. A successful CLI install alone is not treated as activation proof.

The extension manifest is `private: true` and `license: "UNLICENSED"`. No license text is inferred or generated. `virtualWorkspaces.supported` is explicitly `false`: Project discovery, local Catalog/source access, atomic writes, and Project Provider child processes require a local file-system workspace. Restricted Mode remains supported, but Provider processes are not started there.

## Maintained sample project

`Samples/PreUnityAuthoring` is the formal text-reviewable project used before Unity integration. It contains a Project file, custom Graph/Entity/Structured document extensions, all four built-in Catalog/document families, a partition-compatible UTF-8 tab-delimited CSV Table, and an optional Project Provider V2 example. XLSX is deliberately omitted from this minimum sample; the Table test suite owns its binary round-trip coverage.

Run `npm run test:samples` to exercise the production Project parser and matcher, Graph/Entity/Structured/Table Catalog registries and validators, typed CSV parser, and Project Provider host against the sample. The sample README explains how to open it from the installed VSIX and how to remove the optional trusted Provider declaration.
