export * from "./src/entityCatalog";
export * from "./src/entityDocument";
export * from "./src/entityDocumentAdapter";
export * from "./src/entityLifecycle";
export * from "./src/entityReferences";
export * from "./src/entitySession";
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
export * from "./src/entityCatalogFacet";
export * from "./src/entityCreateFacet";
export * from "./src/entityDocumentFacet";
export * from "./src/entityMcpFacet";
export * from "./src/entityOperationSchema";
