// 元素级删除守卫已整体移除：文件内的编辑操作（组件、节点、接口端口、
// 动态端口、表格行删除）都是普通单文件 Operation，不依赖引用方文件的
// 保存状态；悬空引用由持有方文档的 Reference 校验兜底，同文档悬空引用
// 在删除路径被原子拒绝。Lifecycle 仅保留给整文档级操作与显式调用方。

const REFACTOR_GUARDED_OPERATION_TYPES: Readonly<Record<string, ReadonlySet<string>>> = {
  entity: new Set(["entity.renameComponent"]),
  graph: new Set(["graph.renameElement"]),
};

export function containsReferenceRefactorGuardedRename(editor: string, operations: unknown): boolean {
  const guarded = REFACTOR_GUARDED_OPERATION_TYPES[editor];
  return guarded !== undefined
    && Array.isArray(operations)
    && operations.some((operation) => (
      typeof operation === "object"
      && operation !== null
      && !Array.isArray(operation)
      && guarded.has((operation as { readonly type?: unknown }).type as string)
    ));
}

export const REFERENCE_REFACTOR_REQUIRED_MESSAGE =
  "refactor.required: Stable identity renames must use Reference Refactor preview/apply.";
