import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildModuleCatalogRegistry,
  createCorpusSemanticSources,
  generateCorpus,
  installCorpusModules,
  loadCorpusModules,
  loadCorpusValidation,
  mutateOneStructuredDocument,
  validateCorpus,
  verifyCorpusManifest,
} from "../src/corpus.mjs";

test("corpus documents load through ModuleLoader with identical semantics", async (context) => {
  // C2 / G2a2：大语料工具也经 Loader 取模块，证明分发产物在真实生成工程上可用。
  // 不再提供跳过开关：语料语义现在**只**从 bundle 来，跳过就等于不验证。
  const rootPath = await mkdtemp(join(tmpdir(), "visualbridge-corpus-modules-"));
  context.after(() => rm(rootPath, { recursive: true, force: true }));
  const manifest = await generateCorpus(rootPath, { profile: "correctness", seed: 8675309 });
  await installCorpusModules(rootPath);
  const modules = await loadCorpusModules(rootPath);
  context.after(() => modules.loader.dispose());

  assert.deepEqual([...modules.editors.keys()].sort(), ["entity", "graph", "structured", "table"]);
  assert.deepEqual(
    modules.loader.result.modules.map((module) => [module.id, module.status]),
    [
      ["visualbridge.graph", "loaded"],
      ["visualbridge.entity", "loaded"],
      ["visualbridge.structured", "loaded"],
      ["visualbridge.table", "loaded"],
    ],
  );

  // 每个 editor 取一份生成文档，用 facet 解析 + 校验；诊断必须为空。
  const documentTypes = new Map(modules.project.documentTypes.map((type) => [type.editor, type]));
  const documentEntries = manifest.files.filter((entry) => /^(Graph|Entity|Structured|Table)\//u.test(entry.path));
  const byEditor = new Map();
  for (const entry of documentEntries) {
    const editor = entry.path.startsWith("Graph/")
      ? "graph"
      : entry.path.startsWith("Entity/")
        ? "entity"
        : entry.path.startsWith("Structured/")
          ? "structured"
          : "table";
    if (!byEditor.has(editor)) byEditor.set(editor, entry);
  }
  for (const editor of ["graph", "entity", "structured", "table"]) {
    const entry = byEditor.get(editor);
    assert.notEqual(entry, undefined, `Corpus must contain a ${editor} document.`);
    const documentType = documentTypes.get(editor);
    assert.notEqual(documentType, undefined, `Corpus Project must declare a ${editor} Document Type.`);
    const built = await buildModuleCatalogRegistry(modules, documentType);
    const context = {
      projectId: modules.project.projectId,
      documentTypeId: documentType.id,
      path: entry.path,
      sourcePaths: [entry.path],
      registry: built.registry,
      projectDefinition: modules.project,
      moduleOptions: built.entry.options,
    };
    const bytes = await readFile(join(rootPath, ...entry.path.split("/")));
    const parsed = editor === "table"
      ? await built.entry.registration.semantic.parseSources(
        [{ path: entry.path, bytes }],
        context,
      )
      : await built.entry.registration.semantic.parseText(bytes.toString("utf8"), context);
    assert.equal(
      parsed.success,
      true,
      `${entry.path}: ${(parsed.diagnostics ?? []).map((diagnostic) => diagnostic.code).join(",")}`,
    );
    const diagnostics = await built.entry.registration.semantic.validate(parsed.document, context);
    assert.deepEqual(
      diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
      [],
      `${entry.path} must validate through the module facet.`,
    );
  }
});

test("same integer seed produces a byte-identical corpus manifest", async (context) => {
  const firstRoot = await mkdtemp(join(tmpdir(), "visualbridge-corpus-a-"));
  const secondRoot = await mkdtemp(join(tmpdir(), "visualbridge-corpus-b-"));
  context.after(async () => Promise.all([
    rm(firstRoot, { recursive: true, force: true }),
    rm(secondRoot, { recursive: true, force: true }),
  ]));
  const first = await generateCorpus(firstRoot, { profile: "correctness", seed: 314159 });
  const second = await generateCorpus(secondRoot, { profile: "correctness", seed: 314159 });
  assert.deepEqual(first, second);
  assert.equal(
    await readFile(join(firstRoot, "corpus.manifest.json"), "utf8"),
    await readFile(join(secondRoot, "corpus.manifest.json"), "utf8"),
  );
  assert.equal(first.counts.catalogFiles, 8);
  assert.equal(first.counts.totalDocuments, 38);
  assert.equal(first.counts.tableRows, 100);
  assert.equal(first.files.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256)), true);
  await verifyCorpusManifest(firstRoot, first);
  await verifyCorpusManifest(secondRoot, second);
});

test("correctness corpus passes official Project, Catalog, and document semantics", async (context) => {
  const rootPath = await mkdtemp(join(tmpdir(), "visualbridge-corpus-semantics-"));
  context.after(() => rm(rootPath, { recursive: true, force: true }));
  const manifest = await generateCorpus(rootPath, { profile: "correctness", seed: 271828 });
  const validated = await validateCorpus(rootPath, manifest);
  assert.equal(validated.result.snapshot.loaded, manifest.counts.totalDocuments);
  assert.equal(validated.result.snapshot.reused, 0);
  assert.equal(
    validated.result.snapshot.values.reduce((sum, value) => sum + value.rowCount, 0),
    manifest.counts.tableRows,
  );
});

test("one source change performs one semantic load and matches a full rebuild", async (context) => {
  const rootPath = await mkdtemp(join(tmpdir(), "visualbridge-corpus-incremental-"));
  context.after(() => rm(rootPath, { recursive: true, force: true }));
  let manifest = await generateCorpus(rootPath, { profile: "correctness", seed: 161803 });
  const incremental = await validateCorpus(rootPath, manifest);
  const baselineCounts = new Map(incremental.loadCounts);
  const mutation = await mutateOneStructuredDocument(rootPath, manifest);
  manifest = mutation.manifest;
  const validation = await loadCorpusValidation(rootPath, manifest);
  const sources = createCorpusSemanticSources(validation, incremental.loadCounts);
  const result = await incremental.store.rebuild(sources);
  assert.equal(result.status, "applied");
  assert.equal(result.snapshot.loaded, 1);
  assert.equal(result.snapshot.reused, manifest.counts.totalDocuments - 1);
  const changedLoads = [...incremental.loadCounts]
    .filter(([path, count]) => count !== baselineCounts.get(path))
    .map(([path, count]) => [path, count - (baselineCounts.get(path) ?? 0)]);
  assert.deepEqual(changedLoads, [[mutation.path, 1]]);

  const fullStore = new validation.core.IncrementalSemanticSnapshotStore();
  const full = await fullStore.rebuild(createCorpusSemanticSources(validation));
  assert.equal(full.status, "applied");
  assert.deepEqual(result.snapshot.values, full.snapshot.values);
});
