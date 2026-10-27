export function joinClassNames(...values: readonly (string | undefined)[]): string {
  return values.filter((value): value is string => value !== undefined && value.length > 0).join(" ");
}

export function appendClassName(base: string, extra: string | undefined): string {
  return extra === undefined ? base : `${base} ${extra}`;
}

export type SaveStateKind = "pending" | "dirty" | "saved";

export const DEFAULT_SAVE_STATE_LABELS: Readonly<Record<SaveStateKind, string>> = {
  pending: "正在应用…",
  dirty: "未保存",
  saved: "已保存",
};

export function resolveSaveStateKind(dirty: boolean, pending: boolean): SaveStateKind {
  return pending ? "pending" : dirty ? "dirty" : "saved";
}
