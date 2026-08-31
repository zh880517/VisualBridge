import { constants } from "node:fs";
import { access, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import GithubSlugger from "github-slugger";
import { JSDOM } from "jsdom";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(packageRoot, "../..");
const errors = [];
const parserModules = new Map();
const markdownProcessor = unified().use(remarkParse).use(remarkGfm);
const ignoredDirectories = new Set([
  ".git",
  ".test-dist",
  ".utmp",
  ".vscode-test",
  "Library",
  "Temp",
  "artifacts",
  "dist",
  "node_modules",
]);

const markdownFiles = await collectMarkdownFiles(repositoryRoot);
const documents = new Map();
for (const absolutePath of markdownFiles) {
  const relativePath = relative(absolutePath);
  const text = await readFile(absolutePath, "utf8");
  documents.set(relativePath, {
    absolutePath,
    relativePath,
    text,
    tree: markdownProcessor.parse(text),
  });
}

checkRequiredEntrypoints(documents);
checkRootDocumentationScript();
await checkRelativeLinksAndAnchors(documents);
await checkDocIndex(documents);
await checkTempDirectory();
checkDocumentedNpmScripts(documents);
await checkMermaidFences(documents);
await checkJsonFences(documents);
await checkVsCodeSurface(documents);
await checkMcpSurface(documents);

if (errors.length > 0) {
  throw new Error(`Documentation contract check failed with ${errors.length} issue(s):\n${errors.map((error) => `- ${error}`).join("\n")}`);
}

console.log(`Checked ${documents.size} Markdown files, relative links/GitHub anchors, Mermaid and JSON fences, Doc coverage, 22 VS Code commands, 4 custom editors, 2 views, and 7 MCP tools.`);

function checkRequiredEntrypoints(allDocuments) {
  for (const entrypoint of [
    "README.md",
    "Tools/VSCodeExtension/README.md",
    "Samples/PreUnityAuthoring/README.md",
  ]) {
    if (!allDocuments.has(entrypoint)) fail(`Required documentation entrypoint '${entrypoint}' is missing.`);
  }
}

function checkRootDocumentationScript() {
  const rootPackage = readJsonSync(path.join(repositoryRoot, "package.json"));
  const commands = rootPackage.scripts?.["check:docs"]?.split(/\s*&&\s*/u) ?? [];
  const sampleBuildIndex = commands.indexOf("npm run test:samples");
  const documentationIndex = commands.indexOf("npm run check --workspace @visualbridge/documentation");
  const mcpIndex = commands.indexOf("npm run check:mcp --workspace @visualbridge/protocol-contract");
  if (!(sampleBuildIndex >= 0 && documentationIndex > sampleBuildIndex && mcpIndex > documentationIndex)) {
    fail("Root check:docs must build and validate product parsers through test:samples before documentation examples, then check the live MCP contract.");
  }
}

async function collectMarkdownFiles(root) {
  const result = [];
  await walk(root, async (absolutePath, relativePath, entry) => {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".md") return;
    const normalized = normalize(relativePath);
    if (
      entry.name === "README.md"
      || normalized.startsWith("Doc/")
      || normalized.startsWith("Samples/")
    ) result.push(absolutePath);
  });
  return result.sort((left, right) => compareOrdinal(relative(left), relative(right)));
}

async function walk(root, visit, current = root) {
  const entries = (await readdir(current, { withFileTypes: true })).sort((left, right) => compareOrdinal(left.name, right.name));
  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const absolutePath = path.join(current, entry.name);
    const relativePath = path.relative(root, absolutePath);
    if (entry.isDirectory()) await walk(root, visit, absolutePath);
    else await visit(absolutePath, relativePath, entry);
  }
}

