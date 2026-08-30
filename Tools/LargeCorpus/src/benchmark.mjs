import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { cpus, platform, release, totalmem, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  createCorpusSemanticSources,
  generateCorpus,
  loadCorpusValidation,
  mutateOneStructuredDocument,
  validateCorpus,
} from "./corpus.mjs";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const options = parseArguments(process.argv.slice(2));
const temporaryRoot = await mkdtemp(join(tmpdir(), "visualbridge-large-corpus-"));
const stages = [];
let manifest;
let validationRun;
let incremental;
try {
  manifest = await measure(stages, "generate", () => generateCorpus(temporaryRoot, {
    profile: options.profile,
    seed: options.seed,
  }));
  validationRun = await measure(stages, "parse-and-validate", () => validateCorpus(temporaryRoot, manifest));
  const mutation = await measure(stages, "mutate-one-source", () => mutateOneStructuredDocument(temporaryRoot, manifest));
  manifest = mutation.manifest;
  const validation = await loadCorpusValidation(temporaryRoot, manifest);
  const sources = createCorpusSemanticSources(validation, validationRun.loadCounts);
  const incrementalResult = await measure(stages, "incremental-rebuild", () => validationRun.store.rebuild(sources));
  assert.equal(incrementalResult.status, "applied");
  assert.equal(incrementalResult.snapshot.loaded, 1);
  const fullStore = new validation.core.IncrementalSemanticSnapshotStore();
  const fullResult = await measure(stages, "full-rebuild", () => fullStore.rebuild(sources));
  assert.equal(fullResult.status, "applied");
  assert.deepEqual(incrementalResult.snapshot.values, fullResult.snapshot.values);
  incremental = {
    changedPath: mutation.path,
    loaded: incrementalResult.snapshot.loaded,
    reused: incrementalResult.snapshot.reused,
    fullEquivalent: true,
  };

  const report = {
    formatVersion: 1,
    environment: environmentReport(),
    corpus: {
      profileName: manifest.profileName,
      profile: manifest.profile,
      seed: manifest.seed,
      counts: manifest.counts,
      totalFiles: manifest.totalFiles,
      totalBytes: manifest.totalBytes,
    },
    stages,
    incremental,
    policy: {
      fixedThresholds: false,
      interpretation: "Compare reports produced on equivalent hardware and runtime configurations.",
    },
  };
  const outputPath = resolve(options.output);
  await mkdir(outputPath, { recursive: true });
  await writeFile(join(outputPath, "large-corpus-benchmark.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(join(outputPath, "large-corpus-benchmark.md"), renderMarkdown(report), "utf8");
  process.stdout.write(`${JSON.stringify({ output: outputPath, corpus: report.corpus, incremental }, null, 2)}\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function measure(stages, name, action) {
  const memoryBefore = memoryReport();
  const started = performance.now();
  const value = await action();
  const elapsedMs = performance.now() - started;
  stages.push({ name, elapsedMs: round(elapsedMs), memoryBefore, memoryAfter: memoryReport() });
  return value;
}

function environmentReport() {
  const cpuList = cpus();
  return {
    node: process.version,
    platform: platform(),
    osRelease: release(),
    architecture: process.arch,
    cpuModel: cpuList[0]?.model ?? "unknown",
    logicalCpuCount: cpuList.length,
    totalMemoryBytes: totalmem(),
  };
}

function memoryReport() {
  const memory = process.memoryUsage();
  return {
    rssBytes: memory.rss,
    heapTotalBytes: memory.heapTotal,
    heapUsedBytes: memory.heapUsed,
    externalBytes: memory.external,
    arrayBuffersBytes: memory.arrayBuffers,
  };
}

function renderMarkdown(report) {
  const stageRows = report.stages.map((stage) => (
    `| ${stage.name} | ${stage.elapsedMs.toFixed(3)} | ${stage.memoryBefore.rssBytes} | ${stage.memoryAfter.rssBytes} |`
  )).join("\n");
  return `# VisualBridge Large Corpus Benchmark\n\n`
    + `This report records observations only. It deliberately defines no cross-machine pass/fail threshold.\n\n`
    + `## Environment\n\n`
    + `- Node: ${report.environment.node}\n`
    + `- OS: ${report.environment.platform} ${report.environment.osRelease} (${report.environment.architecture})\n`
    + `- CPU: ${report.environment.cpuModel} (${report.environment.logicalCpuCount} logical CPUs)\n`
    + `- RAM: ${report.environment.totalMemoryBytes} bytes\n\n`
    + `## Corpus\n\n`
    + `- Profile: ${report.corpus.profileName}\n`
    + `- Seed: ${report.corpus.seed}\n`
    + `- Semantic documents: ${report.corpus.counts.totalDocuments}\n`
    + `- Table rows: ${report.corpus.counts.tableRows}\n`
    + `- Files: ${report.corpus.totalFiles}\n`
    + `- Bytes: ${report.corpus.totalBytes}\n\n`
    + `## Stages\n\n`
    + `| Stage | Elapsed ms | RSS before | RSS after |\n`
    + `| --- | ---: | ---: | ---: |\n${stageRows}\n\n`
    + `## Incremental rebuild\n\n`
    + `- Changed source: ${report.incremental.changedPath}\n`
    + `- Loaded: ${report.incremental.loaded}\n`
    + `- Reused: ${report.incremental.reused}\n`
    + `- Deep-equal to full rebuild: ${report.incremental.fullEquivalent}\n`;
}

function parseArguments(args) {
  const result = { profile: "benchmark", seed: 1, output: join(repositoryRoot, "output", "large-corpus") };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (value === undefined) throw new Error(`Expected a value after '${flag ?? "<missing>"}'.`);
    index += 1;
    if (flag === "--profile") result.profile = value;
    else if (flag === "--seed") result.seed = readInteger(flag, value);
    else if (flag === "--output") result.output = value;
    else throw new Error(`Unknown argument '${flag}'.`);
  }
  return result;
}

function readInteger(flag, value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive safe integer.`);
  return parsed;
}

function round(value) {
  return Math.round(value * 1_000) / 1_000;
}
