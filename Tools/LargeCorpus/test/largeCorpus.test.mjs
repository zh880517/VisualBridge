import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createCorpusSemanticSources,
  generateCorpus,
  loadCorpusValidation,
  mutateOneStructuredDocument,
  validateCorpus,
  verifyCorpusManifest,
} from "../src/corpus.mjs";

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
