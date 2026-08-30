import { join, resolve } from "node:path";
import { generateCorpus } from "./corpus.mjs";

const options = parseArguments(process.argv.slice(2));
const manifest = await generateCorpus(resolve(options.output), {
  profile: options.profile,
  seed: options.seed,
  overrides: options.overrides,
});
const outputPath = resolve(options.output);
process.stdout.write(`${JSON.stringify({
  output: outputPath,
  manifest: join(outputPath, "corpus.manifest.json"),
  profileName: manifest.profileName,
  seed: manifest.seed,
  counts: manifest.counts,
  totalFiles: manifest.totalFiles,
  totalBytes: manifest.totalBytes,
}, null, 2)}\n`);

function parseArguments(args) {
  const result = { profile: "benchmark", seed: 1, output: undefined, overrides: {} };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (value === undefined || !flag?.startsWith("--")) {
      throw new Error(`Expected a value after '${flag ?? "<missing>"}'.`);
    }
    index += 1;
    if (flag === "--profile") result.profile = value;
    else if (flag === "--seed") result.seed = readInteger(flag, value);
    else if (flag === "--output") result.output = value;
    else if (flag === "--graph-documents") result.overrides.graphDocuments = readInteger(flag, value);
    else if (flag === "--entity-documents") result.overrides.entityDocuments = readInteger(flag, value);
    else if (flag === "--structured-documents") result.overrides.structuredDocuments = readInteger(flag, value);
    else if (flag === "--table-partitions") result.overrides.tablePartitions = readInteger(flag, value);
    else if (flag === "--table-rows-per-partition") result.overrides.tableRowsPerPartition = readInteger(flag, value);
    else throw new Error(`Unknown argument '${flag}'.`);
  }
  if (result.output === undefined) {
    throw new Error("--output is required and must name an empty directory.");
  }
  return result;
}

function readInteger(flag, value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive safe integer.`);
  }
  return parsed;
}
