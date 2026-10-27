/**
 * Table 稳定键改名的纯校验。
 *
 * 宿主不再知道 key column 与"重复键"的含义：Table facet 用这份校验把损坏/过期/冲突的
 * 改名请求映射成 `table.key*` 诊断。
 */
import { referenceValuesEqual } from "@visualbridge/core";

export interface TableKeyRenameInput {
  readonly keyColumnId: string | undefined;
  /** 当前单元格原始值；非 string/number 视为过期。 */
  readonly currentValue: unknown;
  readonly oldValue: string | number;
  readonly newValue: string | number;
  readonly duplicateExists: boolean;
}

export type TableKeyRenameCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string; readonly message: string };

export function checkTableKeyRename(input: TableKeyRenameInput): TableKeyRenameCheck {
  if (input.keyColumnId === undefined) {
    return {
      ok: false,
      code: "table.keyUnavailable",
      message: "The target Table row or key column no longer exists.",
    };
  }
  if (!referenceValuesEqual(input.currentValue as string | number, input.oldValue)) {
    return {
      ok: false,
      code: "table.keyChanged",
      message: "The target Table key changed after the refactor preview was created.",
    };
  }
  if (input.duplicateExists) {
    return {
      ok: false,
      code: "table.keyDuplicate",
      message: `Table key '${String(input.newValue)}' already exists in a physical row.`,
    };
  }
  return { ok: true };
}