async function checkRelativeLinksAndAnchors(allDocuments) {
  const anchors = new Map();
  for (const document of allDocuments.values()) anchors.set(document.relativePath, collectAnchors(document.tree));
  for (const document of allDocuments.values()) {
    for (const node of nodes(document.tree)) {
      if (["link", "image", "definition"].includes(node.type) && typeof node.url === "string") {
        await checkLink(document, node.url, node.position?.start?.line ?? 1, anchors);
      }
      if (node.type === "html" && typeof node.value === "string") {
        for (const match of node.value.matchAll(/(?:href|src)\s*=\s*["']([^"']+)["']/giu)) {
          await checkLink(document, match[1], node.position?.start?.line ?? 1, anchors);
        }
      }
    }
  }
}

function collectAnchors(tree) {
  const slugger = new GithubSlugger();
  const result = new Set();
  for (const node of nodes(tree)) {
    if (node.type === "heading") result.add(slugger.slug(nodeText(node)));
  }
  return result;
}

async function checkLink(document, url, line, anchors) {
  const label = `${document.relativePath}:${line}`;
  if (url.length === 0 || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(url)) return;
  if (url.includes("\\")) {
    fail(`${label} uses a backslash in Markdown link '${url}'.`);
    return;
  }
  const hashIndex = url.indexOf("#");
  const pathAndQuery = hashIndex < 0 ? url : url.slice(0, hashIndex);
  const rawFragment = hashIndex < 0 ? "" : url.slice(hashIndex + 1);
  const rawPath = pathAndQuery.split("?", 1)[0];
  if (rawPath.startsWith("/")) {
    fail(`${label} must use a repository-relative link instead of '${url}'.`);
    return;
  }
  let decodedPath;
  let fragment;
  try {
    decodedPath = decodeURIComponent(rawPath);
    fragment = decodeURIComponent(rawFragment).replace(/^user-content-/u, "");
  } catch {
    fail(`${label} contains invalid URL encoding in '${url}'.`);
    return;
  }
  const targetPath = decodedPath.length === 0
    ? document.absolutePath
    : path.resolve(path.dirname(document.absolutePath), ...decodedPath.split("/"));
  if (!isInside(repositoryRoot, targetPath)) {
    fail(`${label} link '${url}' escapes the repository.`);
    return;
  }
  if (!await existsExact(targetPath)) {
    fail(`${label} points to missing or case-mismatched target '${url}'.`);
    return;
  }
  if (fragment.length === 0) return;
  const targetRelative = relative(targetPath);
  if (path.extname(targetPath).toLowerCase() !== ".md") return;
  const targetAnchors = anchors.get(targetRelative);
  if (targetAnchors === undefined || !targetAnchors.has(fragment)) {
    fail(`${label} points to missing GitHub heading '#${fragment}' in ${targetRelative}.`);
  }
}

async function existsExact(absolutePath) {
  try {
    await access(absolutePath, constants.R_OK);
  } catch {
    return false;
  }
  const relativePath = path.relative(repositoryRoot, absolutePath);
  if (relativePath.length === 0) return true;
  let current = repositoryRoot;
  for (const segment of relativePath.split(path.sep)) {
    const entries = await readdir(current);
    if (!entries.includes(segment)) return false;
    current = path.join(current, segment);
  }
  return true;
}

