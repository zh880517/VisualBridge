/**
 * 旧 Table 编辑器入口（B2 薄封装）。
 *
 * 领域逻辑已搬到 `../document/moduleSourcesEditorProvider.ts`（宿主骨架 + `storage: "sources"`）
 * 与 `Modules/Table/src/tableSession.ts`（领域控制器）。这里只保留旧导出名，
 * 让 `extension.ts` / 生命周期 / 重构服务 / 命令 / 未保存文档树无需在 B2 里改签名；
 * C1 搬到模块驱动后连同本文件一起删除。
 */
export {
  SOURCES_EDITOR_VIEW_TYPE as TABLE_EDITOR_VIEW_TYPE,
  ModuleSourcesCustomDocument as TableCustomDocument,
  ModuleSourcesEditorProvider as TableEditorProvider,
} from "../document/moduleSourcesEditorProvider";
