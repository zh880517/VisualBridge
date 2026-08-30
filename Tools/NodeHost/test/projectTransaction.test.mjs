import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import {
  ProjectTransactionConflict,
  ProjectTransactionFailure,
  withProjectTransaction,
} from "../dist/projectTransaction.js";

test("mutation transactions create, delete, move, and preserve the replace API", async () => {
  await withTemporaryProject(async (projectRoot) => {
    const replacedPath = path.join(projectRoot, "replaced.txt");
    const deletedPath = path.join(projectRoot, "deleted.txt");
    const moveSourcePath = path.join(projectRoot, "move-source.txt");
    const moveTargetPath = path.join(projectRoot, "move-target.txt");
    const createdPath = path.join(projectRoot, "created.txt");
    const absentDependencyPath = path.join(projectRoot, "absent-dependency.txt");
    const replacedBefore = bytes("replace before");
    const replacedAfter = bytes("replace after");
    const deletedBefore = bytes("delete before");
    const movedBytes = bytes("move bytes");
    const createdBytes = bytes("created bytes");
    await writeFile(replacedPath, replacedBefore);
    await writeFile(deletedPath, deletedBefore);
    await writeFile(moveSourcePath, movedBytes);

    const replaceResult = await withProjectTransaction(projectRoot, (transaction) => transaction.commit([{
      path: "replaced.txt",
      absolutePath: replacedPath,
      before: replacedBefore,
      after: replacedAfter,
    }]));
    assert.deepEqual(replaceResult.sources, [{
      path: "replaced.txt",
      previousHash: hash(replacedBefore),
      hash: hash(replacedAfter),
    }]);

    const mutationResult = await withProjectTransaction(projectRoot, (transaction) => transaction.mutate([
      { path: "created.txt", absolutePath: createdPath, after: createdBytes },
      { path: "deleted.txt", absolutePath: deletedPath, before: deletedBefore },
      { path: "move-source.txt", absolutePath: moveSourcePath, before: movedBytes },
      { path: "move-target.txt", absolutePath: moveTargetPath, after: movedBytes },
    ], [{ path: "absent-dependency.txt", absolutePath: absentDependencyPath, expectedAbsent: true }]));

    assert.deepEqual(await readFile(replacedPath), replacedAfter);
    assert.deepEqual(await readFile(createdPath), createdBytes);
    await assert.rejects(readFile(deletedPath), { code: "ENOENT" });
    await assert.rejects(readFile(moveSourcePath), { code: "ENOENT" });
    assert.deepEqual(await readFile(moveTargetPath), movedBytes);
    assert.deepEqual(mutationResult.mutations, [
      { path: "created.txt", hash: hash(createdBytes) },
      { path: "deleted.txt", previousHash: hash(deletedBefore) },
      { path: "move-source.txt", previousHash: hash(movedBytes) },
      { path: "move-target.txt", hash: hash(movedBytes) },
    ]);
    await assertNoTransactionArtifacts(projectRoot);
  });
});

test("a live commit failure rolls every already-replaced source back atomically", async () => {
  await withTemporaryProject(async (projectRoot) => {
    const before = bytes("before");
    const after = bytes("after");
    const mutations = [];
    for (let index = 0; index < 2; index += 1) {
      const logicalPath = `source-${String(index).padStart(3, "0")}.txt`;
      const absolutePath = path.join(projectRoot, logicalPath);
      await writeFile(absolutePath, before);
      mutations.push({ path: logicalPath, absolutePath, before, after });
    }

    const require = createRequire(import.meta.url);
    const fsPromises = require("node:fs/promises");
    const originalRename = fsPromises.rename;
    const businessTargets = new Set(mutations.map((mutation) => mutation.absolutePath));
    const publishedTargets = [];
    fsPromises.rename = async (source, destination) => {
      const isBusinessPublish = source.endsWith(".tmp") && businessTargets.has(destination);
      if (isBusinessPublish && publishedTargets.length === 1) {
        assert.deepEqual(
          await readFile(publishedTargets[0]),
          after,
          "The first business source was not in its published after state before the injected failure.",
        );
        throw Object.assign(new Error("Injected second publish failure."), { code: "EIO" });
      }
      await originalRename(source, destination);
      if (isBusinessPublish) publishedTargets.push(destination);
    };
    try {
      await assert.rejects(withProjectTransaction(
        projectRoot,
        (transaction) => transaction.mutate(mutations),
      ));
    } finally {
      fsPromises.rename = originalRename;
    }
    assert.deepEqual(
      publishedTargets,
      [mutations[0].absolutePath],
      "The failpoint did not run after exactly one business source was published.",
    );
    for (const mutation of mutations) {
      assert.deepEqual(await readFile(mutation.absolutePath), before, `${mutation.path} was not rolled back.`);
    }
    await assertNoTransactionArtifacts(projectRoot);
  });
});

