export * from "./src/structuredCatalog";
export * from "./src/structuredDocument";
export * from "./src/structuredDocumentAdapter";
export * from "./src/structuredLifecycle";
export * from "./src/structuredSession";
/** 会话契约的唯一定义在 Core（经 SDK 流出）：这里只做显式转出，不另存一份声明。 */
export type {
  ModuleSessionApplyOperation,
  ModuleSessionCatalog,
  ModuleSessionController,
  ModuleSessionDocument,
  ModuleSessionEffect,
  ModuleSessionHost,
  ModuleSessionMessage,
  ModuleSessionSource,
  ModuleSessionStateEvent,
  ModuleSourceFile,
  ModuleSourcesContext,
  ModuleSourcesKeyRenamePlan,
  ModuleSourcesParseResult,
  ModuleSourcesSessionController,
  ModuleSourcesStorage,
  ModuleTextCodec,
} from "@visualbridge/module-sdk";
export * from "./src/structuredCatalogFacet";
export * from "./src/structuredCreateFacet";
export * from "./src/structuredDocumentFacet";
export * from "./src/structuredMcpFacet";
export * from "./src/structuredOperationSchema";
