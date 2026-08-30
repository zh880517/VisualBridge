import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, readdir, realpath, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { compareUtf16CodeUnits } from "@visualbridge/core";

const LOCK_FILE_NAME = ".visualbridge-transaction.lock";
const JOURNAL_FILE_NAME = ".visualbridge-transaction.json";
const RECOVERY_GUARD_DIRECTORY_NAME = ".visualbridge-transaction-recovery";
const OWNER_STALE_AFTER_MS = 5 * 60_000;
const TRANSACTION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const recoveryGuardNamePattern = /^(\d{12})\.guard$/;
const releasableOwnerTokens = new Set<string>();
const releasableRecoveryTokens = new Set<string>();

export interface ProjectTransactionWrite {
  readonly path: string;
  readonly absolutePath: string;
  readonly before: Uint8Array;
  readonly after: Uint8Array;
}

export type ProjectTransactionPrecondition = {
  readonly path: string;
  readonly absolutePath: string;
  readonly hash: string;
  readonly expectedAbsent?: never;
} | {
  readonly path: string;
  readonly absolutePath: string;
  readonly hash?: never;
  readonly expectedAbsent: true;
};

export interface ProjectTransactionMutation {
  readonly path: string;
  readonly absolutePath: string;
  /** Undefined means that the target must not exist before the transaction. */
  readonly before?: Uint8Array;
  /** Undefined means that the target must not exist after the transaction. */
  readonly after?: Uint8Array;
}

export interface ProjectTransactionCommitResult {
  readonly sources: readonly {
    readonly path: string;
    readonly previousHash: string;
    readonly hash: string;
  }[];
  readonly maintenance?: {
    readonly code: "transaction.finalizationPending";
    readonly message: string;
  };
}

export interface ProjectTransactionMutationResult {
  readonly mutations: readonly {
    readonly path: string;
    readonly previousHash?: string;
    readonly hash?: string;
  }[];
  readonly maintenance?: ProjectTransactionCommitResult["maintenance"];
}

export class ProjectTransactionConflict extends Error {
  public constructor(
    public readonly reason: "writeInProgress" | "baseHashMismatch" | "dependencyChanged" | "changedBeforeReplace",
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ProjectTransactionConflict";
  }
}

export class ProjectTransactionFailure extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ProjectTransactionFailure";
  }
}

export interface ProjectTransaction {
  commit(
    writes: readonly ProjectTransactionWrite[],
    preconditions?: readonly ProjectTransactionPrecondition[],
  ): Promise<ProjectTransactionCommitResult>;
  mutate(
    mutations: readonly ProjectTransactionMutation[],
    preconditions?: readonly ProjectTransactionPrecondition[],
  ): Promise<ProjectTransactionMutationResult>;
}

interface JournalEntry {
  readonly path: string;
  readonly absolutePath: string;
  readonly temporaryPath: string;
  readonly backupPath: string;
  readonly beforeHash?: string;
  readonly afterHash?: string;
}

interface TransactionJournal {
  readonly version: 2;
  readonly transactionId: string;
  readonly phase: "prepared" | "committed";
  readonly entries: readonly JournalEntry[];
}

export async function withProjectTransaction<T>(
  projectRoot: string,
  action: (transaction: ProjectTransaction) => Promise<T>,
): Promise<T> {
  const lock = await acquireProjectLock(projectRoot);
  try {
    await recoverInterruptedTransaction(projectRoot);
    return await action({
      commit: (writes, preconditions = []) => commitWrites(projectRoot, writes, preconditions),
      mutate: (mutations, preconditions = []) => commitMutations(projectRoot, mutations, preconditions),
    });
  } finally {
    await lock.close().catch(() => undefined);
    releasableOwnerTokens.add(lock.token);
    try {
      await releaseOwnedLock(projectRoot, lock.token);
      releasableOwnerTokens.delete(lock.token);
    } catch {
      // The completed owner token remains recoverable by this process. Other processes keep
      // treating the live PID as authoritative until this process exits.
    }
  }
}