test("expected-absent and mutation baselines reject concurrent targets", async () => {
  await withTemporaryProject(async (projectRoot) => {
    const dependencyPath = path.join(projectRoot, "dependency.txt");
    const targetPath = path.join(projectRoot, "target.txt");
    await writeFile(dependencyPath, bytes("present dependency"));
    await writeFile(targetPath, bytes("present target"));

    await assert.rejects(
      withProjectTransaction(projectRoot, (transaction) => transaction.mutate(
        [{ path: "new.txt", absolutePath: path.join(projectRoot, "new.txt"), after: bytes("new") }],
        [{ path: "dependency.txt", absolutePath: dependencyPath, expectedAbsent: true }],
      )),
      (error) => error instanceof ProjectTransactionConflict && error.reason === "dependencyChanged",
    );
    await assert.rejects(
      withProjectTransaction(projectRoot, (transaction) => transaction.mutate([
        { path: "target.txt", absolutePath: targetPath, after: bytes("must not overwrite") },
      ])),
      (error) => error instanceof ProjectTransactionConflict && error.reason === "baseHashMismatch",
    );
    assert.deepEqual(await readFile(targetPath), bytes("present target"));
    await assertNoTransactionArtifacts(projectRoot);
  });
});

test("transaction paths use ordinal Unicode order for mutations and preconditions", async () => {
  await withTemporaryProject(async (projectRoot) => {
    const decomposedPath = "e\u0301.txt";
    const composedPath = "é.txt";
    const mutationResult = await withProjectTransaction(projectRoot, (transaction) => transaction.mutate([
      { path: composedPath, absolutePath: path.join(projectRoot, composedPath), after: bytes("composed") },
      { path: decomposedPath, absolutePath: path.join(projectRoot, decomposedPath), after: bytes("decomposed") },
    ]));
    assert.deepEqual(mutationResult.mutations.map((mutation) => mutation.path), [decomposedPath, composedPath]);

    const decomposedDependency = `e\u0301-dependency.txt`;
    const composedDependency = "é-dependency.txt";
    await writeFile(path.join(projectRoot, decomposedDependency), bytes("present decomposed dependency"));
    await writeFile(path.join(projectRoot, composedDependency), bytes("present composed dependency"));
    const targetPath = path.join(projectRoot, "must-not-exist.txt");
    await assert.rejects(
      withProjectTransaction(projectRoot, (transaction) => transaction.mutate(
        [{ path: "must-not-exist.txt", absolutePath: targetPath, after: bytes("must not be created") }],
        [
          { path: composedDependency, absolutePath: path.join(projectRoot, composedDependency), expectedAbsent: true },
          { path: decomposedDependency, absolutePath: path.join(projectRoot, decomposedDependency), expectedAbsent: true },
        ],
      )),
      (error) => error instanceof ProjectTransactionConflict
        && error.reason === "dependencyChanged"
        && error.details?.path === decomposedDependency,
    );
    await assert.rejects(lstat(targetPath), { code: "ENOENT" });
    await assertNoTransactionArtifacts(projectRoot);
  });
});

