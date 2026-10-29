import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

export const CORPUS_MANIFEST_FILE = "corpus.manifest.json";

export const CORPUS_PROFILES = Object.freeze({
  correctness: Object.freeze({
    graphDocuments: 12,
    entityDocuments: 12,
    structuredDocuments: 12,
    tablePartitions: 2,
    tableRowsPerPartition: 50,
  }),
  benchmark: Object.freeze({
    graphDocuments: 1_000,
    entityDocuments: 1_000,
    structuredDocuments: 1_000,
    tablePartitions: 10,
    tableRowsPerPartition: 5_000,
  }),
});

export function resolveCorpusProfile(name, overrides = {}) {
  const base = CORPUS_PROFILES[name];
  if (base === undefined) {
    throw new Error(`Unknown corpus profile '${name}'.`);
  }
  const result = { ...base, ...overrides };
  for (const [key, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Corpus profile '${key}' must be a positive safe integer.`);
    }
  }
  return Object.freeze(result);
}

export async function generateCorpus(rootPath, options = {}) {
  const profileName = options.profile ?? "benchmark";
  const profile = resolveCorpusProfile(profileName, options.overrides);
  const seed = normalizeSeed(options.seed ?? 1);
  await ensureEmptyDirectory(rootPath);
  const files = new Map();
  const addJson = (path, value) => files.set(path, stableJson(value));
  const addText = (path, value) => files.set(path, value);

  const catalogs = createCatalogFiles();
  for (const [path, value] of Object.entries(catalogs)) {
    addJson(path, value);
  }
  addJson("VisualBridge.project.vbjson", createProjectFile());

  for (let index = 0; index < profile.graphDocuments; index += 1) {
    addJson(`Graph/Graph_${counter(index)}.vbgraph`, createGraphDocument(seed, index));
  }
  for (let index = 0; index < profile.entityDocuments; index += 1) {
    addJson(`Entity/Entity_${counter(index)}.vbentity`, createEntityDocument(seed, index));
  }
  for (let index = 0; index < profile.structuredDocuments; index += 1) {
    addJson(`Structured/Settings_${counter(index)}.vbsettings`, createStructuredDocument(seed, index));
  }
  for (let partition = 0; partition < profile.tablePartitions; partition += 1) {
    addText(
      `Table/Records_${counter(partition, 4)}.tsv`,
      createTablePartition(seed, partition, profile.tableRowsPerPartition),
    );
  }

  for (const [path, content] of [...files].sort(([left], [right]) => compareOrdinal(left, right))) {
    const targetPath = join(rootPath, ...path.split("/"));
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, content, "utf8");
  }

  const counts = Object.freeze({
    catalogFiles: Object.keys(catalogs).length,
    graphDocuments: profile.graphDocuments,
    entityDocuments: profile.entityDocuments,
    structuredDocuments: profile.structuredDocuments,
    tablePartitions: profile.tablePartitions,
    tableRows: profile.tablePartitions * profile.tableRowsPerPartition,
    totalDocuments: profile.graphDocuments
      + profile.entityDocuments
      + profile.structuredDocuments
      + profile.tablePartitions,
  });
  const manifest = createManifest(profileName, profile, seed, counts, files);
  await writeFile(join(rootPath, CORPUS_MANIFEST_FILE), stableJson(manifest), "utf8");
  return manifest;
}

export async function refreshCorpusManifest(rootPath, manifest) {
  const files = new Map();
  for (const entry of manifest.files) {
    files.set(entry.path, await readFile(join(rootPath, ...entry.path.split("/")), "utf8"));
  }
  const refreshed = createManifest(
    manifest.profileName,
    manifest.profile,
    manifest.seed,
    manifest.counts,
    files,
  );
  await writeFile(join(rootPath, CORPUS_MANIFEST_FILE), stableJson(refreshed), "utf8");
  return refreshed;
}

/**
 * 装载生成语料并构建四域 Catalog Registry（C2 / G2a2）。
 *
 * 领域能力**只经分发产物**取得：`<root>/Modules/*.vbmodule.js` 由 `installCorpusModules` 放入，
 * 再经 `ModuleLoader` 求值拿 facet。生成器本身仍只产数据，装载前先补 bundle。
 */
export async function loadCorpusValidation(rootPath, manifest) {
  await verifyCorpusManifest(rootPath, manifest);
  await installCorpusModules(rootPath);
  const modules = await loadCorpusModules(rootPath);
  const core = require("../../../Core/dist/index.js");
  const documentTypes = new Map(
    modules.project.documentTypes.map((documentType) => [documentType.editor, documentType]),
  );
  const registries = new Map();
  for (const [editor, entry] of modules.editors) {
    const documentType = documentTypes.get(editor);
    if (documentType === undefined) continue;
    const built = await buildModuleCatalogRegistry(modules, documentType);
    registries.set(editor, built.registry);
    // 绑定校验走模块自己的 facet：Catalog 与 Document Type 对不上时必须在这里失败，
    // 否则各域 `validate()` 会静默返回空诊断（facet 拿不到 registry 时的契约），语料门禁变假绿。
    const issue = entry.registration.catalog.bindingIssue?.(built.registry, documentType.id);
    if (issue !== undefined) {
      throw new Error(`Catalog binding for '${documentType.id}' is invalid: ${issue.code}: ${issue.message}`);
    }
  }
  for (const editor of ["graph", "entity", "structured", "table"]) {
    if (!registries.has(editor)) {
      throw new Error(`Generated corpus did not load a module for the '${editor}' editor.`);
    }
  }
  return Object.freeze({
    rootPath,
    manifest,
    project: modules.project,
    loader: modules.loader,
    core,
    editors: modules.editors,
    registries,
    documentTypes,
  });
}

export async function verifyCorpusManifest(rootPath, manifest) {
  for (const entry of manifest.files) {
    const content = await readFile(join(rootPath, ...entry.path.split("/")));
    if (content.byteLength !== entry.bytes) {
      throw new Error(
        `Corpus file '${entry.path}' has ${content.byteLength} bytes; manifest declares ${entry.bytes}.`,
      );
    }
    const actualHash = sha256(content);
    if (actualHash !== entry.sha256) {
      throw new Error(
        `Corpus file '${entry.path}' has SHA-256 '${actualHash}'; manifest declares '${entry.sha256}'.`,
      );
    }
  }
}

/**
 * 把仓库里已构建的四个 bundle 放进生成语料的 `Modules/`。
 *
 * 语料生成器只产出数据（不依赖构建产物），而 Project File 已声明
 * `Modules/<editor>.vbmodule.js`；`npm run prepare:modules` / `build:bundles` 负责生成它们。
 * `loadCorpusValidation` 在装载前自己补一次，因此语料根永远自洽。
 */
export async function installCorpusModules(rootPath) {
  const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const from = join(repositoryRoot, "Modules");
  const to = join(rootPath, "Modules");
  await mkdir(to, { recursive: true });
  for (const editor of ["graph", "entity", "structured", "table"]) {
    try {
      await copyFile(join(from, `${editor}.vbmodule.js`), join(to, `${editor}.vbmodule.js`));
    } catch (errorValue) {
      throw new Error(
        `无法分发模块 '${editor}'：${from} 下没有 ${editor}.vbmodule.js（先跑 npm run prepare:modules）。\n`
        + String(errorValue),
      );
    }
  }
}

/** 经 `ModuleLoader` 装载生成语料的模块（C2）；`loadCorpusValidation` 的装载核心。 */
export async function loadCorpusModules(rootPath) {
  const core = require("../../../Core/dist/index.js");
  const nodeHost = require("../../../Tools/NodeHost/dist/index.js");
  const projectResult = core.parseProjectFile(
    await readFile(join(rootPath, "VisualBridge.project.vbjson"), "utf8"),
  );
  if (!projectResult.success) {
    throw new Error(`VisualBridge Project failed to parse:\n${projectResult.issues
      .map((issue) => `${issue.path}: ${issue.message}`)
      .join("\n")}`);
  }
  const project = projectResult.value;
  const loader = await nodeHost.ModuleLoader.create({
    projectRoot: rootPath,
    projectId: project.projectId,
    modules: project.modules,
    trusted: true,
  });
  const editors = new Map();
  for (const module of loader.result.modules) {
    const options = project.modules.find((candidate) => candidate.id === module.id)?.options;
    for (const registration of module.registration?.editors ?? []) {
      editors.set(registration.editor, { moduleId: module.id, registration, options });
    }
  }
  return Object.freeze({ rootPath, project, loader, editors });
}

/** 用模块的 `catalog` facet 构建某个 Document Type 的 Catalog Registry。 */
export async function buildModuleCatalogRegistry(modules, documentType) {
  const entry = modules.editors.get(documentType.editor);
  if (entry === undefined) {
    throw new Error(`No loaded module provides editor '${documentType.editor}'.`);
  }
  const catalogs = [];
  for (const catalogPath of documentType.catalogs) {
    const text = await readFile(join(modules.rootPath, ...catalogPath.split("/")), "utf8");
    const parsed = entry.registration.catalog.parse(text, catalogPath);
    if (!parsed.success) {
      throw new Error(`Catalog '${catalogPath}' failed to parse:\n${formatDiagnostics(parsed.diagnostics ?? [])}`);
    }
    catalogs.push(parsed.document);
  }
  const built = entry.registration.catalog.build(catalogs);
  if (!built.success) {
    throw new Error(`Catalog Registry for '${documentType.id}' failed to build:\n${formatDiagnostics(built.diagnostics ?? [])}`);
  }
  return Object.freeze({ entry, registry: built.document });
}

export function createCorpusSemanticSources(validation, loadCounts = new Map()) {
  const documentEntries = validation.manifest.files.filter((entry) => classifyDocument(entry.path) !== undefined);
  return documentEntries.map((entry) => ({
    key: entry.path,
    dependencyKey: entry.sha256,
    async load(signal) {
      throwIfAborted(signal);
      loadCounts.set(entry.path, (loadCounts.get(entry.path) ?? 0) + 1);
      const kind = classifyDocument(entry.path);
      const editor = validation.editors.get(kind);
      const documentType = validation.documentTypes.get(kind);
      if (editor === undefined || documentType === undefined) {
        throw new Error(`Generated corpus has no loaded module for the '${kind}' editor.`);
      }
      const bytes = await readFile(join(validation.rootPath, ...entry.path.split("/")));
      throwIfAborted(signal);
      // 文档类型、Catalog Registry 与模块 options 全部由装载结果给出：语料路径不另存一份语义入口。
      const context = {
        projectId: validation.project.projectId,
        documentTypeId: documentType.id,
        path: entry.path,
        sourcePaths: [entry.path],
        registry: validation.registries.get(kind),
        projectDefinition: validation.project,
        moduleOptions: editor.options,
      };
      const parsed = kind === "table"
        ? await editor.registration.semantic.parseSources([{ path: entry.path, bytes }], context)
        : await editor.registration.semantic.parseText(bytes.toString("utf8"), context);
      const document = parseOrThrow(entry.path, parsed);
      assertNoErrors(entry.path, await editor.registration.semantic.validate(document, context));
      if (kind === "table") {
        const physicalName = basename(entry.path, ".tsv");
        const sheet = document.sheets[0];
        return freezeSummary(entry, kind, sheet?.id ?? physicalName, sheet?.rows.length ?? 0);
      }
      return freezeSummary(entry, kind, document.documentId);
    },
  }));
}

export async function validateCorpus(rootPath, manifest, options = {}) {
  const validation = await loadCorpusValidation(rootPath, manifest);
  const store = options.store ?? new validation.core.IncrementalSemanticSnapshotStore();
  const loadCounts = options.loadCounts ?? new Map();
  const result = await store.rebuild(createCorpusSemanticSources(validation, loadCounts), {
    signal: options.signal,
    onProgress: options.onProgress,
  });
  if (result.status !== "applied") {
    throw new Error(`Generated corpus validation ended with status '${result.status}'.`);
  }
  return Object.freeze({ validation, store, loadCounts, result });
}

export async function mutateOneStructuredDocument(rootPath, manifest) {
  const entry = manifest.files.find((candidate) => candidate.path.startsWith("Structured/"));
  if (entry === undefined) {
    throw new Error("Corpus does not contain a Structured document to mutate.");
  }
  const targetPath = join(rootPath, ...entry.path.split("/"));
  const value = JSON.parse(await readFile(targetPath, "utf8"));
  value.properties.value = Number(value.properties.value) + 1;
  await writeFile(targetPath, stableJson(value), "utf8");
  return { path: entry.path, manifest: await refreshCorpusManifest(rootPath, manifest) };
}

export function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function createCatalogFiles() {
  return {
    "Catalog/GraphNodes.vbgraphcatalog": {
      formatVersion: 4,
      catalogId: "corpus.graph.nodes",
      title: "Corpus Graph Nodes",
      source: { status: "unknown" },
      dataTypes: [],
      graphTypes: [],
      nodeTypes: [{
        id: "corpus.node",
        aliases: [],
        title: "Corpus Node",
        category: "Corpus",
        menuPath: ["Corpus"],
        tags: ["corpus"],
        traits: [],
        ports: [],
        dynamicPortGroups: [],
        properties: [],
      }],
    },
    "Catalog/GraphTypes.vbgraphcatalog": {
      formatVersion: 4,
      catalogId: "corpus.graph.types",
      title: "Corpus Graph Types",
      source: { status: "unknown" },
      dataTypes: [],
      graphTypes: [{
        id: "corpus.root",
        aliases: [],
        title: "Corpus Root",
        usage: "root",
        supportedCatalogIds: ["corpus.graph.nodes", "corpus.graph.types"],
        portConnectionRules: { input: "single", output: "multiple" },
        allowedNodeSelectors: [{ tags: ["corpus"] }],
        properties: [],
        nodeConstraints: [],
        initialNodes: [],
        allowSubgraphs: false,
      }],
      nodeTypes: [],
    },
    "Catalog/EntityTypes.vbentitycatalog": {
      formatVersion: 1,
      catalogId: "corpus.entity.types",
      title: "Corpus Entity Types",
      source: { status: "unknown" },
      componentGroups: [{ id: "corpus.group", title: "Corpus", aliases: [] }],
      entityTypes: [{
        id: "corpus.entity",
        title: "Corpus Entity",
        aliases: [],
        allowedComponentGroupIds: ["corpus.group"],
        properties: [textField("name", "Name"), numberField("value", "Value")],
      }],
      componentTypes: [],
    },
    "Catalog/EntityComponents.vbentitycatalog": {
      formatVersion: 1,
      catalogId: "corpus.entity.components",
      title: "Corpus Entity Components",
      source: { status: "unknown" },
      componentGroups: [],
      entityTypes: [],
      componentTypes: [{
        id: "corpus.component",
        title: "Corpus Component",
        aliases: [],
        groupId: "corpus.group",
        menuPath: [],
        properties: [numberField("weight", "Weight")],
      }],
    },
    "Catalog/StructuredPrimary.vbstructuredcatalog": {
      formatVersion: 1,
      catalogId: "corpus.structured.primary",
      title: "Corpus Structured Primary",
      source: { status: "unknown" },
      configTypes: [{
        id: "corpus.settings",
        title: "Corpus Settings",
        aliases: [],
        properties: [textField("name", "Name"), numberField("value", "Value")],
      }],
    },
    "Catalog/StructuredAuxiliary.vbstructuredcatalog": {
      formatVersion: 1,
      catalogId: "corpus.structured.auxiliary",
      title: "Corpus Structured Auxiliary",
      source: { status: "unknown" },
      configTypes: [{
        id: "corpus.settings.auxiliary",
        title: "Corpus Auxiliary Settings",
        aliases: [],
        properties: [numberField("enabledIndex", "Enabled Index")],
      }],
    },
    "Catalog/TablePrimary.vbtablecatalog": tableCatalog(
      "corpus.table.primary",
      "Corpus Table Primary",
      "corpus.records",
      "Records",
    ),
    "Catalog/TableAuxiliary.vbtablecatalog": tableCatalog(
      "corpus.table.auxiliary",
      "Corpus Table Auxiliary",
      "corpus.records.auxiliary",
      "Auxiliary",
    ),
  };
}

function createProjectFile() {
  return {
    formatVersion: 2,
    projectId: "visualbridge.large-corpus",
    documentRoots: ["Graph", "Entity", "Structured", "Table"],
    modules: [
      { id: "visualbridge.graph", entry: "Modules/graph.vbmodule.js" },
      { id: "visualbridge.entity", entry: "Modules/entity.vbmodule.js" },
      { id: "visualbridge.structured", entry: "Modules/structured.vbmodule.js" },
      {
        id: "visualbridge.table",
        entry: "Modules/table.vbmodule.js",
        options: { tableLayout: { nameKeyRow: 2, dataStartRow: 3 } },
      },
    ],
    documentTypes: [
      {
        id: "corpus.graph",
        editor: "graph",
        include: ["Graph/*.vbgraph"],
        exclude: [],
        catalogs: ["Catalog/GraphNodes.vbgraphcatalog", "Catalog/GraphTypes.vbgraphcatalog"],
      },
      {
        id: "corpus.entity",
        editor: "entity",
        include: ["Entity/*.vbentity"],
        exclude: [],
        catalogs: ["Catalog/EntityTypes.vbentitycatalog", "Catalog/EntityComponents.vbentitycatalog"],
      },
      {
        id: "corpus.settings",
        editor: "structured",
        include: ["Structured/*.vbsettings"],
        exclude: [],
        catalogs: ["Catalog/StructuredPrimary.vbstructuredcatalog", "Catalog/StructuredAuxiliary.vbstructuredcatalog"],
      },
      {
        id: "corpus.records",
        editor: "table",
        include: ["Table/*.tsv"],
        exclude: [],
        catalogs: ["Catalog/TablePrimary.vbtablecatalog", "Catalog/TableAuxiliary.vbtablecatalog"],
      },
    ],
  };
}

function createGraphDocument(seed, index) {
  const id = corpusId("graph", seed, index);
  return {
    formatVersion: 3,
    documentId: id,
    rootGraphId: "root",
    graphs: [{
      id: "root",
      graphTypeId: "corpus.root",
      title: `Graph ${index}`,
      properties: {},
      interfacePorts: [],
      nodes: [{
        kind: "node",
        id: "node.0",
        nodeTypeId: "corpus.node",
        title: `Node ${seededInteger(seed, index, 100_000)}`,
        position: { x: seededInteger(seed, index * 2, 1_000), y: seededInteger(seed, index * 2 + 1, 1_000) },
        properties: {},
        dynamicPorts: [],
      }],
      edges: [],
    }],
  };
}

function createEntityDocument(seed, index) {
  return {
    formatVersion: 1,
    documentId: corpusId("entity", seed, index),
    entityTypeId: "corpus.entity",
    title: `Entity ${index}`,
    properties: {
      name: `Entity ${seededInteger(seed, index, 1_000_000)}`,
      value: seededInteger(seed, index + 101, 10_000),
    },
    components: [{
      id: "component.0",
      componentTypeId: "corpus.component",
      enabled: (seededInteger(seed, index + 202, 2) === 1),
      properties: { weight: seededInteger(seed, index + 303, 1_000) },
    }],
  };
}

function createStructuredDocument(seed, index) {
  return {
    formatVersion: 1,
    documentId: corpusId("settings", seed, index),
    properties: {
      name: `Settings ${seededInteger(seed, index, 1_000_000)}`,
      value: seededInteger(seed, index + 404, 10_000),
    },
  };
}

function createTablePartition(seed, partition, rowsPerPartition) {
  const rows = ["Identifier\tDisplay name\tValue\tTags", "Id\tName\tValue\tTags"];
  for (let index = 0; index < rowsPerPartition; index += 1) {
    const globalIndex = partition * rowsPerPartition + index;
    const id = seed * 100_000_000 + globalIndex + 1;
    const value = seededInteger(seed, globalIndex + 505, 100_000);
    rows.push(`${id}\tRecord ${globalIndex}\t${value}\tgroup${globalIndex % 17};seed${seed}`);
  }
  return `${rows.join("\n")}\n`;
}

function tableCatalog(catalogId, title, tableTypeId, sheetName) {
  return {
    formatVersion: 1,
    catalogId,
    title,
    source: { status: "unknown" },
    tableTypes: [{
      id: tableTypeId,
      title: `${title} Records`,
      aliases: [],
      csv: { delimiter: "\t" },
      sheets: [{
        id: tableTypeId === "corpus.records" ? "records" : "auxiliary",
        aliases: [],
        title: `${title} Records`,
        name: sheetName,
        nameAliases: [],
        rowDisplayNamePattern: "{id}_{name}",
        keyColumnId: "id",
        partition: {
          namePattern: `${sheetName}_{part}`,
          deduplicateByColumnId: "id",
          duplicatePolicy: "error",
        },
        columns: [
          tableColumn("id", "ID", "Id", "number", "int", 0, { kind: "number", integer: true }, { kind: "scalar" }),
          tableColumn("name", "Name", "Name", "string", "string", "", { kind: "text" }, { kind: "scalar" }),
          tableColumn("value", "Value", "Value", "number", "int", 0, { kind: "number", integer: true }, { kind: "scalar" }),
          {
            ...tableColumn("tags", "Tags", "Tags", "array", "list.string", [], undefined, {
              kind: "delimited",
              separator: ";",
            }),
            item: textFieldValue(),
          },
        ],
      }],
    }],
  };
}

function tableColumn(id, title, nameKey, valueType, dataTypeId, defaultValue, editor, cellEncoding) {
  return {
    id,
    title,
    aliases: [],
    nameKey,
    nameKeyAliases: [],
    valueType,
    dataTypeId,
    defaultValue,
    ...(editor === undefined ? {} : { editor }),
    cellEncoding,
  };
}

function textField(id, title) {
  return { id, title, aliases: [], ...textFieldValue() };
}

function textFieldValue() {
  return {
    valueType: "string",
    dataTypeId: "string",
    defaultValue: "",
    editor: { kind: "text" },
  };
}

function numberField(id, title) {
  return {
    id,
    title,
    aliases: [],
    valueType: "number",
    dataTypeId: "int",
    defaultValue: 0,
    editor: { kind: "number", integer: true },
  };
}

function createManifest(profileName, profile, seed, counts, files) {
  const entries = [...files]
    .sort(([left], [right]) => compareOrdinal(left, right))
    .map(([path, content]) => {
      const bytes = Buffer.byteLength(content, "utf8");
      return Object.freeze({ path, sha256: sha256(content), bytes });
    });
  return Object.freeze({
    formatVersion: 1,
    seed,
    profileName,
    profile: Object.freeze({ ...profile }),
    counts,
    totalFiles: entries.length,
    totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    files: Object.freeze(entries),
  });
}

async function ensureEmptyDirectory(rootPath) {
  await mkdir(rootPath, { recursive: true });
  const entries = await readdir(rootPath);
  if (entries.length > 0) {
    throw new Error(`Corpus output directory '${rootPath}' must be empty.`);
  }
}

function parseOrThrow(label, result) {
  if (!result.success) {
    throw new Error(`${label} failed to parse:\n${formatDiagnostics(result.diagnostics)}`);
  }
  assertNoErrors(label, result.diagnostics ?? []);
  return result.document;
}

function assertNoErrors(label, diagnostics) {
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length > 0) {
    throw new Error(`${label} failed validation:\n${formatDiagnostics(errors)}`);
  }
}

function formatDiagnostics(diagnostics) {
  return diagnostics.map((diagnostic) => (
    `${diagnostic.severity} ${diagnostic.code} ${diagnostic.path}: ${diagnostic.message}`
  )).join("\n");
}

function freezeSummary(entry, kind, documentId, rowCount = 0) {
  return Object.freeze({
    path: entry.path,
    dependencyKey: entry.sha256,
    kind,
    documentId,
    rowCount,
  });
}

function classifyDocument(path) {
  if (path.startsWith("Graph/") && path.endsWith(".vbgraph")) return "graph";
  if (path.startsWith("Entity/") && path.endsWith(".vbentity")) return "entity";
  if (path.startsWith("Structured/") && path.endsWith(".vbsettings")) return "structured";
  if (path.startsWith("Table/") && path.endsWith(".tsv")) return "table";
  return undefined;
}

function normalizeSeed(value) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 9_000_000) {
    throw new Error("Corpus seed must be a positive safe integer no greater than 9000000.");
  }
  return value;
}

function seededInteger(seed, index, modulus) {
  let value = (seed ^ Math.imul(index + 1, 0x45d9f3b)) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b) >>> 0;
  return (value ^ (value >>> 16)) % modulus;
}

function corpusId(kind, seed, index) {
  return `corpus.${kind}.s${seed}.${counter(index)}`;
}

function counter(value, width = 6) {
  return String(value).padStart(width, "0");
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function throwIfAborted(signal) {
  if (signal.aborted) {
    throw new DOMException("Corpus semantic loading was cancelled.", "AbortError");
  }
}

function compareOrdinal(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
