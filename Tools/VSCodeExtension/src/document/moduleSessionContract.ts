/**
 * 会话控制器契约：**唯一**定义在 Core（`Core/Document/moduleSession.ts`），此处只转出。
 *
 * 扩展是宿主、不是模块作者，因此直接取 `@visualbridge/core`，不引入 Module SDK。
 */
export type {
  ModuleSessionMessage,
  ModuleSessionSource,
  ModuleSessionDocument,
  ModuleSessionCatalog,
  ModuleSessionStateEvent,
  ModuleSessionHost,
  ModuleSessionApplyOperation,
  ModuleSessionEffect,
  ModuleSessionController,
  ModuleTextCodec,
  ModuleSourceFile,
  ModuleSourcesContext,
  ModuleSourcesParseResult,
  ModuleSourcesStorage,
  ModuleSourcesKeyRenamePlan,
  ModuleSourcesSessionController,
} from "@visualbridge/core";