test("create rejects a dangling symbolic-link target instead of treating it as absent", async (context) => {
  await withTemporaryProject(async (projectRoot) => {
    const targetPath = await createDanglingSymbolicLink(context, projectRoot, "created.txt");
    if (targetPath === undefined) return;

    await assert.rejects(
      withProjectTransaction(projectRoot, (transaction) => transaction.mutate([{
        path: "created.txt",
        absolutePath: targetPath,
        after: bytes("must not replace the link"),
      }])),
      (error) => error instanceof ProjectTransactionFailure && error.code === "transaction.pathAlias",
    );

    assert.equal((await lstat(targetPath)).isSymbolicLink(), true);
    await assertNoTransactionArtifacts(projectRoot);
  });
});

test("expected-absent preconditions reject dangling symbolic links", async (context) => {
  await withTemporaryProject(async (projectRoot) => {
    const dependencyPath = await createDanglingSymbolicLink(context, projectRoot, "dependency.txt");
    if (dependencyPath === undefined) return;
    const targetPath = path.join(projectRoot, "created.txt");

    await assert.rejects(
      withProjectTransaction(projectRoot, (transaction) => transaction.mutate(
        [{ path: "created.txt", absolutePath: targetPath, after: bytes("must not be created") }],
        [{ path: "dependency.txt", absolutePath: dependencyPath, expectedAbsent: true }],
      )),
      (error) => error instanceof ProjectTransactionFailure && error.code === "transaction.pathAlias",
    );

    assert.equal((await lstat(dependencyPath)).isSymbolicLink(), true);
    await assert.rejects(lstat(targetPath), { code: "ENOENT" });
    await assertNoTransactionArtifacts(projectRoot);
  });
});

test("recovery preserves a dangling symbolic-link target and its journal", async (context) => {
  await withTemporaryProject(async (projectRoot) => {
    const targetPath = await createDanglingSymbolicLink(context, projectRoot, "created.txt");
    if (targetPath === undefined) return;
    const transactionId = "00000000-0000-4000-8000-000000000106";
    const entry = journalEntry(targetPath, "created.txt", transactionId, undefined, bytes("transaction create"));
    await writeJournal(projectRoot, {
      version: 2,
      transactionId,
      phase: "prepared",
      entries: [entry],
    });

    await assert.rejects(
      withProjectTransaction(projectRoot, async () => undefined),
      (error) => error instanceof ProjectTransactionFailure && error.code === "transaction.pathAlias",
    );

    assert.equal((await lstat(targetPath)).isSymbolicLink(), true);
    assert.equal((await readFile(path.join(projectRoot, ".visualbridge-transaction.json"))).length > 0, true);
  });
});

test("prepared version 2 journals roll back create, delete, and move in reverse order", async () => {
  await withTemporaryProject(async (projectRoot) => {
    const createPath = path.join(projectRoot, "created.txt");
    const deletePath = path.join(projectRoot, "deleted.txt");
    const moveSourcePath = path.join(projectRoot, "move-source.txt");
    const moveTargetPath = path.join(projectRoot, "move-target.txt");
    const createdAfter = bytes("created after");
    const deletedBefore = bytes("deleted before");
    const movedBefore = bytes("moved before");
    const transactionId = "00000000-0000-4000-8000-000000000101";
    const createEntry = journalEntry(createPath, "created.txt", transactionId, undefined, createdAfter);
    const deleteEntry = journalEntry(deletePath, "deleted.txt", transactionId, deletedBefore, undefined);
    const moveDeleteEntry = journalEntry(moveSourcePath, "move-source.txt", transactionId, movedBefore, undefined);
    const moveCreateEntry = journalEntry(moveTargetPath, "move-target.txt", transactionId, undefined, movedBefore);
    await writeFile(createPath, createdAfter);
    await writeFile(deleteEntry.backupPath, deletedBefore);
    await writeFile(moveDeleteEntry.backupPath, movedBefore);
    await writeFile(moveTargetPath, movedBefore);
    await writeJournal(projectRoot, {
      version: 2,
      transactionId,
      phase: "prepared",
      entries: [createEntry, deleteEntry, moveDeleteEntry, moveCreateEntry],
    });

    await withProjectTransaction(projectRoot, async () => undefined);

    await assert.rejects(readFile(createPath), { code: "ENOENT" });
    assert.deepEqual(await readFile(deletePath), deletedBefore);
    assert.deepEqual(await readFile(moveSourcePath), movedBefore);
    await assert.rejects(readFile(moveTargetPath), { code: "ENOENT" });
    await assertNoTransactionArtifacts(projectRoot);
  });
});