async function checkDocIndex(allDocuments) {
  const index = allDocuments.get("Doc/README.md");
  if (index === undefined) {
    fail("Doc/README.md is missing.");
    return;
  }
  const expected = (await readdir(path.join(repositoryRoot, "Doc"), { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "README.md")
    .map((entry) => entry.name)
    .sort(compareOrdinal);
  const linked = new Set();
  for (const node of nodes(index.tree)) {
    if (node.type !== "link" || typeof node.url !== "string") continue;
    const rawPath = node.url.split("#", 1)[0].split("?", 1)[0];
    if (rawPath.length === 0 || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(rawPath)) continue;
    try {
      const target = path.resolve(path.dirname(index.absolutePath), ...decodeURIComponent(rawPath).split("/"));
      if (path.dirname(target) === path.join(repositoryRoot, "Doc") && path.extname(target) === ".md") {
        linked.add(path.basename(target));
      }
    } catch {
      // 非法编码由 checkRelativeLinksAndAnchors 带文件与行号上下文报告。
    }
  }
  for (const name of expected) {
    if (!linked.has(name)) fail(`Doc/README.md does not link to Doc/${name}.`);
  }
}

async function checkTempDirectory() {
  const tempRoot = path.join(repositoryRoot, "Doc", "Temp");
  const entries = await readdir(tempRoot, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort(compareOrdinal);
  if (entries.some((entry) => !entry.isFile()) || JSON.stringify(names) !== JSON.stringify([".gitkeep"])) {
    fail(`Doc/Temp must contain only .gitkeep; found ${names.join(", ") || "nothing"}.`);
  }
}

function checkDocumentedNpmScripts(allDocuments) {
  const packageFiles = new Map();
  const rootPackage = readJsonSync(path.join(repositoryRoot, "package.json"));
  packageFiles.set(repositoryRoot, rootPackage);
  for (const workspace of rootPackage.workspaces) {
    const workspaceRoot = path.join(repositoryRoot, ...workspace.split("/"));
    packageFiles.set(workspaceRoot, readJsonSync(path.join(workspaceRoot, "package.json")));
  }
  const packagesByName = new Map([...packageFiles.values()].map((value) => [value.name, value]));
  for (const document of allDocuments.values()) {
    for (const match of document.text.matchAll(/npm run\s+([A-Za-z0-9:._-]+)(?:\s+--workspace(?:=|\s+)([A-Za-z0-9@/._-]+))?/gu)) {
      const [, scriptName, workspaceName] = match;
      const line = lineAt(document.text, match.index);
      if (workspaceName !== undefined) {
        const targetPackage = packagesByName.get(workspaceName);
        if (targetPackage?.scripts?.[scriptName] === undefined) {
          fail(`${document.relativePath}:${line} mentions missing script '${scriptName}' in workspace '${workspaceName}'.`);
        }
        continue;
      }
      const nearest = nearestPackage(document.absolutePath, packageFiles);
      if (nearest?.scripts?.[scriptName] === undefined && rootPackage.scripts?.[scriptName] === undefined) {
        fail(`${document.relativePath}:${line} mentions unknown npm script '${scriptName}'.`);
      }
    }
  }
}

function nearestPackage(file, packages) {
  let current = path.dirname(file);
  while (isInside(repositoryRoot, current) || current === repositoryRoot) {
    if (packages.has(current)) return packages.get(current);
    if (current === repositoryRoot) return undefined;
    current = path.dirname(current);
  }
  return undefined;
}

async function checkMermaidFences(allDocuments) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  const previousGlobals = new Map();
  for (const key of ["window", "document", "navigator", "DOMParser", "HTMLElement", "SVGElement", "Element", "Node"]) {
    previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: key in dom.window ? dom.window[key] : dom.window,
    });
  }
  const { default: mermaid } = await import("mermaid");
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
  try {
    for (const document of allDocuments.values()) {
      for (const node of nodes(document.tree)) {
        if (node.type !== "code" || node.lang?.toLowerCase() !== "mermaid") continue;
        try {
          await mermaid.parse(node.value);
        } catch (error) {
          fail(`${document.relativePath}:${node.position?.start?.line ?? 1} has invalid Mermaid: ${formatError(error)}`);
        }
      }
    }
  } finally {
    dom.window.close();
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor === undefined) delete globalThis[key];
      else Object.defineProperty(globalThis, key, descriptor);
    }
  }
}

