import { compareUtf16CodeUnits } from "./ordinal";

/**
 * Serializes JSON data with object keys ordered by UTF-16 code units at every depth.
 *
 * Primitive encoding, string escaping, array order, and omission of `undefined`
 * object properties match `JSON.stringify`. Values that cannot be represented as
 * JSON are rejected instead of being silently coerced.
 */
export function canonicalJsonStringify(value: unknown): string {
  return serialize(value, "$", new Set<object>());
}

function serialize(value: unknown, path: string, ancestors: Set<object>): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw unsupported(path, "a non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw unsupported(path, typeof value);
  if (ancestors.has(value)) throw new TypeError(`Canonical JSON cannot contain a cycle at ${path}.`);

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const entries: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw unsupported(`${path}[${index}]`, "an array hole");
        entries.push(serialize(value[index], `${path}[${index}]`, ancestors));
      }
      return `[${entries.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw unsupported(path, "a non-plain object");
    }
    const record = value as Readonly<Record<string, unknown>>;
    const entries: string[] = [];
    for (const key of Object.keys(record).sort(compareUtf16CodeUnits)) {
      const entry = record[key];
      if (entry === undefined) continue;
      entries.push(`${JSON.stringify(key)}:${serialize(entry, `${path}.${key}`, ancestors)}`);
    }
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function unsupported(path: string, description: string): TypeError {
  return new TypeError(`Canonical JSON cannot serialize ${description} at ${path}.`);
}
