import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createRequire } from "node:module";

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

export async function loadCorpusValidation(rootPath, manifest) {
  await verifyCorpusManifest(rootPath, manifest);
  const core = require("../../../Core/dist/index.js");
  const graph = require("../../../BuiltInExtensions/Graph/dist/index.js");
  const entity = require("../../../BuiltInExtensions/Entity/dist/index.js");
  const structured = require("../../../BuiltInExtensions/StructuredConfig/dist/index.js");
  const table = require("../../../BuiltInExtensions/Table/dist/index.js");

  const projectResult = core.parseProjectFile(
    await readFile(join(rootPath, "VisualBridge.project.vbjson"), "utf8"),
  );
  if (!projectResult.success) {
    throw new Error(`VisualBridge Project failed to parse:\n${projectResult.issues
      .map((issue) => `${issue.path}: ${issue.message}`)
      .join("\n")}`);
  }
  const project = projectResult.value;
  const graphRegistry = buildOrThrow(
    "Graph Catalog Registry",
    graph.buildGraphCatalogRegistry(await parseCatalogSet(rootPath, [
      "Catalog/GraphNodes.vbgraphcatalog",
      "Catalog/GraphTypes.vbgraphcatalog",
    ], graph.parseGraphCatalog)),
  );
  const entityRegistry = buildOrThrow(
    "Entity Catalog Registry",
    entity.buildEntityCatalogRegistry(await parseCatalogSet(rootPath, [
      "Catalog/EntityTypes.vbentitycatalog",
      "Catalog/EntityComponents.vbentitycatalog",
    ], entity.parseEntityCatalog)),
  );
  const structuredRegistry = buildOrThrow(
    "Structured Catalog Registry",
    structured.buildStructuredCatalogRegistry(await parseCatalogSet(rootPath, [
      "Catalog/StructuredPrimary.vbstructuredcatalog",
      "Catalog/StructuredAuxiliary.vbstructuredcatalog",
    ], structured.parseStructuredCatalog)),
  );
  const tableRegistry = buildOrThrow(
    "Table Catalog Registry",
    table.buildTableCatalogRegistry(await parseCatalogSet(rootPath, [
      "Catalog/TablePrimary.vbtablecatalog",
      "Catalog/TableAuxiliary.vbtablecatalog",
    ], table.parseTableCatalog)),
  );
  const tableType = table.resolveTableType(tableRegistry, "corpus.records");
  if (tableType === undefined) {
    throw new Error("Generated Table Catalog Registry does not contain 'corpus.records'.");
  }
  return Object.freeze({
    rootPath,
    manifest,
    project,
    core,
    graph,
    entity,
    structured,
    table,
    graphRegistry,
    entityRegistry,
    structuredRegistry,
    tableRegistry,
    tableType,
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

export function createCorpusSemanticSources(validation, loadCounts = new Map()) {
  const documentEntries = validation.manifest.files.filter((entry) => classifyDocument(entry.path) !== undefined);
  return documentEntries.map((entry) => ({
    key: entry.path,
    dependencyKey: entry.sha256,
    async load(signal) {
      throwIfAborted(signal);
      loadCounts.set(entry.path, (loadCounts.get(entry.path) ?? 0) + 1);
      const text = await readFile(join(validation.rootPath, ...entry.path.split("/")), "utf8");
      throwIfAborted(signal);
      const kind = classifyDocument(entry.path);
      if (kind === "graph") {
        const document = parseOrThrow(entry.path, validation.graph.parseGraphDocument(text));
        assertNoErrors(entry.path, validation.graph.validateGraphDocument(document, validation.graphRegistry));
        return freezeSummary(entry, kind, document.documentId);
      }
      if (kind === "entity") {
        const document = parseOrThrow(entry.path, validation.entity.parseEntityDocument(text));
        assertNoErrors(entry.path, validation.entity.validateEntityDocument(document, validation.entityRegistry));
        return freezeSummary(entry, kind, document.documentId);
      }
      if (kind === "structured") {
        const document = parseOrThrow(entry.path, validation.structured.parseStructuredDocument(text));
        assertNoErrors(
          entry.path,
          validation.structured.validateStructuredDocument(
            document,
            validation.structuredRegistry,
            "corpus.settings",
          ),
        );
        return freezeSummary(entry, kind, document.documentId);
      }
      if (kind === "table") {
        const physicalName = basename(entry.path, ".tsv");
        const document = parseOrThrow(
          entry.path,
          validation.table.parseCsvTable(text, validation.tableType, validation.project.tableLayout, physicalName),
        );
        assertNoErrors(entry.path, validation.table.validateTableDocument(document, validation.tableType));
        return freezeSummary(entry, kind, document.sheets[0]?.id ?? physicalName, document.sheets[0]?.rows.length ?? 0);
      }
      throw new Error(`Unsupported generated document '${entry.path}'.`);
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
    formatVersion: 1,
    projectId: "visualbridge.large-corpus",
    documentRoots: ["Graph", "Entity", "Structured", "Table"],
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
    tableLayout: { nameKeyRow: 2, dataStartRow: 3 },
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

async function parseCatalogSet(rootPath, paths, parse) {
  const results = [];
  for (const path of paths) {
    const text = await readFile(join(rootPath, ...path.split("/")), "utf8");
    results.push(parseOrThrow(path, parse(text)));
  }
  return results;
}

function parseOrThrow(label, result) {
  if (!result.success) {
    throw new Error(`${label} failed to parse:\n${formatDiagnostics(result.diagnostics)}`);
  }
  assertNoErrors(label, result.diagnostics ?? []);
  return result.document;
}

function buildOrThrow(label, result) {
  return parseOrThrow(label, result);
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
