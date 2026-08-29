import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import type { DocumentDiagnostic } from "@visualbridge/core";
import { VisualBridgeMcpError } from "./projectWorkspace.js";

export interface AtomicTextFileOptions {
  readonly absolutePath: string;
  readonly expectedBaseHash: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly verificationErrorCode: string;
  readonly subject: string;
}

export type AtomicTextFileDecision =
  | { readonly valid: false; readonly diagnostics: readonly DocumentDiagnostic[] }
  | {
      readonly valid: true;
      readonly nextBytes: Uint8Array;
      readonly diagnostics: readonly DocumentDiagnostic[];
    };

export async function applyAtomicTextFileEdit(
  options: AtomicTextFileOptions,
  transform: (bytes: Buffer, baseHash: string) => Promise<AtomicTextFileDecision>,
): Promise<Record<string, unknown>> {
  const lockPath = path.join(
    path.dirname(options.absolutePath),
    `.${path.basename(options.absolutePath)}.visualbridge.lock`,
  );
  let lockHandle;
  try {
    lockHandle = await open(lockPath, "wx");
    await lockHandle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, "utf8");
    await lockHandle.sync();
  } catch (errorValue) {
    if (isNodeError(errorValue, "EEXIST")) {
      return conflict(options, hashBytes(await readFile(options.absolutePath)), "writeInProgress");
    }
    if (lockHandle !== undefined) {
      await lockHandle.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
    }
    throw errorValue;
  }

  let temporaryPath: string | undefined;
  try {
    const bytes = await readFile(options.absolutePath);
    const actualHash = hashBytes(bytes);
    if (actualHash !== options.expectedBaseHash) {
      return conflict(options, actualHash, "baseHashMismatch");
    }
    const decision = await transform(bytes, actualHash);
    if (!decision.valid) {
      return {
        status: "invalid",
        ...options.metadata,
        baseHash: actualHash,
        diagnostics: decision.diagnostics,
      };
    }

    const nextBytes = Buffer.from(decision.nextBytes);
    const nextHash = hashBytes(nextBytes);
    if (nextHash === actualHash && nextBytes.equals(bytes)) {
      return {
        status: "unchanged",
        ...options.metadata,
        baseHash: actualHash,
        hash: actualHash,
        diagnostics: decision.diagnostics,
      };
    }
    temporaryPath = path.join(
      path.dirname(options.absolutePath),
      `.${path.basename(options.absolutePath)}.visualbridge-${randomUUID()}.tmp`,
    );
    const targetStat = await stat(options.absolutePath);
    const temporaryHandle = await open(temporaryPath, "wx", targetStat.mode);
    try {
      await temporaryHandle.writeFile(nextBytes);
      await temporaryHandle.sync();
    } finally {
      await temporaryHandle.close();
    }
    const beforeReplaceHash = hashBytes(await readFile(options.absolutePath));
    if (beforeReplaceHash !== actualHash) {
      return conflict(options, beforeReplaceHash, "changedBeforeReplace");
    }
    await rename(temporaryPath, options.absolutePath);
    temporaryPath = undefined;
    const persistedHash = hashBytes(await readFile(options.absolutePath));
    if (persistedHash !== nextHash) {
      throw new VisualBridgeMcpError(
        options.verificationErrorCode,
        `${options.subject} did not match the serialized transaction after atomic replacement.`,
      );
    }
    return {
      status: "applied",
      ...options.metadata,
      baseHash: actualHash,
      hash: nextHash,
      diagnostics: decision.diagnostics,
    };
  } finally {
    if (temporaryPath !== undefined) {
      await unlink(temporaryPath).catch(() => undefined);
    }
    if (lockHandle !== undefined) {
      await lockHandle.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
    }
  }
}

export function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function conflict(
  options: AtomicTextFileOptions,
  actualHash: string,
  reason: "writeInProgress" | "baseHashMismatch" | "changedBeforeReplace",
): Record<string, unknown> {
  return {
    status: "conflict",
    reason,
    ...options.metadata,
    expectedBaseHash: options.expectedBaseHash,
    actualHash,
  };
}

function isNodeError(errorValue: unknown, code: string): boolean {
  return errorValue instanceof Error && "code" in errorValue && errorValue.code === code;
}
