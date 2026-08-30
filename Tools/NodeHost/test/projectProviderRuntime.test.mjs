import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, symlink } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { compareUtf16CodeUnits } from "@visualbridge/core";
import {
  ProjectProviderExternalModificationError,
  ProjectProviderRuntime,
  ProjectProviderRuntimeError,
} from "../dist/index.js";
import {
  createProviderFixture,
  providerArgumentSentinel,
  providerFixtureEntry,
  readProviderEvents,
  waitForProviderEvent,
} from "./providerFixture.mjs";

const SEARCH_PARAMS = Object.freeze({
  kind: "sample.asset",
  target: { scope: "weapons" },
  query: "swo",
  limit: 20,
});

test("launches an authorized .mjs entry without shell interpolation and negotiates capabilities", async (t) => {
  const fixture = await createProviderFixture({ passPathsInArguments: true });
  const logs = [];
  const runtime = await createRuntime(fixture, { log: (event) => logs.push(event) });
  registerCleanup(t, fixture, runtime);

  const capabilities = await runtime.start(invocation(fixture.projectRoot));
  assert.deepEqual(capabilities, {
    reference: { kinds: ["sample.asset"] },
    validator: { documentTypes: ["sample.provider.settings"] },
  });
  const result = await runtime.request("reference/search", SEARCH_PARAMS, invocation(fixture.projectRoot));
  assert.equal(result.status, "ok");
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].value, "asset.sword");
  const start = await waitForProviderEvent(fixture.stateDirectory, (event) => event.type === "start");
  assert.equal(start.echoArgument, providerArgumentSentinel);
  assert.ok(start.argv.includes(providerArgumentSentinel));
  assert.ok(logs.some((event) => event.event === "provider.spawned" && Number.isInteger(event.pid)));
  assert.ok(logs.some((event) => event.event === "provider.ready"));
});

test("accepts runtime capabilities that are a strict subset of the Project authorization", async (t) => {
  const fixture = await createProviderFixture({ passPathsInArguments: true });
  const runtime = await createRuntime(fixture, {
    definitionTransform: (definition) => ({
      ...definition,
      capabilities: {
        reference: { kinds: [...definition.capabilities.reference.kinds, "sample.extra"] },
        validator: {
          documentTypes: [...definition.capabilities.validator.documentTypes, "sample.extra.document"],
        },
      },
    }),
  });
  registerCleanup(t, fixture, runtime);
  await runtime.start(invocation(fixture.projectRoot));
  assert.equal(runtime.state, "ready");
});

test("rejects runtime capabilities outside the Project authorization", async (t) => {
  const fixture = await createProviderFixture({ passPathsInArguments: true });
  const runtime = await createRuntime(fixture, {
    definitionTransform: (definition) => ({
      ...definition,
      capabilities: { validator: definition.capabilities.validator },
    }),
  });
  registerCleanup(t, fixture, runtime);
  await assert.rejects(
    runtime.start(invocation(fixture.projectRoot)),
    (error) => isRuntimeError(error, "provider.capabilityMismatch"),
  );
});

test("times out, sends cancellation, isolates the process and enters bounded restart backoff", async (t) => {
  const fixture = await createProviderFixture({
    mode: "timeout",
    faultMethod: "reference/search",
    passPathsInArguments: true,
  });
  const logs = [];
  const runtime = await createRuntime(fixture, {
    log: (event) => logs.push(event),
    requestTimeoutMs: 80,
    cancellationGraceMs: 40,
  });
  registerCleanup(t, fixture, runtime);
  await runtime.start(invocation(fixture.projectRoot));

  await assert.rejects(
    runtime.request("reference/search", SEARCH_PARAMS, invocation(fixture.projectRoot)),
    (error) => isRuntimeError(error, "provider.timeout"),
  );
  assert.equal(runtime.state, "backoff");
  await waitForProviderEvent(
    fixture.stateDirectory,
    (event) => event.type === "notification" && event.method === "$/cancelRequest",
  );
  assert.ok(logs.some((event) => event.event === "provider.requestTimeout"));
  assert.ok(logs.some((event) => event.event === "provider.crashed" && event.delayMs > 0));
});

