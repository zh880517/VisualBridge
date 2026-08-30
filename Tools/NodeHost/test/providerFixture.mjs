import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIRECTORY_PREFIX = "visualbridge-provider-test-";
const SAMPLE_PROVIDER_ID = "sample.provider";
const VALID_MODES = new Set([
  "healthy",
  "invalidJson",
  "invalidResult",
  "timeout",
  "crash",
  "crashThenHealthy",
  "crashOnContinuation",
  "largeContinuation",
  "stderr",
  "rewriteAuthoring",
  "rewriteAuthoringInvalidResult",
  "candidateWrongKind",
  "candidateWrongTarget",
  "candidateWrongValue",
  "candidateOutsideLocation",
  "diagnosticOutsideSnapshot",
]);
const helperDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(helperDirectory, "..", "..", "..");

export const providerFixtureSource = path.join(repositoryRoot, "TestData", "ProviderSemanticProject");
export const providerFixtureEntry = "Providers/sample-provider.mjs";
export const providerFixtureProjectFile = "VisualBridge.project.vbjson";
export const providerArgumentSentinel = "literal value ; & | < > $() \"quoted\"";
export const providerRuntimeTestOptions = Object.freeze({
  requestTimeoutMs: 200,
  restartBaseDelayMs: 50,
  restartMaxDelayMs: 200,
  restartStableWindowMs: 500,
});
export const providerExternalRewriteText = `${JSON.stringify({
  formatVersion: 1,
  documentId: "sample.provider.settings.default",
  properties: {
    assetId: "asset.sword",
    displayName: "Externally rewritten by Project Provider",
  },
}, undefined, 2)}\n`;

export async function createProviderFixture(options = {}) {
  const temporaryRoot = await mkdtemp(path.join(options.temporaryDirectory ?? tmpdir(), TEST_DIRECTORY_PREFIX));
  const projectRoot = path.join(temporaryRoot, "ProviderSemanticProject");
  const stateDirectory = path.join(temporaryRoot, "provider-state");
  await Promise.all([
    cp(providerFixtureSource, projectRoot, { recursive: true }),
    mkdir(stateDirectory, { recursive: true }),
  ]);
  const rewriteSource = options.rewriteSourceRelative === undefined
    ? options.rewriteSource
    : resolveFixtureRelativePath(projectRoot, options.rewriteSourceRelative, "rewriteSourceRelative");
  await configureProviderFixture(projectRoot, {
    ...options,
    stateDirectory,
    passPathsInArguments: options.passPathsInArguments ?? true,
    ...(rewriteSource === undefined ? {} : { rewriteSource }),
  });
  return {
    temporaryRoot,
    projectRoot,
    stateDirectory,
    projectFile: path.join(projectRoot, providerFixtureProjectFile),
    entryPath: path.join(projectRoot, ...providerFixtureEntry.split("/")),
    eventsPath: path.join(stateDirectory, "events.ndjson"),
    environment: providerFixtureEnvironment({
      stateDirectory,
      ...(rewriteSource === undefined ? {} : { rewriteSource }),
    }),
    async dispose() {
      await removeProviderFixture(temporaryRoot);
    },
  };
}

export async function configureProviderFixture(projectRoot, options) {
  const projectFile = path.join(projectRoot, providerFixtureProjectFile);
  const project = JSON.parse(await readFile(projectFile, "utf8"));
  const providers = Array.isArray(project.providers) ? project.providers : [];
  const provider = providers.find((candidate) => candidate?.id === SAMPLE_PROVIDER_ID);
  if (provider === undefined) {
    throw new Error(`Provider fixture does not declare '${SAMPLE_PROVIDER_ID}'.`);
  }
  provider.args = providerFixtureArguments(options);
  await writeFile(projectFile, `${JSON.stringify(project, undefined, 2)}\n`, "utf8");
}

export function providerFixtureArguments(options) {
  const mode = options?.mode ?? "healthy";
  if (!VALID_MODES.has(mode)) {
    throw new Error(`Unknown Provider fixture mode '${String(mode)}'.`);
  }
  const args = ["--mode", mode, "--echo-arg", options.echoArgument ?? providerArgumentSentinel];
  if (options.faultMethod !== undefined) {
    requireNonEmptyString(options.faultMethod, "faultMethod");
    args.push("--fault-method", options.faultMethod);
  }
  if (options.crashStarts !== undefined) {
    if (!Number.isInteger(options.crashStarts) || options.crashStarts < 1 || options.crashStarts > 10) {
      throw new Error("Provider fixture crashStarts must be an integer from 1 through 10.");
    }
    args.push("--crash-starts", String(options.crashStarts));
  }
  if (options.passPathsInArguments === true) {
    requireAbsolutePath(options.stateDirectory, "stateDirectory");
    args.push("--state-dir", options.stateDirectory);
  }
  if (options.passPathsInArguments === true && options.rewriteSource !== undefined) {
    requireAbsolutePath(options.rewriteSource, "rewriteSource");
    args.push(
      "--rewrite-source",
      options.rewriteSource,
      "--rewrite-content-base64",
      Buffer.from(providerExternalRewriteText, "utf8").toString("base64"),
    );
  }
  return args;
}

export function providerFixtureEnvironment(options) {
  requireAbsolutePath(options?.stateDirectory, "stateDirectory");
  const environment = {
    VISUALBRIDGE_PROVIDER_TEST_STATE_DIR: options.stateDirectory,
  };
  if (options.rewriteSource !== undefined) {
    requireAbsolutePath(options.rewriteSource, "rewriteSource");
    environment.VISUALBRIDGE_PROVIDER_TEST_REWRITE_SOURCE = options.rewriteSource;
    environment.VISUALBRIDGE_PROVIDER_TEST_REWRITE_CONTENT_BASE64 = Buffer
      .from(providerExternalRewriteText, "utf8")
      .toString("base64");
  }
  return environment;
}

export async function readProviderEvents(stateDirectory) {
  let text;
  try {
    text = await readFile(path.join(stateDirectory, "events.ndjson"), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return text
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid Provider fixture event at line ${index + 1}: ${String(error)}`);
      }
    });
}

export async function waitForProviderEvent(stateDirectory, predicate, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const pollMs = options.pollMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  let events = [];
  while (Date.now() < deadline) {
    events = await readProviderEvents(stateDirectory);
    const event = events.find(predicate);
    if (event !== undefined) return event;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`Provider fixture event was not observed within ${timeoutMs} ms. Events: ${JSON.stringify(events)}`);
}

async function removeProviderFixture(temporaryRoot) {
  const resolvedTemporaryDirectory = await realpath(tmpdir());
  let resolvedTarget;
  try {
    resolvedTarget = await realpath(temporaryRoot);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  const relativeTarget = path.relative(resolvedTemporaryDirectory, resolvedTarget);
  if (
    relativeTarget.length === 0
    || relativeTarget === ".."
    || relativeTarget.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeTarget)
    || !path.basename(resolvedTarget).startsWith(TEST_DIRECTORY_PREFIX)
  ) {
    throw new Error(`Refusing to remove non-Provider-test directory '${resolvedTarget}'.`);
  }
  await rm(resolvedTarget, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function requireNonEmptyString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Provider fixture ${name} must be a non-empty string.`);
  }
}

function requireAbsolutePath(value, name) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(`Provider fixture ${name} must be an absolute system temporary path.`);
  }
}

function resolveFixtureRelativePath(projectRoot, value, name) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\") || path.isAbsolute(value)
    || value.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`Provider fixture ${name} must be a normalized Project-relative path.`);
  }
  return path.join(projectRoot, ...value.split("/"));
}
