import { createHash } from "node:crypto";
import { VisualBridgeMcpError } from "./projectWorkspace.js";

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}

export function pageItems<T>(
  items: readonly T[],
  cursor: string | undefined,
  limit: number,
  scope: unknown,
  snapshot?: unknown,
): Page<T> {
  const scopeHash = hashScope(scope);
  const snapshotHash = snapshot === undefined ? undefined : hashScope(snapshot);
  const offset = decodeCursor(cursor, scopeHash, snapshotHash);
  if (offset > items.length) {
    throw new VisualBridgeMcpError("cursor.outOfRange", "The pagination cursor is outside the current result set.");
  }
  const page = items.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  return {
    items: page,
    ...(nextOffset < items.length ? { nextCursor: encodeCursor(nextOffset, scopeHash, snapshotHash) } : {}),
  };
}

function decodeCursor(
  cursor: string | undefined,
  scopeHash: string,
  snapshotHash: string | undefined,
): number {
  if (cursor === undefined) {
    return 0;
  }
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid cursor payload");
    const payload = value as {
      readonly version?: unknown;
      readonly offset?: unknown;
      readonly scopeHash?: unknown;
      readonly checksum?: unknown;
    };
    if ((value as { readonly v?: unknown }).v === 2) {
      return decodeSnapshotCursor(value, scopeHash, snapshotHash);
    }
    if (payload.version !== 1 || snapshotHash !== undefined) throw new Error("unsupported cursor version");
    if (payload.scopeHash !== scopeHash) {
      throw new VisualBridgeMcpError(
        "cursor.queryMismatch",
        "The pagination cursor does not belong to this query.",
      );
    }
    const offset = payload.offset;
    if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) {
      throw new Error("invalid cursor offset");
    }
    if (payload.checksum !== cursorChecksum(offset, scopeHash)) throw new Error("invalid cursor checksum");
    return offset;
  } catch (errorValue) {
    if (errorValue instanceof VisualBridgeMcpError) throw errorValue;
    throw new VisualBridgeMcpError("cursor.invalid", "The pagination cursor is invalid.");
  }
}

function encodeCursor(offset: number, scopeHash: string, snapshotHash: string | undefined): string {
  if (snapshotHash !== undefined) {
    const queryHash = compactHash(scopeHash);
    const currentSnapshotHash = compactHash(snapshotHash);
    return Buffer.from(JSON.stringify({
      v: 2,
      o: offset,
      q: queryHash,
      s: currentSnapshotHash,
      c: snapshotCursorChecksum(offset, queryHash, currentSnapshotHash),
    }), "utf8").toString("base64url");
  }
  return Buffer.from(JSON.stringify({
    version: 1,
    offset,
    scopeHash,
    checksum: cursorChecksum(offset, scopeHash),
  }), "utf8").toString("base64url");
}

function decodeSnapshotCursor(
  value: object,
  scopeHash: string,
  snapshotHash: string | undefined,
): number {
  const payload = value as {
    readonly v?: unknown;
    readonly o?: unknown;
    readonly q?: unknown;
    readonly s?: unknown;
    readonly c?: unknown;
  };
  if (payload.v !== 2 || snapshotHash === undefined) throw new Error("invalid snapshot cursor payload");
  const queryHash = compactHash(scopeHash);
  if (payload.q !== queryHash) {
    throw new VisualBridgeMcpError(
      "cursor.queryMismatch",
      "The pagination cursor does not belong to this query.",
    );
  }
  const currentSnapshotHash = compactHash(snapshotHash);
  if (payload.s !== currentSnapshotHash) {
    throw new VisualBridgeMcpError(
      "cursor.snapshotChanged",
      "The paginated data snapshot changed; restart the query without a cursor.",
    );
  }
  const offset = payload.o;
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0
    || payload.c !== snapshotCursorChecksum(offset, queryHash, currentSnapshotHash)) {
    throw new Error("invalid snapshot cursor checksum");
  }
  return offset;
}

function cursorChecksum(offset: number, scopeHash: string): string {
  return createHash("sha256").update(`visualbridge-cursor-v1\0${offset}\0${scopeHash}`).digest("hex");
}

function snapshotCursorChecksum(offset: number, queryHash: string, snapshotHash: string): string {
  return createHash("sha256")
    .update(`visualbridge-cursor-v2\0${offset}\0${queryHash}\0${snapshotHash}`)
    .digest("hex")
    .slice(0, 16);
}

function compactHash(value: string): string {
  return value.slice(0, 32);
}

function hashScope(scope: unknown): string {
  return createHash("sha256").update(JSON.stringify(sortJson(scope))).digest("hex");
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJson(entry)]));
  }
  return value;
}