test("honors AbortSignal cancellation and stops a request that does not settle", async (t) => {
  const fixture = await createProviderFixture({
    mode: "timeout",
    faultMethod: "reference/search",
    passPathsInArguments: true,
  });
  const runtime = await createRuntime(fixture, { requestTimeoutMs: 2_000, cancellationGraceMs: 40 });
  registerCleanup(t, fixture, runtime);
  await runtime.start(invocation(fixture.projectRoot));
  const controller = new AbortController();
  const request = runtime.request(
    "reference/search",
    SEARCH_PARAMS,
    { ...invocation(fixture.projectRoot), signal: controller.signal },
  );
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(request, (error) => isRuntimeError(error, "provider.cancelled"));
  assert.equal(runtime.state, "stopped");
});

test("cancellation during start, backoff and ready transitions never leaves an unhandled rejection", async () => {
  await assertNoUnhandledRejections(async () => {
    await withRuntime({ passPathsInArguments: true }, {}, async (fixture, runtime) => {
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(
        runtime.start({ ...invocation(fixture.projectRoot), signal: controller.signal }),
        (error) => isRuntimeError(error, "provider.cancelled"),
      );
    });

    await withRuntime(
      { mode: "timeout", faultMethod: "initialize", passPathsInArguments: true },
      { requestTimeoutMs: 2_000, cancellationGraceMs: 30 },
      async (fixture, runtime) => {
        const controller = new AbortController();
        const starting = runtime.start({ ...invocation(fixture.projectRoot), signal: controller.signal });
        setTimeout(() => controller.abort(), 20);
        await assert.rejects(starting, (error) => isRuntimeError(error, "provider.cancelled"));
      },
    );

    await withRuntime(
      { mode: "crashThenHealthy", crashStarts: 1, passPathsInArguments: true },
      { restart: { initialDelayMs: 100, maxDelayMs: 100, maxAttempts: 4, stableAfterMs: 1_000 } },
      async (fixture, runtime) => {
        await assert.rejects(
          runtime.start(invocation(fixture.projectRoot)),
          (error) => isRuntimeError(error, "provider.crashed"),
        );
        assert.equal(runtime.state, "backoff");
        const controller = new AbortController();
        const restarting = runtime.start({ ...invocation(fixture.projectRoot), signal: controller.signal });
        setTimeout(() => controller.abort(), 20);
        await assert.rejects(restarting, (error) => isRuntimeError(error, "provider.cancelled"));
      },
    );

    await withRuntime(
      { mode: "timeout", faultMethod: "reference/search", passPathsInArguments: true },
      { requestTimeoutMs: 2_000, cancellationGraceMs: 30 },
      async (fixture, runtime) => {
        await runtime.start(invocation(fixture.projectRoot));
        const controller = new AbortController();
        const request = runtime.request(
          "reference/search",
          SEARCH_PARAMS,
          { ...invocation(fixture.projectRoot), signal: controller.signal },
        );
        setTimeout(() => controller.abort(), 20);
        await assert.rejects(request, (error) => isRuntimeError(error, "provider.cancelled"));
      },
    );
  });
});

test("isolates crashes and restarts only after exponential backoff", async (t) => {
  const fixture = await createProviderFixture({
    mode: "crashThenHealthy",
    crashStarts: 2,
    passPathsInArguments: true,
  });
  const logs = [];
  const runtime = await createRuntime(fixture, {
    log: (event) => logs.push(event),
    restart: { initialDelayMs: 25, maxDelayMs: 100, maxAttempts: 4, stableAfterMs: 1_000 },
  });
  registerCleanup(t, fixture, runtime);

  await assert.rejects(runtime.start(invocation(fixture.projectRoot)), (error) => isRuntimeError(error, "provider.crashed"));
  await assert.rejects(runtime.start(invocation(fixture.projectRoot)), (error) => isRuntimeError(error, "provider.crashed"));
  await runtime.start(invocation(fixture.projectRoot));
  assert.equal(runtime.state, "ready");
  const starts = (await readProviderEvents(fixture.stateDirectory)).filter((event) => event.type === "start");
  assert.equal(starts.length, 3);
  assert.deepEqual(
    logs.filter((event) => event.event === "provider.crashed").map((event) => event.delayMs),
    [25, 50],
  );
});