async function checkJsonFences(allDocuments) {
  const schemaCompiler = await createSchemaCompiler();
  for (const document of allDocuments.values()) {
    for (const node of nodes(document.tree)) {
      if (node.type !== "code" || !["json", "jsonc"].includes(node.lang?.toLowerCase())) continue;
      const line = node.position?.start?.line ?? 1;
      const metadata = parseFenceMetadata(node.meta ?? "", document.relativePath, line);
      let value;
      try {
        value = JSON.parse(node.value);
      } catch (error) {
        fail(`${document.relativePath}:${line} contains invalid JSON: ${formatError(error)}`);
        continue;
      }
      if (metadata.schema === undefined && metadata.parser === undefined) {
        fail(`${document.relativePath}:${line} has an unmarked JSON fence; add visualbridge-schema=... and, for complete documents, visualbridge-parser=... metadata.`);
        continue;
      }
      if (metadata.parser !== undefined && metadata.schema === undefined) {
        fail(`${document.relativePath}:${line} uses a product parser without the corresponding formal Schema.`);
      }
      if (metadata.schema !== undefined && !metadata.schema.includes("#/") && metadata.parser === undefined) {
        fail(`${document.relativePath}:${line} is a complete root-Schema example and must also declare visualbridge-parser=... .`);
      }
      if (metadata.schema !== undefined) validateSchemaExample(schemaCompiler, metadata.schema, value, document.relativePath, line);
      if (metadata.parser !== undefined) await validateParserExample(metadata.parser, node.value, document.relativePath, line);
    }
  }
}

function parseFenceMetadata(meta, document, line) {
  const result = {};
  const known = new Set(["visualbridge-schema", "visualbridge-parser"]);
  for (const token of meta.trim().split(/\s+/u).filter(Boolean)) {
    const separator = token.indexOf("=");
    const key = separator < 0 ? token : token.slice(0, separator);
    if (!key.startsWith("visualbridge-")) continue;
    if (!known.has(key) || separator < 0 || separator === token.length - 1) {
      fail(`${document}:${line} has invalid JSON fence metadata '${token}'.`);
      continue;
    }
    const property = key.slice("visualbridge-".length);
    if (result[property] !== undefined) fail(`${document}:${line} repeats '${key}'.`);
    result[property] = token.slice(separator + 1);
  }
  return result;
}

async function createSchemaCompiler() {
  const schemaRoot = path.join(repositoryRoot, "Protocol", "Schema");
  const schemaFiles = (await readdir(schemaRoot)).filter((name) => name.endsWith(".schema.json")).sort(compareOrdinal);
  const schemas = await Promise.all(schemaFiles.map(async (name) => ({
    name,
    schema: JSON.parse(await readFile(path.join(schemaRoot, name), "utf8")),
  })));
  const compiler = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, strictTypes: false });
  compiler.addFormat("uuid", /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
  compiler.addFormat("date-time", {
    type: "string",
    validate: (value) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value) && Number.isFinite(Date.parse(value)),
  });
  schemas.forEach(({ schema }) => compiler.addSchema(schema));
  compiler.schemaFiles = new Map(schemas.map(({ name, schema }) => [name, schema.$id]));
  return compiler;
}

