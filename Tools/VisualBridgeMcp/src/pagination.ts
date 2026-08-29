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
): Page<T> {
  const scopeHash = hashScope(scope);
  const offset = decodeCursor(cursor, scopeHash);
  if (offset > items.length) {
    throw new VisualBridgeMcpError("cursor.outOfRange", "The pagination cursor is outside the current result set.");
  }
  const page = items.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  return {
    items: page,
    ...(nextOffset < items.length ? { nextCursor: encodeCursor(nextOffset, scopeHash) } : {}),
  };
}

function decodeCursor(cursor: string | undefined, scopeHash: string): number {
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
    if (payload.version !== 1) throw new Error("unsupported cursor version");
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

function encodeCursor(offset: number, scopeHash: string): string {
  return Buffer.from(JSON.stringify({
    version: 1,
    offset,
    scopeHash,
    checksum: cursorChecksum(offset, scopeHash),
  }), "utf8").toString("base64url");
}

function cursorChecksum(offset: number, scopeHash: string): string {
  return createHash("sha256").update(`visualbridge-cursor-v1\0${offset}\0${scopeHash}`).digest("hex");
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