for (const [mode, code] of [
  ["invalidJson", "provider.invalidJson"],
  ["invalidResult", "provider.invalidResponse"],
]) {
  test(`rejects ${mode} Provider output through the strict Core response parser`, async (t) => {
    const fixture = await createProviderFixture({ mode, faultMethod: "reference/search", passPathsInArguments: true });
    const runtime = await createRuntime(fixture);
    registerCleanup(t, fixture, runtime);
    await runtime.start(invocation(fixture.projectRoot));
    await assert.rejects(
      runtime.request("reference/search", SEARCH_PARAMS, invocation(fixture.projectRoot)),
      (error) => isRuntimeError(error, code),
    );
    assert.equal(runtime.state, "backoff");
  });
}

test("captures Provider stderr as structured logs without mixing it with protocol stdout", async (t) => {
  const fixture = await createProviderFixture({ mode: "stderr", passPathsInArguments: true });
  const logs = [];
  const runtime = await createRuntime(fixture, { log: (event) => logs.push(event) });
  registerCleanup(t, fixture, runtime);
  await runtime.start(invocation(fixture.projectRoot));
  await runtime.request("reference/search", SEARCH_PARAMS, invocation(fixture.projectRoot));
  await waitFor(() => logs.some((event) => event.event === "provider.stderr"));
  const stderr = logs.find((event) => event.event === "provider.stderr");
  assert.match(stderr.message, /fixture stderr/u);
});

test("externalModification overrides a successful response after overwriting an Authoring source", async (t) => {
  const fixture = await createProviderFixture({
    mode: "rewriteAuthoring",
    faultMethod: "reference/search",
    passPathsInArguments: true,
    rewriteSourceRelative: "Config/ProviderSettings.providerconfig",
  });
  const runtime = await createRuntime(fixture);
  registerCleanup(t, fixture, runtime);
  await runtime.start(invocation(fixture.projectRoot));
  await assert.rejects(
    runtime.request("reference/search", SEARCH_PARAMS, invocation(fixture.projectRoot)),
    (error) => error instanceof ProjectProviderExternalModificationError
      && error.changedPaths.includes("Config/ProviderSettings.providerconfig"),
  );
  assert.equal(runtime.state, "quarantined");
});

test("externalModification detects a newly-created Authoring source from the recaptured path set", async (t) => {
  const fixture = await createProviderFixture({
    mode: "rewriteAuthoring",
    faultMethod: "reference/search",
    passPathsInArguments: true,
    rewriteSourceRelative: "Config/Created.providerconfig",
  });
  const runtime = await createRuntime(fixture);
  registerCleanup(t, fixture, runtime);
  await runtime.start(invocation(fixture.projectRoot));
  await assert.rejects(
    runtime.request("reference/search", SEARCH_PARAMS, invocation(fixture.projectRoot)),
    (error) => error instanceof ProjectProviderExternalModificationError
      && error.changedPaths.includes("Config/Created.providerconfig"),
  );
  assert.equal(runtime.state, "quarantined");
});

test("externalModification wins when a Provider writes and also returns an invalid response", async (t) => {
  const fixture = await createProviderFixture({
    mode: "rewriteAuthoringInvalidResult",
    faultMethod: "reference/search",
    passPathsInArguments: true,
    rewriteSourceRelative: "Config/ProviderSettings.providerconfig",
  });
  const runtime = await createRuntime(fixture);
  registerCleanup(t, fixture, runtime);
  await runtime.start(invocation(fixture.projectRoot));
  await assert.rejects(
    runtime.request("reference/search", SEARCH_PARAMS, invocation(fixture.projectRoot)),
    (error) => error instanceof ProjectProviderExternalModificationError
      && error.changedPaths.includes("Config/ProviderSettings.providerconfig")
      && error.cause instanceof ProjectProviderRuntimeError
      && error.cause.code === "provider.invalidResponse",
  );
});

