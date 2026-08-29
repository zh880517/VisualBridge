import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { DocumentDiagnostic } from "@visualbridge/core";
import { VisualBridgeMcpError } from "./projectWorkspace.js";
import {
  ProjectTransactionConflict,
  ProjectTransactionFailure,
  type ProjectTransactionCommitResult,
  withProjectTransaction,
} from "./projectTransaction.js";

export interface AtomicTextFileOptions {
  readonly projectRoot: string;
  readonly absolutePath: string;
  readonly resolveAbsolutePath?: () => Promise<string>;
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
  try {
    return await withProjectTransaction(options.projectRoot, async (transaction) => {
      const absolutePath = options.resolveAbsolutePath === undefined
        ? options.absolutePath
        : await options.resolveAbsolutePath();
      const bytes = await readFile(absolutePath);
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
      let maintenance: ProjectTransactionCommitResult["maintenance"];
      try {
        maintenance = (await transaction.commit([{
          path: String(options.metadata.path ?? options.absolutePath),
          absolutePath,
          before: bytes,
          after: nextBytes,
        }])).maintenance;
      } catch (errorValue) {
        if (errorValue instanceof ProjectTransactionConflict) {
          return conflict(
            options,
            await readCurrentHash(absolutePath),
            errorValue.reason === "baseHashMismatch" ? "changedBeforeReplace" : errorValue.reason,
          );
        }
        throw errorValue;
      }
      return {
        status: "applied",
        ...options.metadata,
        baseHash: actualHash,
        hash: nextHash,
        diagnostics: decision.diagnostics,
        ...(maintenance === undefined ? {} : { maintenance }),
      };
    });
  } catch (errorValue) {
    if (errorValue instanceof ProjectTransactionConflict) {
      return conflict(options, undefined, errorValue.reason);
    }
    if (errorValue instanceof ProjectTransactionFailure) {
      throw new VisualBridgeMcpError(
        errorValue.code === "transaction.verificationFailed"
          ? options.verificationErrorCode
          : errorValue.code,
        errorValue.message,
        errorValue.details,
      );
    }
    throw errorValue;
  }
}

export function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function conflict(
  options: AtomicTextFileOptions,
  actualHash: string | undefined,
  reason: "writeInProgress" | "baseHashMismatch" | "dependencyChanged" | "changedBeforeReplace",
): Record<string, unknown> {
  return {
    status: "conflict",
    reason,
    ...options.metadata,
    expectedBaseHash: options.expectedBaseHash,
    ...(actualHash === undefined ? {} : { actualHash }),
  };
}

async function readCurrentHash(filePath: string): Promise<string | undefined> {
  try {
    return hashBytes(await readFile(filePath));
  } catch {
    return undefined;
  }
}