async function commitWrites(
  projectRoot: string,
  writes: readonly ProjectTransactionWrite[],
  preconditions: readonly ProjectTransactionPrecondition[],
): Promise<ProjectTransactionCommitResult> {
  const committed = await commitMutations(projectRoot, writes, preconditions);
  return {
    sources: committed.mutations.map((mutation) => {
      if (mutation.previousHash === undefined || mutation.hash === undefined) {
        throw new ProjectTransactionFailure(
          "transaction.invalidWriteResult",
          `Replace commit for '${mutation.path}' did not preserve both source hashes.`,
        );
      }
      return { path: mutation.path, previousHash: mutation.previousHash, hash: mutation.hash };
    }),
    ...(committed.maintenance === undefined ? {} : { maintenance: committed.maintenance }),
  };
}

async function commitMutations(
  projectRoot: string,
  mutations: readonly ProjectTransactionMutation[],
  preconditions: readonly ProjectTransactionPrecondition[],
): Promise<ProjectTransactionMutationResult> {
  if (mutations.length === 0) return { mutations: [] };
  const transactionId = randomUUID();
  const entries: JournalEntry[] = [];
  let journalWritten = false;
  let maintenance: ProjectTransactionMutationResult["maintenance"];
  try {
    if (new Set(mutations.map((mutation) => pathIdentity(mutation.absolutePath))).size !== mutations.length) {
      throw new ProjectTransactionFailure(
        "transaction.duplicateTarget",
        "A project transaction cannot mutate the same physical source more than once.",
      );
    }
    for (const precondition of preconditions) {
      ensureInside(projectRoot, precondition.absolutePath, precondition.path);
      ensureTargetMatchesLogicalPath(projectRoot, precondition.path, precondition.absolutePath);
      await ensurePhysicalTarget(projectRoot, precondition.absolutePath, precondition.path);
    }
    await verifyPreconditions(preconditions);
    for (const mutation of [...mutations].sort((left, right) => compareUtf16CodeUnits(left.path, right.path))) {
      ensureInside(projectRoot, mutation.absolutePath, mutation.path);
      ensureTargetMatchesLogicalPath(projectRoot, mutation.path, mutation.absolutePath);
      await ensurePhysicalTarget(projectRoot, mutation.absolutePath, mutation.path);
      if (mutation.before === undefined && mutation.after === undefined) {
        throw new ProjectTransactionFailure(
          "transaction.emptyMutation",
          `Transaction mutation '${mutation.path}' has neither a before nor an after state.`,
        );
      }
      const beforeHash = mutation.before === undefined ? undefined : hashBytes(mutation.before);
      const afterHash = mutation.after === undefined ? undefined : hashBytes(mutation.after);
      const currentHash = await readOptionalHash(mutation.absolutePath);
      if (currentHash !== beforeHash) {
        throw new ProjectTransactionConflict(
          "baseHashMismatch",
          `Source '${mutation.path}' changed before the transaction was staged.`,
          { path: mutation.path, expectedHash: beforeHash, actualHash: currentHash },
        );
      }
      const suffix = `.visualbridge-${transactionId}`;
      const temporaryPath = `${mutation.absolutePath}${suffix}.tmp`;
      const backupPath = `${mutation.absolutePath}${suffix}.rollback`;
      if (mutation.after !== undefined) {
        const targetMode = mutation.before === undefined ? undefined : (await stat(mutation.absolutePath)).mode;
        try {
          const temporaryHandle = await open(temporaryPath, "wx", targetMode);
          try {
            await temporaryHandle.writeFile(mutation.after);
            await temporaryHandle.sync();
          } finally {
            await temporaryHandle.close();
          }
        } catch (errorValue) {
          await unlink(temporaryPath).catch(() => undefined);
          throw errorValue;
        }
      }
      entries.push({
        path: mutation.path,
        absolutePath: mutation.absolutePath,
        temporaryPath,
        backupPath,
        ...(beforeHash === undefined ? {} : { beforeHash }),
        ...(afterHash === undefined ? {} : { afterHash }),
      });
    }
    await writeJournal(projectRoot, { version: 2, transactionId, phase: "prepared", entries });
    journalWritten = true;
    await verifyPreconditions(preconditions);
    for (const entry of entries) {
      await ensurePhysicalTarget(projectRoot, entry.absolutePath, entry.path);
      const currentHash = await readOptionalHash(entry.absolutePath);
      if (currentHash !== entry.beforeHash) {
        throw new ProjectTransactionConflict(
          "changedBeforeReplace",
          `Source '${entry.path}' changed during the transaction.`,
          { path: entry.path, expectedHash: entry.beforeHash, actualHash: currentHash },
        );
      }
      if (entry.beforeHash !== undefined) {
        await rename(entry.absolutePath, entry.backupPath);
      }
      if (entry.afterHash !== undefined) {
        await rename(entry.temporaryPath, entry.absolutePath);
      }
    }
    for (const entry of entries) {
      const persistedHash = await readOptionalHash(entry.absolutePath);
      if (persistedHash !== entry.afterHash) {
        throw new ProjectTransactionFailure(
          "transaction.verificationFailed",
          `Persisted state for '${entry.path}' does not match the staged transaction.`,
          { path: entry.path, expectedHash: entry.afterHash, actualHash: persistedHash },
        );
      }
    }
    await writeJournal(projectRoot, { version: 2, transactionId, phase: "committed", entries });
    try {
      await cleanupCommitted(projectRoot, entries);
    } catch (errorValue) {
      try {
        await recoverInterruptedTransaction(projectRoot);
      } catch (recoveryError) {
        if (!await committedTargetsMatch(entries)) {
          throw new ProjectTransactionFailure(
            "transaction.finalizationFailed",
            "The transaction committed, but its targets or recovery materials could not be verified.",
            { cleanupError: formatError(errorValue), recoveryError: formatError(recoveryError) },
          );
        }
        maintenance = {
          code: "transaction.finalizationPending",
          message: "The transaction committed and was verified, but recovery materials require a later cleanup pass.",
        };
      }
    }
    journalWritten = false;
    return {
      mutations: entries.map((entry) => ({
        path: entry.path,
        ...(entry.beforeHash === undefined ? {} : { previousHash: entry.beforeHash }),
        ...(entry.afterHash === undefined ? {} : { hash: entry.afterHash }),
      })),
      ...(maintenance === undefined ? {} : { maintenance }),
    };
  } catch (errorValue) {
    if (errorValue instanceof ProjectTransactionFailure && errorValue.code === "transaction.finalizationFailed") {
      throw errorValue;
    }
    if (journalWritten) {
      try {
        await recoverInterruptedTransaction(projectRoot);
        journalWritten = false;
      } catch (rollbackError) {
        throw new ProjectTransactionFailure(
          "transaction.rollbackFailed",
          "The project transaction failed and could not safely restore every source.",
          { writeError: formatError(errorValue), rollbackError: formatError(rollbackError) },
        );
      }
    }
    if (errorValue instanceof ProjectTransactionConflict || errorValue instanceof ProjectTransactionFailure) {
      throw errorValue;
    }
    throw new ProjectTransactionFailure(
      "transaction.commitFailed",
      "The project transaction failed; all staged changes were restored.",
      { cause: formatError(errorValue) },
    );
  } finally {
    if (!journalWritten) {
      await Promise.all(entries.flatMap((entry) => [entry.temporaryPath, entry.backupPath])
        .map((filePath) => unlink(filePath).catch(() => undefined)));
    }
  }
}