test("authorizes declared and canonical Provider entries through a trusted project-root alias", async (t) => {
  const fixture = await createProviderFixture({ passPathsInArguments: true });
  const runtimes = [];
  t.after(async () => {
    await Promise.all(runtimes.map(safeDispose));
    await fixture.dispose();
  });
  const projectRoot = path.join(fixture.temporaryRoot, "project-root-alias");
  if (!await createDirectoryAlias(t, fixture.projectRoot, projectRoot)) return;
  const project = await readProject(projectRoot);
  const definition = project.providers[0];
  const declaredEntryPath = path.join(projectRoot, ...providerFixtureEntry.split("/"));

  for (const allowedEntryPath of [declaredEntryPath, fixture.entryPath]) {
    const runtime = await ProjectProviderRuntime.create({
      ...baseOptions(fixture, definition),
      projectRoot,
      allowedEntryPaths: [allowedEntryPath],
    });
    runtimes.push(runtime);
    assert.equal(await runtime.captureEntryHash(), sha256(await readFile(fixture.entryPath)));
  }
});

test("rejects directory aliases below a trusted Provider project root", async (t) => {
  const fixture = await createProviderFixture({ passPathsInArguments: true });
  t.after(() => fixture.dispose());
  const projectRoot = path.join(fixture.temporaryRoot, "project-root-alias");
  if (!await createDirectoryAlias(t, fixture.projectRoot, projectRoot)) return;
  const aliasedProviders = path.join(fixture.projectRoot, "AliasedProviders");
  if (!await createDirectoryAlias(t, path.join(fixture.projectRoot, "Providers"), aliasedProviders)) return;
  const project = await readProject(projectRoot);
  const definition = { ...project.providers[0], entry: "AliasedProviders/sample-provider.mjs" };

  await assert.rejects(
    ProjectProviderRuntime.create({
      ...baseOptions(fixture, definition),
      projectRoot,
      allowedEntryPaths: [path.join(projectRoot, "AliasedProviders", "sample-provider.mjs")],
    }),
    (error) => isRuntimeError(error, "provider.entryAlias"),
  );
});

test("rejects an allowlist symlink even when it resolves to the declared Provider entry", async (t) => {
  const fixture = await createProviderFixture({ passPathsInArguments: true });
  t.after(() => fixture.dispose());
  const allowlistAlias = path.join(fixture.temporaryRoot, "allowlisted-provider.mjs");
  try {
    await symlink(fixture.entryPath, allowlistAlias, "file");
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.diagnostic(`Allowlist symlink assertion skipped on this host: ${error.code}`);
      return;
    }
    throw error;
  }
  const project = await readProject(fixture.projectRoot);

  await assert.rejects(
    ProjectProviderRuntime.create({
      ...baseOptions(fixture, project.providers[0]),
      allowedEntryPaths: [allowlistAlias],
    }),
    (error) => isRuntimeError(error, "provider.invalidAllowlist"),
  );
});

test("rejects an undeclared allowlist directory alias to the Provider entry", async (t) => {
  const fixture = await createProviderFixture({ passPathsInArguments: true });
  t.after(() => fixture.dispose());
  const allowlistDirectory = path.join(fixture.temporaryRoot, "allowlist-directory-alias");
  if (!await createDirectoryAlias(t, path.join(fixture.projectRoot, "Providers"), allowlistDirectory)) return;
  const project = await readProject(fixture.projectRoot);

  await assert.rejects(
    ProjectProviderRuntime.create({
      ...baseOptions(fixture, project.providers[0]),
      allowedEntryPaths: [path.join(allowlistDirectory, "sample-provider.mjs")],
    }),
    (error) => isRuntimeError(error, "provider.invalidAllowlist"),
  );
});

test("rejects traversal, non-allowlisted entries and symlink aliases before spawn", async (t) => {
  const fixture = await createProviderFixture({ passPathsInArguments: true });
  t.after(() => fixture.dispose());
  const project = await readProject(fixture.projectRoot);
  const definition = project.providers[0];
  await assert.rejects(
    ProjectProviderRuntime.create(baseOptions(fixture, { ...definition, entry: "../outside.mjs" })),
    (error) => isRuntimeError(error, "provider.invalidPath"),
  );
  await assert.rejects(
    ProjectProviderRuntime.create({ ...baseOptions(fixture, definition), allowedEntryPaths: [fixture.projectFile] }),
    (error) => isRuntimeError(error, "provider.entryNotAllowed"),
  );

  const linkPath = path.join(fixture.projectRoot, "Providers", "linked-provider.mjs");
  try {
    await symlink(fixture.entryPath, linkPath, "file");
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.diagnostic(`Symlink assertion skipped on this host: ${error.code}`);
      return;
    }
    throw error;
  }
  await assert.rejects(
    ProjectProviderRuntime.create({
      ...baseOptions(fixture, { ...definition, entry: "Providers/linked-provider.mjs" }),
      allowedEntryPaths: [linkPath],
    }),
    (error) => isRuntimeError(error, "provider.entryAlias"),
  );
});

