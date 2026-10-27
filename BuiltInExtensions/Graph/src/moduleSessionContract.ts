/**
 * 会话控制器契约：**唯一**定义在 Core（`Core/Document/moduleSession.ts`），此处只转出。
 *
 * 收口前四个领域包各持一份字节相同的副本；C1 把它们合并到 Core，避免宿主与模块对着
 * 两份会各自漂移的声明做检查。只用显式名单，不用 `export type *`：后者会把 Core 的
 * `JsonValue` 等一并带进来，与领域包自己的同名导出冲突。
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
