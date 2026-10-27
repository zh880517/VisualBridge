/**
 * 已打开文档贡献的引用数据在语义快照之上的"当前覆盖"选择（纯函数，宿主与单测共用）。
 *
 * 同一逻辑文档可能被多个来源各自登记一次（多源 CustomDocument 的每个物理成员都会调用
 * `updateModuleDocument`）。覆盖必须按 (documentTypeId, sourcePaths 有交集) 去重、只留最新
 * sequence 的一份，否则引用检索与 Quick Pick 会给出重复候选。
 */
export interface OpenDocumentReferenceEntry {
  readonly documentTypeId: string;
  readonly sourcePaths: ReadonlySet<string>;
  readonly sequence: number;
}

/** 保留每个逻辑文档最新的覆盖项；sequence 越大越新。 */
export function selectCurrentOverrides<T extends OpenDocumentReferenceEntry>(
  entries: readonly T[],
): readonly T[] {
  const selected: T[] = [];
  for (const entry of [...entries].sort((left, right) => right.sequence - left.sequence)) {
    if (!selected.some((current) => (
      current.documentTypeId === entry.documentTypeId
      && [...entry.sourcePaths].some((path) => current.sourcePaths.has(path))
    ))) {
      selected.push(entry);
    }
  }
  return selected;
}