async function createRuntime(fixture, overrides = {}) {
  const project = await readProject(fixture.projectRoot);
  const originalDefinition = project.providers[0];
  const definition = overrides.definitionTransform?.(originalDefinition) ?? originalDefinition;
  return ProjectProviderRuntime.create({
    ...baseOptions(fixture, definition),
    requestTimeoutMs: overrides.requestTimeoutMs ?? 250,
    cancellationGraceMs: overrides.cancellationGraceMs ?? 50,
    restart: overrides.restart ?? { initialDelayMs: 20, maxDelayMs: 80, maxAttempts: 4, stableAfterMs: 1_000 },
    ...(overrides.log === undefined ? {} : { log: overrides.log }),
  });
}

async function withRuntime(fixtureOptions, runtimeOptions, action) {
  const fixture = await createProviderFixture(fixtureOptions);
  const runtime = await createRuntime(fixture, runtimeOptions);
  try {
    await action(fixture, runtime);
  } finally {
    await safeDispose(runtime);
    await fixture.dispose();
  }
}

async function assertNoUnhandledRejections(action) {
  const unhandled = [];
  const listener = (reason) => { unhandled.push(reason); };
  process.on("unhandledRejection", listener);
  try {
    await action();
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    process.removeListener("unhandledRejection", listener);
  }
  assert.deepEqual(
    unhandled,
    [],
    `Unhandled rejection(s): ${unhandled.map((reason) => String(reason?.stack ?? reason)).join("\n")}`,
  );
}

function baseOptions(fixture, definition) {
  return {
    projectRoot: fixture.projectRoot,
    projectId: "visualbridge.provider-semantics",
    projectHash: "0".repeat(64),
    definition,
    allowedEntryPaths: [fixture.entryPath],
    initializeTimeoutMs: 500,
    shutdownTimeoutMs: 100,
  };
}

function invocation(projectRoot) {
  return { captureSourceManifest: () => captureAuthoringManifest(projectRoot) };
}

async function captureAuthoringManifest(projectRoot) {
  const paths = ["VisualBridge.project.vbjson"];
  await collectFiles(projectRoot, "Catalog", paths);
  await collectFiles(projectRoot, "Config", paths);
  const entries = await Promise.all(paths.sort(compareUtf16CodeUnits).map(async (relativePath) => ({
    path: relativePath,
    hash: sha256(await readFile(path.join(projectRoot, ...relativePath.split("/")))),
  })));
  return entries;
}

async function collectFiles(projectRoot, relativeDirectory, result) {
  const absoluteDirectory = path.join(projectRoot, ...relativeDirectory.split("/"));
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
    const relativePath = `${relativeDirectory}/${entry.name}`;
    if (entry.isFile()) result.push(relativePath);
    else if (entry.isDirectory()) await collectFiles(projectRoot, relativePath, result);
  }
}

async function readProject(projectRoot) {
  return JSON.parse(await readFile(path.join(projectRoot, "VisualBridge.project.vbjson"), "utf8"));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isRuntimeError(error, code) {
  return error instanceof ProjectProviderRuntimeError && error.code === code;
}

async function safeDispose(runtime) {
  await runtime.dispose().catch(() => undefined);
}

function registerCleanup(t, fixture, runtime) {
  t.after(async () => {
    await safeDispose(runtime);
    await fixture.dispose();
  });
}

async function createDirectoryAlias(t, targetPath, aliasPath) {
  try {
    await symlink(targetPath, aliasPath, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (!["EPERM", "EACCES", "ENOSYS", "ENOTSUP"].includes(error?.code)) throw error;
    t.diagnostic(`Directory alias assertion skipped on this host: ${error.code}`);
    return false;
  }
  return true;
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Condition was not met within ${timeoutMs} ms.`);
}