test("prepared recovery preserves unknown external bytes and recovery materials", async () => {
  await withTemporaryProject(async (projectRoot) => {
    const createPath = path.join(projectRoot, "created.txt");
    const deletePath = path.join(projectRoot, "deleted.txt");
    const createdAfter = bytes("transaction create");
    const deletedBefore = bytes("transaction delete before");
    const externalCreate = bytes("external create bytes");
    const externalDelete = bytes("external delete bytes");
    const transactionId = "00000000-0000-4000-8000-000000000102";
    const createEntry = journalEntry(createPath, "created.txt", transactionId, undefined, createdAfter);
    const deleteEntry = journalEntry(deletePath, "deleted.txt", transactionId, deletedBefore, undefined);
    await writeFile(createPath, externalCreate);
    await writeFile(deletePath, externalDelete);
    await writeFile(deleteEntry.backupPath, deletedBefore);
    await writeJournal(projectRoot, {
      version: 2,
      transactionId,
      phase: "prepared",
      entries: [createEntry, deleteEntry],
    });

    await assert.rejects(
      withProjectTransaction(projectRoot, async () => undefined),
      (error) => error instanceof ProjectTransactionFailure && error.code === "transaction.recoveryFailed",
    );
    assert.deepEqual(await readFile(createPath), externalCreate);
    assert.deepEqual(await readFile(deletePath), externalDelete);
    assert.deepEqual(await readFile(deleteEntry.backupPath), deletedBefore);
    assert.equal((await readFile(path.join(projectRoot, ".visualbridge-transaction.json"))).length > 0, true);
  });
});

test("committed journals verify absent and present states before cleanup", async () => {
  await withTemporaryProject(async (projectRoot) => {
    const createPath = path.join(projectRoot, "created.txt");
    const deletePath = path.join(projectRoot, "deleted.txt");
    const createdAfter = bytes("committed create");
    const deletedBefore = bytes("committed delete");
    const transactionId = "00000000-0000-4000-8000-000000000103";
    const createEntry = journalEntry(createPath, "created.txt", transactionId, undefined, createdAfter);
    const deleteEntry = journalEntry(deletePath, "deleted.txt", transactionId, deletedBefore, undefined);
    await writeFile(createPath, createdAfter);
    await writeFile(deleteEntry.backupPath, deletedBefore);
    await writeJournal(projectRoot, {
      version: 2,
      transactionId,
      phase: "committed",
      entries: [createEntry, deleteEntry],
    });

    await withProjectTransaction(projectRoot, async () => undefined);
    assert.deepEqual(await readFile(createPath), createdAfter);
    await assert.rejects(readFile(deletePath), { code: "ENOENT" });
    await assertNoTransactionArtifacts(projectRoot);

    const changedId = "00000000-0000-4000-8000-000000000104";
    const changedEntry = journalEntry(deletePath, "deleted.txt", changedId, deletedBefore, undefined);
    const external = bytes("external after committed delete");
    await writeFile(deletePath, external);
    await writeFile(changedEntry.backupPath, deletedBefore);
    await writeJournal(projectRoot, {
      version: 2,
      transactionId: changedId,
      phase: "committed",
      entries: [changedEntry],
    });
    await assert.rejects(
      withProjectTransaction(projectRoot, async () => undefined),
      (error) => error instanceof ProjectTransactionFailure && error.code === "transaction.committedStateChanged",
    );
    assert.deepEqual(await readFile(deletePath), external);
    assert.deepEqual(await readFile(changedEntry.backupPath), deletedBefore);
  });
});