async function verifyPreconditions(preconditions: readonly ProjectTransactionPrecondition[]): Promise<void> {
  for (const precondition of [...preconditions].sort((left, right) => compareUtf16CodeUnits(left.path, right.path))) {
    const actualHash = await readOptionalHash(precondition.absolutePath);
    const expectedHash = precondition.expectedAbsent === true ? undefined : precondition.hash;
    if (actualHash !== expectedHash) {
      throw new ProjectTransactionConflict(
        "dependencyChanged",
        `Transaction dependency '${precondition.path}' changed.`,
        { path: precondition.path, expectedHash, actualHash },
      );
    }
  }
}

async function recoverInterruptedTransaction(projectRoot: string): Promise<void> {
  const journalPath = path.join(projectRoot, JOURNAL_FILE_NAME);
  let bytes: Buffer;
  try {
    bytes = await readFile(journalPath);
  } catch (errorValue) {
    if (isNodeError(errorValue, "ENOENT")) return;
    throw errorValue;
  }
  const journal = parseJournal(bytes, projectRoot);
  for (const entry of journal.entries) {
    await ensurePhysicalTarget(projectRoot, entry.absolutePath, entry.path);
  }
  if (journal.phase === "committed") {
    const failures: string[] = [];
    for (const entry of journal.entries) {
      const targetHash = await readOptionalHash(entry.absolutePath);
      if (targetHash !== entry.afterHash) {
        failures.push(
          `${entry.path}: expected committed state '${displayHash(entry.afterHash)}', found '${displayHash(targetHash)}'.`,
        );
      }
    }
    if (failures.length > 0) {
      throw new ProjectTransactionFailure(
        "transaction.committedStateChanged",
        "Committed transaction recovery found missing or externally changed targets; recovery materials were preserved.",
        failures,
      );
    }
    await cleanupCommitted(projectRoot, journal.entries);
    return;
  }
  const failures: string[] = [];
  for (const entry of [...journal.entries].reverse()) {
    try {
      await rollbackPreparedEntry(entry);
      await unlink(entry.temporaryPath).catch(() => undefined);
    } catch (errorValue) {
      failures.push(`${entry.path}: ${formatError(errorValue)}`);
    }
  }
  if (failures.length > 0) {
    throw new ProjectTransactionFailure(
      "transaction.recoveryFailed",
      "An interrupted project transaction requires manual recovery; external bytes were not overwritten.",
      failures,
    );
  }
  await unlink(journalPath);
}

