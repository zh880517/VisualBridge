/**
 * Locale-independent lexicographic total order over JavaScript UTF-16 code units.
 *
 * This comparator is the protocol authority for canonical serialization, hashes,
 * cursors, plans, paths, and source manifests. Do not replace it with
 * `localeCompare`: locale/ICU collation is not a stable wire-format contract.
 */
export function compareUtf16CodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