function validateSchemaExample(compiler, marker, value, document, line) {
  const [fileName, fragment = ""] = marker.split("#", 2);
  const schemaId = compiler.schemaFiles.get(fileName);
  if (schemaId === undefined) {
    fail(`${document}:${line} names unknown schema '${fileName}'.`);
    return;
  }
  const validator = compiler.getSchema(`${schemaId}${fragment.length === 0 ? "" : `#${fragment}`}`);
  if (validator === undefined) {
    fail(`${document}:${line} names missing schema fragment '#${fragment}' in ${fileName}.`);
    return;
  }
  if (!validator(value)) fail(`${document}:${line} fails ${marker}: ${formatAjvErrors(validator.errors)}`);
}

async function validateParserExample(marker, text, document, line) {
  const definition = parserDefinition(marker);
  if (definition === undefined) {
    fail(`${document}:${line} names unknown production parser '${marker}'.`);
    return;
  }
  const [modulePath, exportName, inputKind] = definition;
  try {
    let module = parserModules.get(modulePath);
    if (module === undefined) {
      module = await import(pathToFileURL(path.join(repositoryRoot, ...modulePath.split("/"))).href);
      parserModules.set(modulePath, module);
    }
    const result = module[exportName](inputKind === "json-value" ? JSON.parse(text) : text);
    const diagnostics = result?.issues ?? result?.diagnostics ?? [];
    const failed = result?.success !== true || diagnostics.some((diagnostic) => diagnostic.severity === "error");
    if (failed) fail(`${document}:${line} fails production parser '${marker}': ${JSON.stringify(diagnostics)}`);
  } catch (error) {
    fail(`${document}:${line} could not run production parser '${marker}': ${formatError(error)}`);
  }
}

function parserDefinition(marker) {
  return {
    "project": ["Core/dist/index.js", "parseProjectFile"],
    "catalog-source": ["Core/dist/index.js", "parseCatalogSourceDefinition", "json-value"],
    "graph-document": ["BuiltInExtensions/Graph/dist/index.js", "parseGraphDocument"],
    "graph-catalog": ["BuiltInExtensions/Graph/dist/index.js", "parseGraphCatalog"],
    "entity-document": ["BuiltInExtensions/Entity/dist/index.js", "parseEntityDocument"],
    "entity-catalog": ["BuiltInExtensions/Entity/dist/index.js", "parseEntityCatalog"],
    "structured-document": ["BuiltInExtensions/StructuredConfig/dist/index.js", "parseStructuredDocument"],
    "structured-catalog": ["BuiltInExtensions/StructuredConfig/dist/index.js", "parseStructuredCatalog"],
    "table-catalog": ["BuiltInExtensions/Table/dist/index.js", "parseTableCatalog"],
  }[marker];
}

async function checkVsCodeSurface(allDocuments) {
  const manifest = JSON.parse(await readFile(path.join(repositoryRoot, "Tools", "VSCodeExtension", "package.json"), "utf8"));
  const contributions = manifest.contributes ?? {};
  const commands = contributions.commands?.map((entry) => entry.command) ?? [];
  const customEditors = contributions.customEditors?.map((entry) => entry.viewType) ?? [];
  const views = Object.values(contributions.views ?? {}).flat().map((entry) => entry.id);
  if (commands.length !== 22) fail(`VS Code manifest must expose 22 commands; found ${commands.length}.`);
  if (customEditors.length !== 4) fail(`VS Code manifest must expose 4 custom editors; found ${customEditors.length}.`);
  if (views.length !== 2) fail(`VS Code manifest must expose 2 views; found ${views.length}.`);
  assertUnique(commands, "VS Code commands");
  assertUnique(customEditors, "VS Code custom editors");
  assertUnique(views, "VS Code views");

  const sourceRoot = path.join(repositoryRoot, "Tools", "VSCodeExtension", "src");
  const sourceFiles = [];
  await walk(sourceRoot, async (absolutePath, _relativePath, entry) => {
    if (entry.isFile() && entry.name.endsWith(".ts")) sourceFiles.push(absolutePath);
  });
  const source = (await Promise.all(sourceFiles.map((file) => readFile(file, "utf8")))).join("\n");
  const constants = new Map([...source.matchAll(/\b(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=\s*["']([^"']+)["']/gu)].map((match) => [match[1], match[2]]));
  const runtimeCommands = [...source.matchAll(/registerCommand\(\s*["']([^"']+)["']/gsu)]
    .map((match) => match[1])
    .filter((command) => !command.startsWith("visualbridge.test."));
  assertSameSet(runtimeCommands, commands, "VS Code manifest/runtime commands");

  const extensionGuide = allDocuments.get("Tools/VSCodeExtension/README.md");
  if (extensionGuide !== undefined) {
    const commandTables = [...nodes(extensionGuide.tree)].filter((node) => (
      node.type === "table"
      && node.children?.[0]?.children?.[0] !== undefined
      && nodeText(node.children[0].children[0]).trim() === "Command ID"
    ));
    if (commandTables.length !== 1) {
      fail(`Tools/VSCodeExtension/README.md must contain exactly one Command ID table; found ${commandTables.length}.`);
    } else {
      const documentedCommands = commandTables[0].children.slice(1).map((row) => (
        nodeText(row.children?.[0] ?? {}).trim()
      ));
      for (const command of documentedCommands) {
        if (!/^visualbridge\.[A-Za-z0-9.]+$/u.test(command)) {
          fail(`Tools/VSCodeExtension/README.md Command ID table contains invalid entry '${command}'.`);
        }
      }
      assertUnique(documentedCommands, "VS Code Extension README commands");
      assertSameSet(documentedCommands, commands, "VS Code Extension README/manifest commands");
    }
  }
  const runtimeEditors = [...source.matchAll(/registerCustomEditorProvider\(\s*([A-Z][A-Z0-9_]*|["'][^"']+["'])/gsu)]
    .map((match) => resolveStaticToken(match[1], constants));
  assertSameSet(runtimeEditors, customEditors, "VS Code manifest/runtime custom editors");
  const runtimeViews = [...source.matchAll(/createTreeView\(\s*([A-Z][A-Z0-9_]*|["'][^"']+["'])/gsu)]
    .map((match) => resolveStaticToken(match[1], constants));
  assertSameSet(runtimeViews, views, "VS Code manifest/runtime views");

  const projectSource = await readFile(path.join(repositoryRoot, "Core", "Project", "projectFile.ts"), "utf8");
  const projectFileName = /PROJECT_FILE_NAME\s*=\s*"([^"]+)"/u.exec(projectSource)?.[1];
  const expectedActivation = `workspaceContains:**/${projectFileName}`;
  if (JSON.stringify(manifest.activationEvents) !== JSON.stringify([expectedActivation])) {
    fail(`VS Code activationEvents must equal ['${expectedActivation}'].`);
  }

  const validationEntries = contributions.jsonValidation ?? [];
  const validationSchemas = validationEntries.map((entry) => path.basename(entry.url)).sort(compareOrdinal);
  const expectedValidationSchemas = [
    "visualbridge-entity-catalog.schema.json",
    "visualbridge-entity.schema.json",
    "visualbridge-graph-catalog.schema.json",
    "visualbridge-graph.schema.json",
    "visualbridge-project.schema.json",
    "visualbridge-structured-catalog.schema.json",
    "visualbridge-structured.schema.json",
    "visualbridge-table-catalog.schema.json",
  ].sort(compareOrdinal);
  assertSameSet(validationSchemas, expectedValidationSchemas, "VS Code jsonValidation schemas");
  for (const entry of validationEntries) {
    if (!entry.url.startsWith("./dist/schemas/")) fail(`VS Code jsonValidation URL '${entry.url}' is not packaged under dist/schemas.`);
    if (!await existsExact(path.join(repositoryRoot, "Protocol", "Schema", path.basename(entry.url)))) {
      fail(`VS Code jsonValidation source '${entry.url}' is missing from Protocol/Schema.`);
    }
  }
  const syncScript = await readFile(path.join(repositoryRoot, "Tools", "VSCodeExtension", "scripts", "sync-protocol-assets.mjs"), "utf8");
  const synchronizedSchemas = [...syncScript.matchAll(/"(visualbridge-[^"]+\.schema\.json)"/gu)].map((match) => match[1]);
  for (const schema of validationSchemas) {
    if (!synchronizedSchemas.includes(schema)) fail(`VS Code jsonValidation schema '${schema}' is not synchronized into the VSIX.`);
  }

  const hostGuide = allDocuments.get("Doc/VSCodeHost.md")?.text ?? "";
  if (!/22\s*条[^\n]*命令/u.test(hostGuide)) fail("Doc/VSCodeHost.md must state the 22-command public surface.");
  if (!/4\s*个\s*Custom Editor/iu.test(hostGuide)) fail("Doc/VSCodeHost.md must state the four Custom Editor surface.");
  for (const id of [...customEditors, ...views]) {
    if (!hostGuide.includes(id)) fail(`Doc/VSCodeHost.md does not mention '${id}'.`);
  }
}

async function checkMcpSurface(allDocuments) {
  const manifest = JSON.parse(await readFile(path.join(repositoryRoot, "Protocol", "contract-manifest.json"), "utf8"));
  const schema = JSON.parse(await readFile(path.join(repositoryRoot, "Protocol", "Schema", "visualbridge-mcp-tools.schema.json"), "utf8"));
  const serverSource = await readFile(path.join(repositoryRoot, "Tools", "VisualBridgeMcp", "src", "server.ts"), "utf8");
  const registered = [...serverSource.matchAll(/registerTool\(\s*["'](visualbridge_[a-z_]+)["']/gsu)].map((match) => match[1]);
  const inputs = Object.keys(schema.$defs ?? {}).filter((name) => name.endsWith(".input")).map((name) => name.slice(0, -6));
  const outputs = Object.keys(schema.$defs ?? {}).filter((name) => name.endsWith(".output")).map((name) => name.slice(0, -7));
  if (manifest.mcpTools?.length !== 7) fail(`Protocol manifest must register 7 MCP tools; found ${manifest.mcpTools?.length ?? 0}.`);
  assertSameSet(registered, manifest.mcpTools ?? [], "MCP runtime/manifest tools");
  assertSameSet(inputs, manifest.mcpTools ?? [], "MCP input Schema/manifest tools");
  assertSameSet(outputs, manifest.mcpTools ?? [], "MCP output Schema/manifest tools");
  for (const documentName of ["Doc/VisualBridgeMcp.md", "Doc/ProtocolContracts.md"]) {
    const text = allDocuments.get(documentName)?.text ?? "";
    for (const tool of manifest.mcpTools ?? []) {
      if (!text.includes(tool)) fail(`${documentName} does not mention MCP tool '${tool}'.`);
    }
  }
}

function* nodes(root) {
  yield root;
  for (const child of root.children ?? []) yield* nodes(child);
}

function nodeText(node) {
  if (typeof node.value === "string") return node.value;
  if (typeof node.alt === "string") return node.alt;
  return (node.children ?? []).map(nodeText).join("");
}

function readJsonSync(file) {
  const text = process.getBuiltinModule("node:fs").readFileSync(file, "utf8");
  return JSON.parse(text);
}

function resolveStaticToken(token, constants) {
  if (token.startsWith('"') || token.startsWith("'")) return token.slice(1, -1);
  const value = constants.get(token);
  if (value === undefined) fail(`Could not resolve static VS Code registration token '${token}'.`);
  return value;
}

function assertUnique(values, label) {
  if (new Set(values).size !== values.length) fail(`${label} contain duplicates.`);
}

function assertSameSet(actual, expected, label) {
  const normalizedActual = [...new Set(actual)].sort(compareOrdinal);
  const normalizedExpected = [...new Set(expected)].sort(compareOrdinal);
  if (JSON.stringify(normalizedActual) !== JSON.stringify(normalizedExpected)) {
    fail(`${label} drift. Actual=${JSON.stringify(normalizedActual)} Expected=${JSON.stringify(normalizedExpected)}.`);
  }
}

function formatAjvErrors(value) {
  return (value ?? []).map((entry) => `${entry.instancePath || "/"} ${entry.message}`).join("; ");
}

function lineAt(text, index) { return text.slice(0, index).split(/\r?\n/u).length; }
function relative(value) { return normalize(path.relative(repositoryRoot, value)); }
function normalize(value) { return value.replaceAll("\\", "/"); }
function isInside(root, value) { const result = path.relative(root, value); return result === "" || (!result.startsWith("..") && !path.isAbsolute(result)); }
function compareOrdinal(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function formatError(value) { return value instanceof Error ? value.message : String(value); }
function fail(message) { errors.push(message); }
