import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  ProjectProviderHost,
  ProjectProviderRuntimeError,
} from "../dist/index.js";
import { createProviderFixture } from "./providerFixture.mjs";

const DOCUMENT_PATH = "Config/ProviderSettings.providerconfig";
const DOCUMENT_TYPE_ID = "sample.provider.settings";
const REFERENCE_TARGET = Object.freeze({ scope: "weapons" });

test("coordinates declared reference and validator capabilities through one Provider host", async (t) => {
  const { fixture, host } = await createHost(t);
  const provider = singleReferenceProvider(host);

  assert.equal(await provider.validateTarget(REFERENCE_TARGET), undefined);
  assert.equal(await provider.validateTarget({ scope: "armor" }), "sample.asset requires target.scope 'weapons'.");
  assert.deepEqual(
    (await provider.search({ target: REFERENCE_TARGET, query: "swo", limit: 20 })).map((entry) => entry.value),
    ["asset.sword"],
  );
  assert.deepEqual(
    (await provider.resolve({ target: REFERENCE_TARGET, value: "asset.sword" })).map((entry) => entry.value),
    ["asset.sword"],
  );

  const validation = await host.validateDocuments([await readDocumentSnapshot(fixture.projectRoot, "Needs Provider Review")]);
  assert.deepEqual(validation.unavailableProviderIds, []);
  assert.deepEqual(validation.diagnostics.map((diagnostic) => diagnostic.code), ["sample.provider.displayNameReview"]);
});

for (const scenario of [
  {
    mode: "candidateWrongKind",
    invoke: (provider) => provider.search({ target: REFERENCE_TARGET, query: "swo", limit: 20 }),
  },
  {
    mode: "candidateWrongTarget",
    invoke: (provider) => provider.search({ target: REFERENCE_TARGET, query: "swo", limit: 20 }),
  },
  {
    mode: "candidateWrongValue",
    invoke: (provider) => provider.resolve({ target: REFERENCE_TARGET, value: "asset.sword" }),
  },
  {
    mode: "candidateOutsideLocation",
    invoke: (provider) => provider.search({ target: REFERENCE_TARGET, query: "swo", limit: 20 }),
  },
]) {
  test(`rejects ${scenario.mode} candidates at the shared host boundary`, async (t) => {
    const { host } = await createHost(t, { mode: scenario.mode });
    await assert.rejects(
      scenario.invoke(singleReferenceProvider(host)),
      (error) => error instanceof ProjectProviderRuntimeError && error.code === "provider.protocolViolation",
    );
  });
}

test("converts a validator diagnostic outside the supplied snapshot into Provider unavailable", async (t) => {
  const { fixture, host } = await createHost(t, { mode: "diagnosticOutsideSnapshot" });
  const validation = await host.validateDocuments([await readDocumentSnapshot(fixture.projectRoot, "Needs Provider Review")]);

  assert.deepEqual(validation.unavailableProviderIds, ["sample.provider"]);
  assert.deepEqual(validation.diagnostics.map((diagnostic) => diagnostic.code), ["provider.unavailable"]);
  assert.match(validation.diagnostics[0].message, /escaped the supplied semantic snapshot/u);
});

test("rejects duplicate validator snapshots before invoking a Provider", async (t) => {
  const { fixture, host } = await createHost(t);
  const snapshot = await readDocumentSnapshot(fixture.projectRoot, "Needs Provider Review");
  await assert.rejects(
    host.validateDocuments([snapshot, snapshot]),
    (error) => error instanceof ProjectProviderRuntimeError && error.code === "provider.duplicateDocumentSnapshot",
  );
});

test("keeps declared but runtime-inactive capabilities unavailable", async (t) => {
  const { host } = await createHost(t, {}, (project) => ({
    ...project,
    providers: project.providers.map((provider) => ({
      ...provider,
      capabilities: {
        ...provider.capabilities,
        reference: { kinds: [...provider.capabilities.reference.kinds, "sample.inactive"] },
      },
    })),
  }));
  const inactive = host.referenceProviders.find((provider) => provider.kind === "sample.inactive");
  assert.ok(inactive);
  await assert.rejects(
    inactive.search({ target: REFERENCE_TARGET, query: "", limit: 20 }),
    (error) => error instanceof ProjectProviderRuntimeError && error.code === "provider.capabilityUnavailable",
  );
});

async function createHost(t, fixtureOptions = {}, projectTransform = (project) => project) {
  const fixture = await createProviderFixture({ ...fixtureOptions, passPathsInArguments: true });
  const project = projectTransform(JSON.parse(await readFile(fixture.projectFile, "utf8")));
  const host = await ProjectProviderHost.create({
    projectRoot: fixture.projectRoot,
    projectHash: "0".repeat(64),
    project,
    allowedEntryPaths: [fixture.entryPath],
    captureSourceManifest: () => captureAuthoringManifest(fixture.projectRoot),
    isDeclaredDocument: (documentTypeId, documentPath) => (
      documentTypeId === DOCUMENT_TYPE_ID && documentPath === DOCUMENT_PATH
    ),
    runtime: {
      initializeTimeoutMs: 500,
      requestTimeoutMs: 500,
      shutdownTimeoutMs: 100,
      cancellationGraceMs: 50,
      restart: { initialDelayMs: 20, maxDelayMs: 80, maxAttempts: 2, stableAfterMs: 1_000 },
    },
  });
  t.after(async () => {
    await host.dispose();
    await fixture.dispose();
  });
  return { fixture, host };
}

function singleReferenceProvider(host) {
  assert.equal(host.referenceProviders.length, 1);
  return host.referenceProviders[0];
}

async function readDocumentSnapshot(projectRoot, displayName) {
  const document = JSON.parse(await readFile(path.join(projectRoot, ...DOCUMENT_PATH.split("/")), "utf8"));
  document.properties.displayName = displayName;
  const content = `${JSON.stringify(document)}\n`;
  return {
    documentTypeId: DOCUMENT_TYPE_ID,
    path: DOCUMENT_PATH,
    sourceHash: sha256(Buffer.from(content, "utf8")),
    content: document,
  };
}

async function captureAuthoringManifest(projectRoot) {
  const paths = ["VisualBridge.project.vbjson"];
  await collectFiles(projectRoot, "Catalog", paths);
  await collectFiles(projectRoot, "Config", paths);
  return await Promise.all(paths.sort().map(async (relativePath) => ({
    path: relativePath,
    hash: sha256(await readFile(path.join(projectRoot, ...relativePath.split("/")))),
  })));
}

async function collectFiles(projectRoot, relativeDirectory, result) {
  const entries = await readdir(path.join(projectRoot, ...relativeDirectory.split("/")), { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    const relativePath = `${relativeDirectory}/${entry.name}`;
    if (entry.isFile()) result.push(relativePath);
    else if (entry.isDirectory()) await collectFiles(projectRoot, relativePath, result);
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