test("version 1 replacement journals remain recoverable and paths stay inside the project", async () => {
  await withTemporaryProject(async (projectRoot) => {
    const targetPath = path.join(projectRoot, "legacy.txt");
    const before = bytes("legacy before");
    const after = bytes("legacy after");
    const transactionId = "00000000-0000-4000-8000-000000000105";
    const entry = journalEntry(targetPath, "legacy.txt", transactionId, before, after);
    await writeFile(entry.backupPath, before);
    await writeJournal(projectRoot, { version: 1, transactionId, phase: "prepared", entries: [entry] });
    await withProjectTransaction(projectRoot, async () => undefined);
    assert.deepEqual(await readFile(targetPath), before);
    await assertNoTransactionArtifacts(projectRoot);

    await assert.rejects(
      withProjectTransaction(projectRoot, (transaction) => transaction.mutate([{
        path: "../outside.txt",
        absolutePath: path.join(projectRoot, "..", "outside.txt"),
        after: bytes("outside"),
      }])),
      (error) => error instanceof ProjectTransactionFailure && error.code === "transaction.pathOutsideProject",
    );
    await assert.rejects(
      withProjectTransaction(projectRoot, (transaction) => transaction.mutate([{
        path: "C:/outside.txt",
        absolutePath: path.join(projectRoot, "C-drive", "outside.txt"),
        after: bytes("outside"),
      }])),
      (error) => error instanceof ProjectTransactionFailure && error.code === "transaction.pathInvalid",
    );
  });
});

function journalEntry(absolutePath, logicalPath, transactionId, before, after) {
  const prefix = `${absolutePath}.visualbridge-${transactionId}`;
  return {
    path: logicalPath,
    absolutePath,
    temporaryPath: `${prefix}.tmp`,
    backupPath: `${prefix}.rollback`,
    ...(before === undefined ? {} : { beforeHash: hash(before) }),
    ...(after === undefined ? {} : { afterHash: hash(after) }),
  };
}

async function writeJournal(projectRoot, journal) {
  await writeFile(
    path.join(projectRoot, ".visualbridge-transaction.json"),
    `${JSON.stringify(journal, undefined, 2)}\n`,
    "utf8",
  );
}

async function assertNoTransactionArtifacts(projectRoot) {
  const entries = await readdir(projectRoot);
  assert.ok(!entries.some((entry) => entry.startsWith(".visualbridge-transaction")));
  assert.ok(!entries.some((entry) => entry.includes(".visualbridge-")
    && (entry.endsWith(".tmp") || entry.endsWith(".rollback"))));
}

async function withTemporaryProject(action) {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "visualbridge-project-transaction-"));
  try {
    await action(projectRoot);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
}

async function createDanglingSymbolicLink(context, projectRoot, name) {
  const linkPath = path.join(projectRoot, name);
  try {
    await symlink("missing-target.txt", linkPath, "file");
  } catch (error) {
    if (!["EPERM", "EACCES", "ENOSYS", "ENOTSUP"].includes(error?.code)) throw error;
    try {
      await symlink(path.join(projectRoot, "missing-target-directory"), linkPath, "junction");
    } catch (junctionError) {
      if (!["EPERM", "EACCES", "ENOSYS", "ENOTSUP"].includes(junctionError?.code)) throw junctionError;
      context.skip(`symbolic links and junctions are unavailable on this platform (${junctionError.code})`);
      return undefined;
    }
  }
  return linkPath;
}

function bytes(value) {
  return Buffer.from(`${value}\n`, "utf8");
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}
