# Repository Guidelines

## Project Structure & Module Organization

VisualBridge is a monorepo for the platform implementation. `Core/` contains host-independent TypeScript domain logic; it must not reference VS Code, Webview DOM, or Unity APIs. `Protocol/` owns schemas, messages, and generated cross-language contracts. Reusable Webview UI belongs in `Editors/`, while built-in document types live in `BuiltInExtensions/`. Host integrations are under `Tools/VSCodeExtension/` and `Tools/VisualBridgeMcp/`. The Unity Package source is `Packages/com.kyl.visualbridge/`; `UnityProject/` is only its development host, with Unity assets under `UnityProject/Assets/`.

Keep durable documentation in `Doc/`. Put task plans and temporary design notes in `Doc/Temp/`, then delete them when the task is complete. Read `Doc/VisualBridgeArchitecture.md` before changing module boundaries.

## Build, Test, and Development Commands

Use Node.js 22.22.1 and npm 10.9.4 as declared by `.nvmrc`, `engines.node`, and `packageManager`. Switch Node versions before installing; `.npmrc` intentionally rejects a mismatched runtime.

- `npm ci` — install the exact monorepo dependencies from the root lockfile.
- `npm run check` — type-check VisualBridgeCore and the VS Code extension.
- `npm run build` — compile Core and bundle the extension into `Tools/VSCodeExtension/dist/`.
- `npm run package:vscode` — create a VSIX under `Tools/VSCodeExtension/artifacts/`.
- `npm run test:vscode:host` — build the extension and run isolated Extension Host integration tests against the fixed VisualBridge fixtures.
- `npm run test:vscode:cli` — package the VSIX, install it into isolated VS Code user/extension directories, and verify the packaged runtime assets.
- `npm run check:docs` — validate final-document coverage, links, anchors, Mermaid diagrams, command/editor manifests, and schema-bound JSON examples.
- `dotnet build .\UnityProject\Assembly-CSharp.csproj` — compile-check Unity runtime C# without opening Unity Editor.
- `dotnet build .\UnityProject\Assembly-CSharp-Editor.csproj` — compile-check editor-only C#.
- `git diff --check` — detect whitespace errors before review.

## Code Intelligence

- Use CodeGraph first for symbol relationships, entry points, callers, callees, and change-impact analysis when its project index is available.
- Run `codegraph sync .` after source changes before relying on impact or affected-test results.
- Treat CodeGraph as navigation evidence; confirm behavior in source and with the relevant build or automated validation before reporting a result.

Open the repository root in VS Code and press `F5` to launch an Extension Development Host. Unity-generated `.csproj` files must not be edited manually.

## Coding Style & Naming Conventions

Use UTF-8 and final newlines. Indent C# with four spaces and TypeScript/JSON with two. Use `PascalCase` for C# types and public members, `camelCase` for locals and parameters, and `PascalCase` for established repository directories. Keep files focused and prefer one public C# type per file. Preserve dependency direction: Protocol → Core → VS Code/MCP adapters; Unity consumes generated protocol contracts, not TypeScript Core code.

For Webview UI, prefer maintained open-source React components over custom browser-control implementations when they cover the required behavior. Use Base UI for accessible headless interaction primitives, Lucide React for shared functional icons, and `react-colorful` for color editing; apply Visual Studio Code theme variables in repository CSS. Review license, maintenance status, React compatibility, bundle impact, and CSP behavior before adding another UI dependency. Do not use the archived `@vscode/webview-ui-toolkit`.

## Testing Guidelines

Run `npm test` for the fixed Core, Graph, Entity, Structured, Table, and MCP semantic suites. Add host-independent tests beside the relevant built-in extension and keep reusable fixtures under `TestData/`. No coverage threshold is established. Unless explicitly requested, do not add Unity tests. Validate Unity changes with the relevant `dotnet build` command and report when generated project files or unavailable Unity assemblies limit verification.

## Commit & Pull Request Guidelines

History currently contains only initialization commits, so no formal convention is established. Use short imperative subjects such as `Add document operation registry`, and keep commits scoped to one concern. Pull requests should explain the affected modules, architecture impact, validation performed, and known limitations. Include screenshots for Webview changes and call out protocol or generated-contract changes explicitly.