async function cleanupCommitted(projectRoot: string, entries: readonly JournalEntry[]): Promise<void> {
  for (const entry of entries) {
    await unlink(entry.temporaryPath).catch((errorValue) => {
      if (!isNodeError(errorValue, "ENOENT")) throw errorValue;
    });
    await unlink(entry.backupPath).catch((errorValue) => {
      if (!isNodeError(errorValue, "ENOENT")) throw errorValue;
    });
  }
  await unlink(path.join(projectRoot, JOURNAL_FILE_NAME));
}

async function committedTargetsMatch(entries: readonly JournalEntry[]): Promise<boolean> {
  try {
    for (const entry of entries) {
      if (await readOptionalHash(entry.absolutePath) !== entry.afterHash) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function rollbackPreparedEntry(entry: JournalEntry): Promise<void> {
  const backupHash = await readOptionalHash(entry.backupPath);
  const targetHash = await readOptionalHash(entry.absolutePath);
  if (entry.beforeHash === undefined) {
    if (backupHash !== undefined) {
      throw new Error(`Create rollback found unexpected backup hash '${backupHash}'.`);
    }
    if (targetHash === entry.afterHash) {
      await unlink(entry.absolutePath);
    } else if (targetHash !== undefined) {
      throw new Error(`Created target contains external hash '${targetHash}' and was preserved.`);
    }
    if (await readOptionalHash(entry.absolutePath) !== undefined) {
      throw new Error("Created target rollback failed absence verification.");
    }
    return;
  }

  if (backupHash === undefined) {
    if (targetHash === entry.beforeHash) {
      return;
    }
    if (targetHash === undefined || targetHash === entry.afterHash) {
      throw new Error(`Missing rollback source; target hash is '${displayHash(targetHash)}'.`);
    }
    throw new Error(`Target contains an external hash '${targetHash}' and was preserved.`);
  }
  if (backupHash !== entry.beforeHash) {
    throw new Error(`Rollback source hash '${backupHash}' does not match '${entry.beforeHash}'.`);
  }
  if (targetHash === entry.afterHash) {
    if (targetHash !== undefined) {
      await unlink(entry.absolutePath);
    }
    await rename(entry.backupPath, entry.absolutePath);
  } else if (targetHash === undefined) {
    await rename(entry.backupPath, entry.absolutePath);
  } else if (targetHash === entry.beforeHash) {
    await unlink(entry.backupPath);
  } else {
    throw new Error(`Target contains an external hash '${targetHash}' and was preserved.`);
  }
  if (await readOptionalHash(entry.absolutePath) !== entry.beforeHash) {
    throw new Error("Restored source failed hash verification.");
  }
}

async function writeJournal(projectRoot: string, journal: TransactionJournal): Promise<void> {
  const journalPath = path.join(projectRoot, JOURNAL_FILE_NAME);
  const temporaryPath = `${journalPath}.${journal.transactionId}.tmp`;
  try {
    const handle = await open(temporaryPath, "wx");
    try {
      await handle.writeFile(`${JSON.stringify(journal, undefined, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, journalPath);
  } catch (errorValue) {
    await unlink(temporaryPath).catch(() => undefined);
    throw errorValue;
  }
}

function parseJournal(bytes: Buffer, projectRoot: string): TransactionJournal {
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as {
      readonly version?: unknown;
      readonly transactionId?: unknown;
      readonly phase?: unknown;
      readonly entries?: unknown;
    };
    if ((value.version !== 1 && value.version !== 2) || typeof value.transactionId !== "string"
      || !TRANSACTION_ID_PATTERN.test(value.transactionId)
      || (value.phase !== "prepared" && value.phase !== "committed") || !Array.isArray(value.entries)) {
      throw new Error("invalid transaction journal shape");
    }
    const entries: JournalEntry[] = [];
    for (const rawEntry of value.entries) {
      const entry = rawEntry as Partial<JournalEntry>;
      if (typeof entry.path !== "string" || typeof entry.absolutePath !== "string"
        || typeof entry.temporaryPath !== "string" || typeof entry.backupPath !== "string"
        || (entry.beforeHash !== undefined && !isHash(entry.beforeHash))
        || (entry.afterHash !== undefined && !isHash(entry.afterHash))
        || (value.version === 1 && (!isHash(entry.beforeHash) || !isHash(entry.afterHash)))
        || (value.version === 2 && entry.beforeHash === undefined && entry.afterHash === undefined)) {
        throw new Error("invalid transaction journal entry");
      }
      ensureInside(projectRoot, entry.absolutePath, entry.path);
      ensureInside(projectRoot, entry.temporaryPath, entry.path);
      ensureInside(projectRoot, entry.backupPath, entry.path);
      ensureTargetMatchesLogicalPath(projectRoot, entry.path, entry.absolutePath);
      const expectedPrefix = `${entry.absolutePath}.visualbridge-${value.transactionId}`;
      if (entry.temporaryPath !== `${expectedPrefix}.tmp` || entry.backupPath !== `${expectedPrefix}.rollback`) {
        throw new Error("transaction journal paths do not match the transaction identity");
      }
      entries.push({
        path: entry.path,
        absolutePath: entry.absolutePath,
        temporaryPath: entry.temporaryPath,
        backupPath: entry.backupPath,
        ...(entry.beforeHash === undefined ? {} : { beforeHash: entry.beforeHash }),
        ...(entry.afterHash === undefined ? {} : { afterHash: entry.afterHash }),
      });
    }
    if (new Set(entries.map((entry) => pathIdentity(entry.absolutePath))).size !== entries.length) {
      throw new Error("transaction journal contains duplicate targets");
    }
    return { version: 2, transactionId: value.transactionId, phase: value.phase, entries };
  } catch (errorValue) {
    throw new ProjectTransactionFailure(
      "transaction.journalInvalid",
      "The project transaction journal is invalid and was preserved for manual recovery.",
      { cause: formatError(errorValue) },
    );
  }
}

async function acquireProjectLock(projectRoot: string) {
  const lockPath = path.join(projectRoot, LOCK_FILE_NAME);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = randomUUID();
    const temporaryPath = `${lockPath}.${token}.tmp`;
    try {
      const handle = await open(temporaryPath, "wx");
      try {
        await handle.writeFile(`${JSON.stringify({ version: 1, token, pid: process.pid, startedAt: new Date().toISOString() })}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close().catch(() => undefined);
      }
      await link(temporaryPath, lockPath);
      await unlink(temporaryPath).catch(() => undefined);
      return { token, close: async () => unlink(temporaryPath).catch(() => undefined) };
    } catch (errorValue) {
      await unlink(temporaryPath).catch(() => undefined);
      if (!isNodeError(errorValue, "EEXIST")) throw errorValue;
      if (attempt === 0 && await recoverStaleOwnerLock(projectRoot, lockPath)) continue;
      throw new ProjectTransactionConflict("writeInProgress", "Another VisualBridge project transaction is in progress.");
    }
  }
  throw new ProjectTransactionConflict("writeInProgress", "Another VisualBridge project transaction is in progress.");
}

async function recoverStaleOwnerLock(projectRoot: string, lockPath: string): Promise<boolean> {
  if (!await isStaleOwnerFile(lockPath, releasableOwnerTokens)) return false;
  const guard = await acquireRecoveryGuard(projectRoot);
  try {
    if (!await fileExists(lockPath)) return true;
    if (!await isStaleOwnerFile(lockPath, releasableOwnerTokens)) return false;
    const stalePath = `${lockPath}.stale-${randomUUID()}`;
    await rename(lockPath, stalePath);
    await unlink(stalePath).catch(() => undefined);
    return true;
  } finally {
    releasableRecoveryTokens.add(guard.token);
    try {
      await unlink(guard.path);
      releasableRecoveryTokens.delete(guard.token);
    } catch {
      // A completed recovery guard owned by this process is eligible for the next generation.
    }
  }
}

async function acquireRecoveryGuard(projectRoot: string): Promise<{ readonly path: string; readonly token: string }> {
  const directory = path.join(projectRoot, RECOVERY_GUARD_DIRECTORY_NAME);
  await mkdir(directory, { recursive: true });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const entries = (await readdir(directory))
      .map((name) => ({ name, match: recoveryGuardNamePattern.exec(name) }))
      .filter((entry): entry is { readonly name: string; readonly match: RegExpExecArray } => entry.match !== null)
      .sort((left, right) => compareUtf16CodeUnits(left.name, right.name));
    const latest = entries.at(-1);
    if (latest !== undefined) {
      const latestPath = path.join(directory, latest.name);
      if (!await isStaleOwnerFile(latestPath, releasableRecoveryTokens)) {
        throw new ProjectTransactionConflict(
          "writeInProgress",
          "Another VisualBridge transaction recovery is in progress.",
        );
      }
    }
    const generation = latest === undefined ? 1 : Number(latest.match[1]) + 1;
    if (!Number.isSafeInteger(generation) || generation > 999_999_999_999) {
      throw new ProjectTransactionFailure(
        "transaction.recoveryGuardInvalid",
        "The project transaction recovery generation is invalid.",
      );
    }
    const guardPath = path.join(directory, `${String(generation).padStart(12, "0")}.guard`);
    const token = randomUUID();
    try {
      const handle = await open(guardPath, "wx");
      try {
        await handle.writeFile(`${JSON.stringify({ version: 1, token, pid: process.pid, startedAt: new Date().toISOString() })}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close().catch(() => undefined);
      }
      return { path: guardPath, token };
    } catch (errorValue) {
      if (!isNodeError(errorValue, "EEXIST")) {
        await unlink(guardPath).catch(() => undefined);
        throw errorValue;
      }
    }
  }
  throw new ProjectTransactionConflict("writeInProgress", "Another VisualBridge transaction recovery is in progress.");
}

async function isStaleOwnerFile(filePath: string, releasableTokens: ReadonlySet<string>): Promise<boolean> {
  try {
    const value = JSON.parse(await readFile(filePath, "utf8")) as { readonly token?: unknown; readonly pid?: unknown };
    if (typeof value.token !== "string" || typeof value.pid !== "number"
      || !Number.isSafeInteger(value.pid) || value.pid <= 0) {
      return await isOlderThanStaleThreshold(filePath);
    }
    return releasableTokens.has(value.token) || !isProcessAlive(value.pid);
  } catch {
    return await isOlderThanStaleThreshold(filePath);
  }
}

async function isOlderThanStaleThreshold(filePath: string): Promise<boolean> {
  try {
    const fileStat = await stat(filePath);
    return Date.now() - fileStat.mtimeMs >= OWNER_STALE_AFTER_MS;
  } catch {
    return false;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (errorValue) {
    if (isNodeError(errorValue, "ENOENT")) return false;
    throw errorValue;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (errorValue) {
    return !isNodeError(errorValue, "ESRCH");
  }
}

async function releaseOwnedLock(projectRoot: string, token: string): Promise<void> {
  const lockPath = path.join(projectRoot, LOCK_FILE_NAME);
  try {
    const value = JSON.parse(await readFile(lockPath, "utf8")) as { readonly token?: unknown };
    if (value.token === token) await unlink(lockPath);
  } catch (errorValue) {
    if (!isNodeError(errorValue, "ENOENT")) throw errorValue;
  }
}

async function readHash(filePath: string): Promise<string> {
  return hashBytes(await readFile(filePath));
}

async function readOptionalHash(filePath: string): Promise<string | undefined> {
  try {
    return await readHash(filePath);
  } catch (errorValue) {
    if (isNodeError(errorValue, "ENOENT")) return undefined;
    throw errorValue;
  }
}

function ensureInside(root: string, candidate: string, displayPath: string): void {
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ProjectTransactionFailure(
      "transaction.pathOutsideProject",
      `Transaction source '${displayPath}' leaves the project root.`,
    );
  }
}

function ensureTargetMatchesLogicalPath(projectRoot: string, logicalPath: string, absolutePath: string): void {
  if (logicalPath.length === 0 || logicalPath.includes("\\") || logicalPath.includes(":") || logicalPath.startsWith("/")
    || logicalPath.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new ProjectTransactionFailure(
      "transaction.pathInvalid",
      `Transaction source path '${logicalPath}' is not normalized.`,
    );
  }
  const expectedPath = path.resolve(projectRoot, ...logicalPath.split("/"));
  if (path.relative(expectedPath, absolutePath) !== "") {
    throw new ProjectTransactionFailure(
      "transaction.pathMismatch",
      `Transaction source '${logicalPath}' does not match its physical path.`,
    );
  }
}

async function ensurePhysicalTarget(projectRoot: string, absolutePath: string, logicalPath: string): Promise<void> {
  const resolvedRoot = await realpath(projectRoot);
  const resolvedParent = await realpath(path.dirname(absolutePath));
  const resolvedTarget = path.join(resolvedParent, path.basename(absolutePath));
  ensureInside(resolvedRoot, resolvedTarget, logicalPath);
  if (pathIdentity(resolvedTarget) !== pathIdentity(absolutePath)) {
    throw new ProjectTransactionFailure(
      "transaction.pathAlias",
      `Transaction source '${logicalPath}' resolves through a path alias.`,
    );
  }

  let targetEntry: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    targetEntry = await lstat(absolutePath);
  } catch (errorValue) {
    if (!isNodeError(errorValue, "ENOENT")) throw errorValue;
  }
  if (targetEntry === undefined) return;
  if (targetEntry.isSymbolicLink()) {
    throw new ProjectTransactionFailure(
      "transaction.pathAlias",
      `Transaction source '${logicalPath}' resolves through a path alias.`,
    );
  }
  const existingTarget = await realpath(absolutePath);
  if (pathIdentity(existingTarget) !== pathIdentity(absolutePath)) {
    throw new ProjectTransactionFailure(
      "transaction.pathAlias",
      `Transaction source '${logicalPath}' resolves through a path alias.`,
    );
  }
}

function pathIdentity(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function displayHash(value: string | undefined): string {
  return value ?? "missing";
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isNodeError(errorValue: unknown, code: string): errorValue is NodeJS.ErrnoException {
  return errorValue instanceof Error && "code" in errorValue && errorValue.code === code;
}

function formatError(errorValue: unknown): string {
  return errorValue instanceof Error ? errorValue.message : String(errorValue);
}
