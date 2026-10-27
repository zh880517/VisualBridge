/**
 * SDK 与 Core 的契约一致性自检（**编译期**，无运行时代码）。
 *
 * SDK 用 `export type *` 让 Core 的公开类型流出；一旦有人在 SDK 里重新声明同名类型，
 * 它会**遮蔽** Core 的版本，模块作者就会对着错形状做类型检查（A2 的 2 参 `McpFacet`
 * 就是这么和 B4 的 4 参实现分叉的）。这里把"SDK 暴露的就是 Core 的那一个"钉死：
 * 任一侧分叉都会让 `npm run check` 直接报 TS2322 / TS2345。
 *
 * 该文件不参与打包（`tsconfig.json` 只 include `src/`），只由 `tsconfig.typecheck.json` 检查。
 */

import type {
  CatalogFacet as CoreCatalogFacet,
  CreateFacet as CoreCreateFacet,
  ModuleSessionController as CoreModuleSessionController,
  ModuleSessionFactory as CoreModuleSessionFactory,
  CatalogWithSource,
  DocumentFacet as CoreDocumentFacet,
  McpFacet as CoreMcpFacet,
} from "@visualbridge/core";
import type {
  CatalogFacet as SdkCatalogFacet,
  CreateFacet as SdkCreateFacet,
  EditorRegistration as SdkEditorRegistration,
  ModuleSessionController as SdkModuleSessionController,
  ModuleSessionFactory as SdkModuleSessionFactory,
  DocumentFacet as SdkDocumentFacet,
  McpFacet as SdkMcpFacet,
} from "../src/index";

/** 类型恒等（比双向赋值更紧：能区分 `readonly` 或可选性差异）。 */
type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends (<Value>() => Value extends Right ? 1 : 2)
    ? true
    : false;

interface ParityRegistry {
  readonly graphTypes: readonly string[];
}

declare const sdkMcp: SdkMcpFacet<string, ParityRegistry>;
declare const coreMcp: CoreMcpFacet<string, ParityRegistry>;

// 双向赋值：任何一侧多一个必填成员、改一个参数形态都会在这里报错。
export const mcpSdkAssignableToCore: CoreMcpFacet<string, ParityRegistry> = sdkMcp;
export const mcpCoreAssignableToSdk: SdkMcpFacet<string, ParityRegistry> = coreMcp;
export const mcpIsExactlyCore: Equal<SdkMcpFacet<string, ParityRegistry>, CoreMcpFacet<string, ParityRegistry>> = true;

declare const sdkFacet: SdkDocumentFacet<string, ParityRegistry>;
declare const coreFacet: CoreDocumentFacet<string, ParityRegistry>;

export const facetSdkAssignableToCore: CoreDocumentFacet<string, ParityRegistry> = sdkFacet;
export const facetCoreAssignableToSdk: SdkDocumentFacet<string, ParityRegistry> = coreFacet;
export const facetIsExactlyCore: Equal<
  SdkDocumentFacet<string, ParityRegistry>,
  CoreDocumentFacet<string, ParityRegistry>
> = true;

declare const sdkCatalog: SdkCatalogFacet<CatalogWithSource, ParityRegistry>;
declare const coreCatalog: CoreCatalogFacet<CatalogWithSource, ParityRegistry>;

export const catalogSdkAssignableToCore: CoreCatalogFacet<CatalogWithSource, ParityRegistry> = sdkCatalog;
export const catalogCoreAssignableToSdk: SdkCatalogFacet<CatalogWithSource, ParityRegistry> = coreCatalog;
export const catalogIsExactlyCore: Equal<
  SdkCatalogFacet<CatalogWithSource, ParityRegistry>,
  CoreCatalogFacet<CatalogWithSource, ParityRegistry>
> = true;
declare const sdkCreate: SdkCreateFacet;
declare const coreCreate: CoreCreateFacet;
export const createSdkAssignableToCore: CoreCreateFacet = sdkCreate;
export const createCoreAssignableToSdk: SdkCreateFacet = coreCreate;
export const createIsExactlyCore: Equal<SdkCreateFacet, CoreCreateFacet> = true;

declare const sdkSession: SdkModuleSessionController;
declare const coreSession: CoreModuleSessionController;
export const sessionIsExactlyCore: Equal<SdkModuleSessionController, CoreModuleSessionController> = true;
export const sessionSdkAssignableToCore: CoreModuleSessionController = sdkSession;
export const sessionCoreAssignableToSdk: SdkModuleSessionController = coreSession;
declare const sdkFactory: SdkModuleSessionFactory;
declare const coreFactory: CoreModuleSessionFactory;
export const sessionFactorySdkAssignableToCore: CoreModuleSessionFactory = sdkFactory;
export const sessionFactoryCoreAssignableToSdk: SdkModuleSessionFactory = coreFactory;
export const sessionFactoryIsExactlyCore: Equal<SdkModuleSessionFactory, CoreModuleSessionFactory> = true;

/**
 * X1 回归：`EditorRegistration.session` 必须是**必填**（附录 D.1.1 / D.3，HEAD 的严格形状）。
 *
 * loader 运行期本来就拒绝缺 `session` 的注册面，但 SDK 把它写成 `?` 会让模块作者在
 * 编译期蒙混过关。这里从两个角度钉死：缺 `session` 的注册面不可赋值；成员类型不含
 * `undefined`。把 `?` 加回来时第一条变成 TS2578（未使用的 @ts-expect-error）、第二条
 * 变成 TS2322，`npm run check` 必红。
 */
declare const registrationWithoutSession: Omit<SdkEditorRegistration, "session">;
// @ts-expect-error session 必填：缺 session 的注册面不得赋值给 EditorRegistration。
export const registrationRequiresSession: SdkEditorRegistration = registrationWithoutSession;
export const sessionMemberIsExactlyFactory: Equal<SdkEditorRegistration["session"], SdkModuleSessionFactory> = true;
