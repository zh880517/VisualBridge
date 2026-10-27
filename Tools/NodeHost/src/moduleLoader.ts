/**
 * 模块装载器。
 *
 * 装载流程（附录 D.2）：路径规范化与别名检查 → 读字节并计算 SHA-256 →
 * `vm.compileFunction(code, ["module","exports","require"], { filename })` →
 * manifest 校验 → `activate` → registration / options / editor 冲突校验。
 *
 * 这不是沙箱：模块与宿主同权限、同进程。装载器只保证 `require` 仅放行 Node
 * 内置模块；`process`、`global` 与动态 `import()` 仍按 Node 语义可用。
 */

import { createHash } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { isBuiltin } from "node:module";
import path from "node:path";
import { compileFunction } from "node:vm";
import {
  PROJECT_MODULE_ENTRY_SUFFIX,
  PROJECT_MODULE_HASH_PATTERN,
  isJsonValue,
  type JsonValue,
  type ProjectModuleDefinition,
} from "@visualbridge/core";

/** 模块契约版本；宿主只接受 `manifest.apiVersion` 等于该值的 bundle。 */
export const MODULE_API_VERSION = 1;

/** 附录 D.2 的 `module.*` 错误码全集。 */
export const MODULE_ERROR_CODES = [
  "module.invalidPath",
  "module.entryAlias",
  "module.notFound",
  "module.hashMismatch",
  "module.loadFailed",
  "module.manifestInvalid",
  "module.idMismatch",
  "module.apiVersionMismatch",
  "module.activateFailed",
  "module.registrationInvalid",
  "module.editorConflict",
  "module.referenceKindConflict",
  "module.optionsInvalid",
  "module.untrusted",
  "module.disabled",
  "module.callFailed",
] as const;

export type ModuleErrorCode = (typeof MODULE_ERROR_CODES)[number];

/** `module.sdkVersionMismatch` 只产生 warning 诊断，不属于 D.2 的错误码门禁集合。 */
export type ModuleDiagnosticCode = ModuleErrorCode | "module.sdkVersionMismatch";

export type ModuleStatus = "loaded" | "failed" | "untrusted" | "disabled" | "stale";

export type ModuleLogLevel = "debug" | "info" | "warning" | "error";

export type JsonObject = Readonly<Record<string, JsonValue>>;

export interface ModuleDiagnostic {
  readonly code: ModuleDiagnosticCode;
  readonly severity: "error" | "warning";
  readonly message: string;
  readonly path: string;
}

export interface ModuleManifest {
  readonly id: string;
  readonly version: string;
  readonly apiVersion: number;
  /** 只用于诊断，不参与门禁。 */
  readonly sdkVersion?: string;
  readonly editors: readonly string[];
}

export interface ModuleWebview {
  readonly script: string;
  readonly style: string;
}

/** Project File `modules[]` 条目在装载层的形状；复用 Core 的契约定义。 */
export type ModuleDefinition = ProjectModuleDefinition;

export interface ModuleLoaderOptions {
  readonly projectRoot: string;
  readonly projectId: string;
  readonly modules: readonly ModuleDefinition[];
  /**
   * 宿主授予的模块信任状态。A2 不接入信任模型，默认 false（fail-closed）；
   * B1 必须按 Workspace Trust / `VISUALBRIDGE_MODULES_ENABLED` 显式传入。
   */
  readonly trusted?: boolean;
  readonly disabledModuleIds?: readonly string[];
  /** 宿主支持的 SDK 版本；仅用于诊断 `manifest.sdkVersion`。 */
  readonly sdkVersion?: string;
  /**
   * 宿主提供的完整 HostApi（log、Project 视图、Catalog/Reference 查询）。
   * 省略时装载器只提供 `log`，供 A2 fixture 与最小自测使用；B1 必须注入真实宿主。
   */
  readonly createHost?: (context: ModuleHostContext) => ModuleLoaderHost;
  readonly log?: (entry: ModuleLoaderLogEntry) => void;
}

export interface ModuleHostContext {
  readonly moduleId: string;
  readonly entry: string;
  readonly manifest: ModuleManifest;
  readonly options: JsonObject | undefined;
}

/** 装载器交给 `activate` 的最小宿主面；完整 HostApi 由 B1 注入。 */
export interface ModuleLoaderHost {
  readonly log: ModuleLogFunction;
}

export type ModuleLogFunction = (
  level: ModuleLogLevel,
  message: string,
  details?: JsonValue,
) => void;

export interface ModuleLoaderLogEntry {
  readonly timestamp: string;
  readonly level: ModuleLogLevel;
  readonly event: string;
  readonly projectId: string;
  readonly moduleId?: string;
  readonly message?: string;
  readonly details?: JsonValue;
}

export interface LoadedModule<TRegistration = unknown> {
  readonly id: string;
  readonly entry: string;
  readonly status: ModuleStatus;
  readonly diagnostics: readonly ModuleDiagnostic[];
  readonly manifest?: ModuleManifest;
  readonly registration?: TRegistration;
  readonly webviews: Readonly<Record<string, ModuleWebview>>;
  /** 实际字节的 `sha256:<hex>`；未成功读取时为 undefined。 */
  readonly hash?: string;
  readonly declaredHash?: string;
}

export interface ModuleLoadResult<TRegistration = unknown> {
  readonly projectId: string;
  readonly projectRoot: string;
  readonly modules: readonly LoadedModule<TRegistration>[];
  /** editor id → 首个成功注册该 editor 的模块。 */
  readonly editors: ReadonlyMap<string, LoadedModule<TRegistration>>;
  /** Reference kind → 首个成功注册该 kind 的模块 id。 */
  readonly referenceKinds: ReadonlyMap<string, string>;
  /** 调试分类 → 首个成功注册该分类的模块 id。 */
  readonly debugCategories: ReadonlyMap<string, string>;
  readonly diagnostics: readonly ModuleDiagnostic[];
}

export class ModuleLoaderError extends Error {
  public readonly code: ModuleErrorCode;
  public readonly pathSuffix: string | undefined;

  public constructor(
    code: ModuleErrorCode,
    message: string,
    options?: { readonly cause?: unknown; readonly pathSuffix?: string },
  ) {
    super(message, options);
    this.name = "ModuleLoaderError";
    this.code = code;
    this.pathSuffix = options?.pathSuffix;
  }
}

interface ClaimTables {
  readonly editors: Map<string, string>;
  readonly referenceKinds: Map<string, string>;
  readonly debugCategories: Map<string, string>;
}

interface ValidatedEditorRegistration {
  readonly editor: string;
  readonly webview: string;
  readonly webviewTitle: string;
  readonly references: readonly { readonly kind: string }[];
  readonly debug?: {
    readonly categories: readonly string[];
    readonly windowTitle?: string;
  };
  readonly [key: string]: unknown;
}

interface ValidatedRegistration {
  readonly editors: readonly ValidatedEditorRegistration[];
  readonly validateOptions?: (options: JsonObject | undefined) => unknown;
  readonly dispose?: () => unknown;
  readonly [key: string]: unknown;
}

interface ModuleState {
  readonly definition: ModuleDefinition;
  readonly index: number;
  status: ModuleStatus;
  diagnostics: ModuleDiagnostic[];
  manifest: ModuleManifest | undefined;
  registration: ValidatedRegistration | undefined;
  webviews: Readonly<Record<string, ModuleWebview>>;
  entryPath: string | undefined;
  hash: string | undefined;
  disposed: boolean;
}

export class ModuleLoader<TRegistration = unknown> {
  private readonly options: ModuleLoaderOptions;
  private readonly projectRoot: string;
  private readonly trusted: boolean;
  private readonly disabledModuleIds: ReadonlySet<string>;
  private states: readonly ModuleState[] = [];
  private claims: ClaimTables = emptyClaims();
  private resultValue: ModuleLoadResult<TRegistration>;
  private projectId: string;
  private disposed = false;

  private constructor(options: ModuleLoaderOptions, projectRoot: string) {
    this.options = options;
    this.projectRoot = projectRoot;
    this.projectId = options.projectId;
    this.trusted = options.trusted ?? false;
    this.disabledModuleIds = new Set(options.disabledModuleIds ?? []);
    this.resultValue = this.buildResult();
  }

  /** 解析 Project Root 并装载全部模块。 */
  public static async create<TRegistration = unknown>(
    options: ModuleLoaderOptions,
  ): Promise<ModuleLoader<TRegistration>> {
    const projectRoot = await resolveProjectRoot(options.projectRoot);
    const loader = new ModuleLoader<TRegistration>(options, projectRoot);
    await loader.reload(options.modules, options.projectId);
    return loader;
  }

  public get result(): ModuleLoadResult<TRegistration> {
    return this.resultValue;
  }

  /**
   * 按新的模块定义重新装载。
   *
   * 定义变化时先对旧模块调用 `registration.dispose()`，再执行完整装载流程。
   */
  public async reload(
    modules: readonly ModuleDefinition[],
    projectId: string = this.projectId,
  ): Promise<ModuleLoadResult<TRegistration>> {
    if (this.disposed) {
      throw new ModuleLoaderError("module.loadFailed", "Module loader has been disposed.");
    }
    this.disposeRegistrations();
    this.states = [];
    this.claims = emptyClaims();
    this.projectId = projectId;

    const claims = this.claims;
    const seenIds = new Set<string>();
    const states: ModuleState[] = [];
    for (const [index, definition] of modules.entries()) {
      if (seenIds.has(definition.id)) {
        const state = createState(definition, index);
        state.status = "failed";
        state.diagnostics.push(diagnostic(
          "module.idMismatch",
          `Project declares module id '${definition.id}' more than once.`,
          modulePath(index),
        ));
        states.push(state);
        continue;
      }
      seenIds.add(definition.id);
      states.push(await this.loadOne(definition, index, claims));
    }
    this.states = states;
    this.resultValue = this.buildResult();
    return this.resultValue;
  }

  /**
   * 重新读取每个已装载模块的字节；实际 hash 变化时把状态标为 `stale`。
   *
   * 本方法不自动 dispose 或重载，宿主决定何时调用 `reload`。
   */
  public async refreshStale(): Promise<ModuleLoadResult<TRegistration>> {
    if (this.disposed) {
      throw new ModuleLoaderError("module.loadFailed", "Module loader has been disposed.");
    }
    for (const state of this.states) {
      if (state.status !== "loaded" && state.status !== "stale") continue;
      if (state.entryPath === undefined || state.hash === undefined) continue;
      let bytes: Buffer;
      try {
        bytes = await readFile(state.entryPath);
      } catch (errorValue) {
        state.status = "stale";
        addDiagnosticOnce(state.diagnostics, diagnostic(
          "module.notFound",
          `Module entry '${state.definition.entry}' became unavailable: ${describeError(errorValue)}.`,
          `${modulePath(state.index)}.entry`,
        ));
        this.log({
          timestamp: new Date().toISOString(),
          level: "warning",
          event: "module.stale",
          projectId: this.projectId,
          moduleId: state.definition.id,
          message: "Module entry disappeared after loading.",
        });
        continue;
      }
      if (hashBytes(bytes) !== state.hash && state.status === "loaded") {
        state.status = "stale";
        this.log({
          timestamp: new Date().toISOString(),
          level: "warning",
          event: "module.stale",
          projectId: this.projectId,
          moduleId: state.definition.id,
          message: "Module bytes changed after loading.",
        });
      }
    }
    this.resultValue = this.buildResult();
    return this.resultValue;
  }

  /** 调用所有已激活模块的 `dispose`；幂等。 */
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeRegistrations();
  }

  private async loadOne(
    definition: ModuleDefinition,
    index: number,
    claims: ClaimTables,
  ): Promise<ModuleState> {
    const state = createState(definition, index);
    if (!isIdentifier(definition.id)) {
      state.status = "failed";
      state.diagnostics.push(diagnostic(
        "module.idMismatch",
        `Project module id '${definition.id}' is not a valid identifier.`,
        `${modulePath(index)}.id`,
      ));
      return state;
    }
    if (!this.trusted) {
      state.status = "untrusted";
      state.diagnostics.push(diagnostic(
        "module.untrusted",
        "Module was not loaded because the host did not grant module trust.",
        modulePath(index),
      ));
      return state;
    }
    if (this.disabledModuleIds.has(definition.id)) {
      state.status = "disabled";
      state.diagnostics.push(diagnostic(
        "module.disabled",
        `Module '${definition.id}' is disabled by the host.`,
        modulePath(index),
      ));
      return state;
    }
    if (
      definition.options !== undefined
      && (!isRecord(definition.options) || !isJsonValue(definition.options))
    ) {
      state.status = "failed";
      state.diagnostics.push(diagnostic(
        "module.optionsInvalid",
        "Project module options must be a JSON object.",
        `${modulePath(index)}.options`,
      ));
      return state;
    }

    try {
      const entryPath = await resolveModuleEntry(this.projectRoot, definition.entry);
      state.entryPath = entryPath;
      const bytes = await readModuleBytes(entryPath, definition.entry);
      state.hash = hashBytes(bytes);

      if (definition.hash !== undefined) {
        if (!PROJECT_MODULE_HASH_PATTERN.test(definition.hash)) {
          throw new ModuleLoaderError(
            "module.hashMismatch",
            `Declared module hash '${definition.hash}' is not a 'sha256:<lowercase hex>' value.`,
            { pathSuffix: "hash" },
          );
        }
        if (definition.hash !== state.hash) {
          throw new ModuleLoaderError(
            "module.hashMismatch",
            `Declared module hash ${definition.hash} does not match actual ${state.hash}.`,
            { pathSuffix: "hash" },
          );
        }
      }

      let exportsValue: unknown;
      try {
        exportsValue = evaluateModule(stripByteOrderMark(bytes.toString("utf8")), entryPath);
      } catch (errorValue) {
        throw new ModuleLoaderError(
          "module.loadFailed",
          `Module '${definition.id}' is not evaluable: ${describeError(errorValue)}.`,
          { cause: errorValue },
        );
      }

      const bundle = readBundleShape(exportsValue);
      state.manifest = bundle.manifest;
      state.webviews = bundle.webviews;

      if (bundle.manifest.id !== definition.id) {
        throw new ModuleLoaderError(
          "module.idMismatch",
          `Project module id '${definition.id}' does not match manifest id '${bundle.manifest.id}'.`,
          { pathSuffix: "id" },
        );
      }
      if (bundle.manifest.apiVersion !== MODULE_API_VERSION) {
        throw new ModuleLoaderError(
          "module.apiVersionMismatch",
          `Module '${definition.id}' apiVersion ${bundle.manifest.apiVersion} does not match MODULE_API_VERSION ${MODULE_API_VERSION}.`,
          { pathSuffix: "entry" },
        );
      }
      const sdkDiagnostic = this.sdkVersionDiagnostic(definition.id, bundle.manifest, index);
      if (sdkDiagnostic !== undefined) {
        state.diagnostics.push(sdkDiagnostic);
      }

      const host = this.createHost({
        moduleId: definition.id,
        entry: definition.entry,
        manifest: bundle.manifest,
        options: definition.options,
      });
      let registrationValue: unknown;
      try {
        registrationValue = await bundle.activate.call(exportsValue, host);
      } catch (errorValue) {
        if (errorValue instanceof ModuleRequireBlockedError) {
          throw new ModuleLoaderError(
            "module.loadFailed",
            `Module '${definition.id}' required non-builtin module '${errorValue.specifier}'.`,
            { cause: errorValue, pathSuffix: "entry" },
          );
        }
        throw new ModuleLoaderError(
          "module.activateFailed",
          `Module '${definition.id}' activate() failed: ${describeError(errorValue)}.`,
          { cause: errorValue, pathSuffix: "entry" },
        );
      }

      let registration: ValidatedRegistration | undefined;
      try {
        const normalized = normalizeRegistration(
          registrationValue,
          bundle.webviews,
          bundle.manifest.editors,
          index,
        );
        state.diagnostics.push(...normalized.diagnostics);
        registration = normalized.registration;
      } catch (errorValue) {
        throw new ModuleLoaderError(
          "module.registrationInvalid",
          `Module '${definition.id}' registration could not be read: ${describeError(errorValue)}.`,
          { cause: errorValue },
        );
      }
      if (registration === undefined) {
        state.status = "failed";
        return state;
      }
      state.registration = registration;

      const optionsResult = validateModuleOptions(registration, definition.options, index);
      state.diagnostics.push(...optionsResult.diagnostics);
      if (optionsResult.failed) {
        state.status = "failed";
        this.log({
          timestamp: new Date().toISOString(),
          level: "error",
          event: "module.failed",
          projectId: this.projectId,
          moduleId: definition.id,
          message: "Module options were rejected.",
          details: { code: "module.optionsInvalid" },
        });
        return state;
      }

      const conflictResult = this.applyRegistrationClaims(state, registration, claims);
      state.diagnostics.push(...conflictResult.diagnostics);
      if (conflictResult.disabled) {
        state.status = "disabled";
        this.log({
          timestamp: new Date().toISOString(),
          level: "error",
          event: "module.disabled",
          projectId: this.projectId,
          moduleId: definition.id,
          message: "Module registration conflicts with an earlier module.",
        });
        return state;
      }

      state.status = "loaded";
      this.log({
        timestamp: new Date().toISOString(),
        level: "info",
        event: "module.loaded",
        projectId: this.projectId,
        moduleId: definition.id,
        message: `Loaded module from '${definition.entry}'.`,
        details: { hash: state.hash, editors: conflictResult.editors },
      });
    } catch (errorValue) {
      this.recordFailure(state, errorValue);
    }
    return state;
  }

  private applyRegistrationClaims(
    state: ModuleState,
    registration: ValidatedRegistration,
    claims: ClaimTables,
  ): { readonly disabled: boolean; readonly diagnostics: readonly ModuleDiagnostic[]; readonly editors: readonly string[] } {
    const moduleId = state.definition.id;
    const editorConflicts = registration.editors.flatMap((editor, editorIndex) => {
      const owner = claims.editors.get(editor.editor);
      return owner === undefined
        ? []
        : [{
            editor,
            editorIndex,
            owner,
          }];
    });
    if (editorConflicts.length > 0) {
      return {
        disabled: true,
        editors: [],
        diagnostics: editorConflicts.map(({ editor, editorIndex, owner }) => diagnostic(
          "module.editorConflict",
          `Editor '${editor.editor}' is already provided by module '${owner}'.`,
          `${modulePath(state.index)}.editors[${editorIndex}].editor`,
        )),
      };
    }

    const referenceConflicts = registration.editors.flatMap((editor, editorIndex) => (
      editor.references.flatMap((reference, referenceIndex) => {
        const owner = claims.referenceKinds.get(reference.kind);
        return owner === undefined
          ? []
          : [{
              kind: reference.kind,
              owner,
              editorIndex,
              referenceIndex,
            }];
      })
    ));
    if (referenceConflicts.length > 0) {
      return {
        disabled: true,
        editors: [],
        diagnostics: referenceConflicts.map(({ kind, owner, editorIndex, referenceIndex }) => diagnostic(
          "module.referenceKindConflict",
          `Reference kind '${kind}' is already provided by module '${owner}'.`,
          `${modulePath(state.index)}.editors[${editorIndex}].references[${referenceIndex}].kind`,
        )),
      };
    }

    const debugConflicts = registration.editors.flatMap((editor, editorIndex) => (
      (editor.debug?.categories ?? []).flatMap((category, categoryIndex) => {
        const owner = claims.debugCategories.get(category);
        return owner === undefined
          ? []
          : [{
              category,
              owner,
              editorIndex,
              categoryIndex,
            }];
      })
    ));
    if (debugConflicts.length > 0) {
      return {
        disabled: true,
        editors: [],
        diagnostics: debugConflicts.map(({ category, owner, editorIndex, categoryIndex }) => diagnostic(
          "module.editorConflict",
          `Debug category '${category}' is already provided by module '${owner}'.`,
          `${modulePath(state.index)}.editors[${editorIndex}].debug.categories[${categoryIndex}]`,
        )),
      };
    }

    for (const editor of registration.editors) {
      claims.editors.set(editor.editor, moduleId);
      for (const reference of editor.references) {
        claims.referenceKinds.set(reference.kind, moduleId);
      }
      for (const category of editor.debug?.categories ?? []) {
        claims.debugCategories.set(category, moduleId);
      }
    }
    return {
      disabled: false,
      editors: registration.editors.map((editor) => editor.editor),
      diagnostics: [],
    };
  }

  private createHost(context: ModuleHostContext): ModuleLoaderHost {
    if (this.options.createHost !== undefined) {
      return this.options.createHost(context);
    }
    return {
      log: (level, message, details) => {
        this.log({
          timestamp: new Date().toISOString(),
          level,
          event: "module.log",
          projectId: this.projectId,
          moduleId: context.moduleId,
          message,
          ...(details === undefined ? {} : { details }),
        });
      },
    };
  }

  private sdkVersionDiagnostic(
    moduleId: string,
    manifest: ModuleManifest,
    index: number,
  ): ModuleDiagnostic | undefined {
    const expected = this.options.sdkVersion;
    if (expected === undefined || manifest.sdkVersion === undefined || manifest.sdkVersion === expected) {
      return undefined;
    }
    const message = `Module SDK version '${manifest.sdkVersion}' differs from host SDK version '${expected}'.`;
    this.log({
      timestamp: new Date().toISOString(),
      level: "warning",
      event: "module.sdkVersionMismatch",
      projectId: this.projectId,
      moduleId,
      message,
      details: { declared: manifest.sdkVersion, expected },
    });
    return {
      code: "module.sdkVersionMismatch",
      severity: "warning",
      message,
      path: `${modulePath(index)}.entry`,
    };
  }

  private recordFailure(state: ModuleState, errorValue: unknown): void {
    if (errorValue instanceof ModuleLoaderError) {
      // hash / apiVersion 不符按 D.1/D.2 语义“停用”，其余装载失败归 failed。
      const disabled = errorValue.code === "module.hashMismatch"
        || errorValue.code === "module.apiVersionMismatch";
      state.status = disabled ? "disabled" : "failed";
      const diagnosticPath = errorValue.pathSuffix === undefined
        ? modulePath(state.index)
        : `${modulePath(state.index)}.${errorValue.pathSuffix}`;
      state.diagnostics.push(diagnostic(errorValue.code, errorValue.message, diagnosticPath));
      this.log({
        timestamp: new Date().toISOString(),
        level: "error",
        event: disabled ? "module.disabled" : "module.failed",
        projectId: this.projectId,
        moduleId: state.definition.id,
        message: errorValue.message,
        details: { code: errorValue.code },
      });
      return;
    }
    state.status = "failed";
    const message = `Module '${state.definition.id}' failed to load: ${describeError(errorValue)}.`;
    state.diagnostics.push(diagnostic("module.loadFailed", message, modulePath(state.index)));
    this.log({
      timestamp: new Date().toISOString(),
      level: "error",
      event: "module.failed",
      projectId: this.projectId,
      moduleId: state.definition.id,
      message,
      details: { code: "module.loadFailed" },
    });
  }

  private disposeRegistrations(): void {
    for (const state of this.states) {
      if (state.disposed) continue;
      state.disposed = true;
      const registration = state.registration;
      if (registration === undefined) continue;
      try {
        registration.dispose?.call(registration);
        this.log({
          timestamp: new Date().toISOString(),
          level: "info",
          event: "module.disposed",
          projectId: this.projectId,
          moduleId: state.definition.id,
          message: "Module dispose() completed.",
        });
      } catch (errorValue) {
        this.log({
          timestamp: new Date().toISOString(),
          level: "warning",
          event: "module.disposeFailed",
          projectId: this.projectId,
          moduleId: state.definition.id,
          message: `Module dispose() failed: ${describeError(errorValue)}.`,
        });
      }
    }
  }

  private buildResult(): ModuleLoadResult<TRegistration> {
    const modules = this.states.map((state) => toLoadedModule<TRegistration>(state));
    const byId = new Map<string, LoadedModule<TRegistration>>();
    for (const module of modules) {
      if (!byId.has(module.id)) byId.set(module.id, module);
    }
    const editors = new Map<string, LoadedModule<TRegistration>>();
    for (const [editor, moduleId] of this.claims.editors) {
      const module = byId.get(moduleId);
      if (module !== undefined) editors.set(editor, module);
    }
    return {
      projectId: this.projectId,
      projectRoot: this.projectRoot,
      modules,
      editors,
      referenceKinds: new Map(this.claims.referenceKinds),
      debugCategories: new Map(this.claims.debugCategories),
      diagnostics: modules.flatMap((module) => module.diagnostics),
    };
  }

  private log(entry: ModuleLoaderLogEntry): void {
    this.options.log?.(entry);
  }
}

function createState(definition: ModuleDefinition, index: number): ModuleState {
  return {
    definition,
    index,
    status: "failed",
    diagnostics: [],
    manifest: undefined,
    registration: undefined,
    webviews: {},
    entryPath: undefined,
    hash: undefined,
    disposed: false,
  };
}

function toLoadedModule<TRegistration>(state: ModuleState): LoadedModule<TRegistration> {
  const registration = state.registration === undefined
    ? undefined
    : state.registration as unknown as TRegistration;
  return {
    id: state.definition.id,
    entry: state.definition.entry,
    status: state.status,
    diagnostics: [...state.diagnostics],
    ...(state.manifest === undefined ? {} : { manifest: state.manifest }),
    ...(registration === undefined ? {} : { registration }),
    webviews: state.webviews,
    ...(state.hash === undefined ? {} : { hash: state.hash }),
    ...(state.definition.hash === undefined ? {} : { declaredHash: state.definition.hash }),
  };
}

function readBundleShape(value: unknown): {
  readonly manifest: ModuleManifest;
  readonly webviews: Readonly<Record<string, ModuleWebview>>;
  readonly activate: (host: ModuleLoaderHost) => unknown;
} {
  if (!isRecord(value)) {
    throw new ModuleLoaderError("module.manifestInvalid", "Module bundle must export an object.");
  }
  let manifest: ModuleManifest | undefined;
  let webviews: Readonly<Record<string, ModuleWebview>> | undefined;
  let activateValue: unknown;
  try {
    manifest = readManifest(value.manifest);
    webviews = readWebviews(value.webviews);
    activateValue = value.activate;
  } catch (errorValue) {
    throw new ModuleLoaderError(
      "module.manifestInvalid",
      `Module bundle shape could not be read: ${describeError(errorValue)}.`,
      { cause: errorValue },
    );
  }
  if (manifest === undefined) {
    throw new ModuleLoaderError(
      "module.manifestInvalid",
      "Module manifest must declare valid id/version/apiVersion/editors.",
    );
  }
  if (webviews === undefined) {
    throw new ModuleLoaderError(
      "module.manifestInvalid",
      "Module webviews must be a record of { script, style } strings.",
    );
  }
  if (typeof activateValue !== "function") {
    throw new ModuleLoaderError("module.registrationInvalid", "Module bundle must export activate(host).");
  }
  return {
    manifest,
    webviews,
    activate: activateValue as (host: ModuleLoaderHost) => unknown,
  };
}

function normalizeRegistration(
  value: unknown,
  webviews: Readonly<Record<string, ModuleWebview>>,
  manifestEditors: readonly string[],
  moduleIndex: number,
): { readonly registration?: ValidatedRegistration; readonly diagnostics: readonly ModuleDiagnostic[] } {
  const diagnostics: ModuleDiagnostic[] = [];
  const fail = (message: string, pathSuffix: string): void => {
    diagnostics.push(diagnostic(
      "module.registrationInvalid",
      message,
      `${modulePath(moduleIndex)}.${pathSuffix}`,
    ));
  };

  if (!isRecord(value)) {
    return {
      diagnostics: [diagnostic("module.registrationInvalid", "Registration must be an object.", modulePath(moduleIndex))],
    };
  }
  const editorsValue = value.editors;
  if (!Array.isArray(editorsValue) || editorsValue.length === 0) {
    return {
      diagnostics: [diagnostic(
        "module.registrationInvalid",
        "Registration 'editors' must be a non-empty array.",
        `${modulePath(moduleIndex)}.editors`,
      )],
    };
  }

  const editors: ValidatedEditorRegistration[] = [];
  const seenEditors = new Set<string>();
  editorsValue.forEach((editorValue, editorIndex) => {
    const editorPath = `${modulePath(moduleIndex)}.editors[${editorIndex}]`;
    if (!isRecord(editorValue)) {
      fail("Editor registration must be an object.", `editors[${editorIndex}]`);
      return;
    }
    const editor = readIdentifier(editorValue.editor);
    if (editor === undefined) {
      fail("Editor id must be an identifier.", `editors[${editorIndex}].editor`);
      return;
    }
    if (seenEditors.has(editor)) {
      fail(`Editor '${editor}' is registered more than once by this module.`, `editors[${editorIndex}].editor`);
      return;
    }
    seenEditors.add(editor);
    if (!manifestEditors.includes(editor)) {
      fail(`Editor '${editor}' is not declared in manifest.editors.`, `editors[${editorIndex}].editor`);
    }

    const webview = readNonEmptyString(editorValue.webview);
    if (webview === undefined) {
      fail("Editor registration must declare a webview key.", `editors[${editorIndex}].webview`);
    } else if (!Object.prototype.hasOwnProperty.call(webviews, webview)) {
      fail(`Webview key '${webview}' is not present in bundle.webviews.`, `editors[${editorIndex}].webview`);
    }
    const webviewTitle = readNonEmptyString(editorValue.webviewTitle);
    if (webviewTitle === undefined) {
      fail("Editor registration must declare webviewTitle.", `editors[${editorIndex}].webviewTitle`);
    }

    // Core 的 DocumentFacet 把存储形态表成判别式字符串（storage），parse/render 由 semantic 承载；
    // A2 的独立 codec 对象（storage.codec）仍接受，进程内注册源尚未迁移。
    const storage = editorValue.storage
      ?? (isRecord(editorValue.semantic) ? editorValue.semantic.storage : undefined);
    if (storage === "text" || storage === "sources") {
      // 判别式字符串即合格：DocumentFacet 自带 parse/render。
    } else if (!isRecord(storage)) {
      fail("Editor registration must declare storage.", `editors[${editorIndex}].storage`);
    } else if (storage.kind === "sources" || (storage.kind === undefined && "planSources" in storage)) {
      if (
        typeof storage.planSources !== "function"
        || typeof storage.parse !== "function"
        || typeof storage.render !== "function"
      ) {
        fail(
          "Sources storage must declare planSources/parse/render.",
          `editors[${editorIndex}].storage`,
        );
      }
    } else if (storage.kind === "text" || (storage.kind === undefined && "codec" in storage)) {
      const codec = storage.codec;
      if (!isRecord(codec) || typeof codec.parse !== "function" || typeof codec.render !== "function") {
        fail("Text storage must declare codec.parse and codec.render.", `editors[${editorIndex}].storage.codec`);
      }
    } else {
      fail(
        "Storage must declare a text codec or sources planSources/parse/render.",
        `editors[${editorIndex}].storage`,
      );
    }

    const semantic = editorValue.semantic;
    if (!isRecord(semantic)) {
      fail("Editor registration must declare semantic.", `editors[${editorIndex}].semantic`);
    } else {
      if (semantic.editor !== editor) {
        fail("semantic.editor must match the registration editor id.", `editors[${editorIndex}].semantic.editor`);
      }
      for (const method of [
        "describe",
        "validate",
        "applyOperations",
        "collectReferences",
        "replaceReferenceValues",
      ]) {
        if (typeof semantic[method] !== "function") {
          fail(`semantic.${method} must be a function.`, `editors[${editorIndex}].semantic.${method}`);
        }
      }
    }

    // 会话面必填（§D.3）：createController（A2 SessionFacet）与真实
    // ModuleSessionController（state/handle）两种形状都接受。
    const session = editorValue.session;
    const isSessionFacet = isRecord(session) && typeof session.createController === "function";
    const isSessionController = isRecord(session)
      && typeof session.state === "function"
      && typeof session.handle === "function";
    if (!isSessionFacet && !isSessionController) {
      fail(
        "Editor registration must declare session.createController (or a session controller with state/handle).",
        `editors[${editorIndex}].session`,
      );
    }

    const references = readReferenceKinds(editorValue.references, `editors[${editorIndex}].references`, fail);

    let debug: ValidatedEditorRegistration["debug"];
    if (editorValue.debug !== undefined) {
      if (!isRecord(editorValue.debug)) {
        fail("debug must be an object.", `editors[${editorIndex}].debug`);
      } else {
        const categories = readStringArray(editorValue.debug.categories);
        if (categories === undefined) {
          fail("debug.categories must be a non-empty unique string array.", `editors[${editorIndex}].debug.categories`);
        } else if (typeof editorValue.debug.onRecord !== "function") {
          fail("debug.onRecord must be a function.", `editors[${editorIndex}].debug.onRecord`);
        } else if (
          editorValue.debug.windowTitle !== undefined
          && readNonEmptyString(editorValue.debug.windowTitle) === undefined
        ) {
          fail("debug.windowTitle must be a non-empty string.", `editors[${editorIndex}].debug.windowTitle`);
        } else {
          debug = {
            categories,
            ...(editorValue.debug.windowTitle === undefined
              ? {}
              : { windowTitle: editorValue.debug.windowTitle as string }),
          };
        }
      }
    }

    if (editorValue.catalog !== undefined) {
      // 两种形状都接受：A2 的 dapter.parse/build（进程内注册源）与 Core CatalogFacet 的
      // parse/build/createRegistry/definitions/registryDefinitions（bundle 用）。
      const legacyCatalog = isRecord(editorValue.catalog)
        && isRecord(editorValue.catalog.adapter)
        && typeof editorValue.catalog.adapter.parse === "function"
        && typeof editorValue.catalog.adapter.build === "function";
      const facetCatalog = isRecord(editorValue.catalog)
        && typeof editorValue.catalog.parse === "function"
        && typeof editorValue.catalog.build === "function"
        && typeof editorValue.catalog.createRegistry === "function"
        && typeof editorValue.catalog.definitions === "function"
        && typeof editorValue.catalog.registryDefinitions === "function";
      if (
        !isRecord(editorValue.catalog)
        || readStringArray(editorValue.catalog.extensions) === undefined
        || (!legacyCatalog && !facetCatalog)
      ) {
        fail(
          "catalog must declare extensions plus either adapter.parse/build or a Core CatalogFacet (parse/build/createRegistry/definitions/registryDefinitions).",
          `editors[${editorIndex}].catalog`,
        );
      }
    }
    if (editorValue.create !== undefined) {
      // 两种形状都接受：SDK CreateFacet（choices/render）与四域真实的 prepare(input)。
      const createFacet = isRecord(editorValue.create)
        && typeof editorValue.create.choices === "function"
        && typeof editorValue.create.render === "function";
      const prepareFacet = isRecord(editorValue.create)
        && typeof editorValue.create.prepare === "function";
      if (!createFacet && !prepareFacet) {
        fail("create must declare choices/render or prepare(input).", `editors[${editorIndex}].create`);
      }
    }
    if (editorValue.mcp !== undefined) {
      if (
        !isRecord(editorValue.mcp)
        || typeof editorValue.mcp.queryCatalog !== "function"
        || typeof editorValue.mcp.queryDocument !== "function"
      ) {
        fail("mcp must declare queryCatalog/queryDocument.", `editors[${editorIndex}].mcp`);
      }
    }
    if (editorValue.reveal !== undefined) {
      if (!isRecord(editorValue.reveal) || typeof editorValue.reveal.readTarget !== "function") {
        fail("reveal must declare readTarget.", `editors[${editorIndex}].reveal`);
      }
    }
    if (editorValue.referenceData !== undefined && typeof editorValue.referenceData !== "function") {
      fail("referenceData must be a function.", `editors[${editorIndex}].referenceData`);
    }
    if (
      editorValue.operationSchema !== undefined
      && (!isRecord(editorValue.operationSchema) || !isJsonValue(editorValue.operationSchema))
    ) {
      fail("operationSchema must be a JSON object.", `editors[${editorIndex}].operationSchema`);
    }

    editors.push({
      ...editorValue,
      editor,
      webview: webview ?? "",
      webviewTitle: webviewTitle ?? "",
      references,
      ...(debug === undefined ? {} : { debug }),
    });
  });

  let validateOptions: ((options: JsonObject | undefined) => unknown) | undefined;
  for (const manifestEditor of manifestEditors) {
    if (!seenEditors.has(manifestEditor)) {
      fail(`Manifest editor '${manifestEditor}' was not registered.`, "editors");
    }
  }
  if (value.validateOptions !== undefined) {
    if (typeof value.validateOptions !== "function") {
      fail("validateOptions must be a function.", "validateOptions");
    } else {
      validateOptions = value.validateOptions.bind(value) as (options: JsonObject | undefined) => unknown;
    }
  }
  let dispose: (() => unknown) | undefined;
  if (value.dispose !== undefined) {
    if (typeof value.dispose !== "function") {
      fail("dispose must be a function.", "dispose");
    } else {
      dispose = value.dispose.bind(value) as () => unknown;
    }
  }

  if (diagnostics.length > 0) {
    return { diagnostics };
  }
  return {
    registration: {
      ...value,
      editors,
      ...(validateOptions === undefined ? {} : { validateOptions }),
      ...(dispose === undefined ? {} : { dispose }),
    } as ValidatedRegistration,
    diagnostics: [],
  };
}

function readReferenceKinds(
  value: unknown,
  basePath: string,
  fail: (message: string, pathSuffix: string) => void,
): readonly { readonly kind: string }[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    fail("references must be an array.", basePath);
    return [];
  }
  const kinds: { readonly kind: string }[] = [];
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    if (!isRecord(entry)) {
      fail("Reference kind registration must be an object.", `${basePath}[${index}]`);
      return;
    }
    const kind = readIdentifier(entry.kind);
    if (kind === undefined) {
      fail("Reference kind must be an identifier.", `${basePath}[${index}].kind`);
      return;
    }
    if (seen.has(kind)) {
      fail(`Reference kind '${kind}' is registered more than once by this module.`, `${basePath}[${index}].kind`);
      return;
    }
    if (typeof entry.createProvider !== "function") {
      fail("Reference kind must declare createProvider.", `${basePath}[${index}].createProvider`);
      return;
    }
    seen.add(kind);
    kinds.push(entry as { readonly kind: string });
  });
  return kinds;
}

function validateModuleOptions(
  registration: ValidatedRegistration,
  options: JsonObject | undefined,
  moduleIndex: number,
): { readonly failed: boolean; readonly diagnostics: readonly ModuleDiagnostic[] } {
  const validateOptions = registration.validateOptions;
  if (validateOptions === undefined) {
    return { failed: false, diagnostics: [] };
  }
  let result: unknown;
  try {
    result = validateOptions.call(registration, options);
  } catch (errorValue) {
    if (errorValue instanceof ModuleRequireBlockedError) {
      return {
        failed: true,
        diagnostics: [diagnostic(
          "module.loadFailed",
          `validateOptions() required non-builtin module '${errorValue.specifier}'.`,
          `${modulePath(moduleIndex)}.options`,
        )],
      };
    }
    return {
      failed: true,
      diagnostics: [diagnostic(
        "module.callFailed",
        `validateOptions() failed: ${describeError(errorValue)}.`,
        `${modulePath(moduleIndex)}.options`,
      )],
    };
  }
  if (!Array.isArray(result)) {
    return {
      failed: true,
      diagnostics: [diagnostic(
        "module.callFailed",
        "validateOptions() must return an array of diagnostics.",
        `${modulePath(moduleIndex)}.options`,
      )],
    };
  }

  const diagnostics: ModuleDiagnostic[] = [];
  let failed = false;
  for (const entry of result) {
    if (
      !isRecord(entry)
      || (entry.severity !== "error" && entry.severity !== "warning")
      || typeof entry.code !== "string"
      || typeof entry.message !== "string"
      || typeof entry.path !== "string"
    ) {
      return {
        failed: true,
        diagnostics: [diagnostic(
          "module.callFailed",
          "validateOptions() returned a malformed diagnostic.",
          `${modulePath(moduleIndex)}.options`,
        )],
      };
    }
    if (entry.severity === "error") failed = true;
    diagnostics.push(diagnostic(
      "module.optionsInvalid",
      `[${entry.code}] ${entry.path}: ${entry.message}`,
      `${modulePath(moduleIndex)}.options`,
      entry.severity,
    ));
  }
  return { failed, diagnostics };
}

function readManifest(value: unknown): ModuleManifest | undefined {
  if (!isRecord(value)) return undefined;
  const id = readIdentifier(value.id);
  const version = readNonEmptyString(value.version);
  const apiVersion = typeof value.apiVersion === "number" && Number.isSafeInteger(value.apiVersion)
    ? value.apiVersion
    : undefined;
  let sdkVersion: string | undefined;
  if (value.sdkVersion !== undefined) {
    sdkVersion = readNonEmptyString(value.sdkVersion);
    if (sdkVersion === undefined) return undefined;
  }
  const editors = readIdentifiers(value.editors);
  if (id === undefined || version === undefined || apiVersion === undefined || editors === undefined) {
    return undefined;
  }
  return {
    id,
    version,
    apiVersion,
    ...(sdkVersion === undefined ? {} : { sdkVersion }),
    editors,
  };
}

function readIdentifiers(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value) {
    const identifier = readIdentifier(entry);
    if (identifier === undefined || seen.has(identifier)) return undefined;
    seen.add(identifier);
    result.push(identifier);
  }
  return result;
}

function readWebviews(value: unknown): Readonly<Record<string, ModuleWebview>> | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, ModuleWebview> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!isWebviewKey(key) || !isRecord(entry) || typeof entry.script !== "string" || typeof entry.style !== "string") {
      return undefined;
    }
    result[key] = { script: entry.script, style: entry.style };
  }
  return result;
}

function readIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value) ? value : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value) {
    const text = readNonEmptyString(entry);
    if (text === undefined || seen.has(text)) return undefined;
    seen.add(text);
    result.push(text);
  }
  return result;
}

function isIdentifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
}

function isWebviewKey(value: string): boolean {
  return value.length > 0
    && value !== "__proto__"
    && value !== "constructor"
    && value !== "prototype";
}

async function resolveProjectRoot(projectRoot: string): Promise<string> {
  if (typeof projectRoot !== "string" || projectRoot.length === 0) {
    throw new ModuleLoaderError("module.invalidPath", "Module Project root must be a non-empty path.");
  }
  let resolved: string;
  try {
    resolved = await realpath(path.resolve(projectRoot));
  } catch (errorValue) {
    throw new ModuleLoaderError(
      "module.notFound",
      `Module Project root '${projectRoot}' is unavailable: ${describeError(errorValue)}.`,
      { cause: errorValue },
    );
  }
  const entry = await lstat(resolved);
  if (!entry.isDirectory()) {
    throw new ModuleLoaderError("module.invalidPath", `Module Project root '${projectRoot}' must be a directory.`);
  }
  return resolved;
}

async function resolveModuleEntry(projectRoot: string, entry: string): Promise<string> {
  validateModuleEntry(entry);
  const segments = entry.split("/");
  let current = projectRoot;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    const isLeaf = index === segments.length - 1;
    let entries: Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (errorValue) {
      throw new ModuleLoaderError(
        "module.notFound",
        `Module entry '${entry}' is unavailable: ${describeError(errorValue)}.`,
        { cause: errorValue, pathSuffix: "entry" },
      );
    }
    const exact = entries.find((candidate) => candidate.name === segment);
    if (exact === undefined) {
      // 只有大小写不敏感的平台才可能是“大小写别名”；Linux 上同名不同大小写是另一个文件。
      const caseAlias = process.platform === "win32" || process.platform === "darwin"
        ? entries.find((candidate) => candidate.name.toLowerCase() === segment.toLowerCase())
        : undefined;
      if (caseAlias !== undefined) {
        throw new ModuleLoaderError(
          "module.entryAlias",
          `Module entry '${entry}' resolves through a case alias '${caseAlias.name}'.`,
          { pathSuffix: "entry" },
        );
      }
      throw new ModuleLoaderError(
        "module.notFound",
        `Module entry '${entry}' does not exist (missing '${segment}').`,
        { pathSuffix: "entry" },
      );
    }
    const candidate = path.join(current, segment);
    let candidateStat: Stats;
    try {
      candidateStat = await lstat(candidate);
    } catch (errorValue) {
      throw new ModuleLoaderError(
        "module.notFound",
        `Module entry '${entry}' is unavailable: ${describeError(errorValue)}.`,
        { cause: errorValue, pathSuffix: "entry" },
      );
    }
    if (candidateStat.isSymbolicLink()) {
      throw new ModuleLoaderError(
        "module.entryAlias",
        `Module entry '${entry}' resolves through a symlink or junction.`,
        { pathSuffix: "entry" },
      );
    }
    if (isLeaf) {
      if (!candidateStat.isFile()) {
        throw new ModuleLoaderError(
          "module.invalidPath",
          `Module entry '${entry}' must be a regular file.`,
          { pathSuffix: "entry" },
        );
      }
    } else if (!candidateStat.isDirectory()) {
      throw new ModuleLoaderError(
        "module.invalidPath",
        `Module entry '${entry}' has a non-directory path segment '${segment}'.`,
        { pathSuffix: "entry" },
      );
    }
    current = candidate;
  }
  ensureInside(projectRoot, current, entry);
  let resolved: string;
  try {
    resolved = await realpath(current);
  } catch (errorValue) {
    throw new ModuleLoaderError(
      "module.notFound",
      `Module entry '${entry}' is unavailable: ${describeError(errorValue)}.`,
      { cause: errorValue, pathSuffix: "entry" },
    );
  }
  if (pathIdentity(resolved) !== pathIdentity(current)) {
    throw new ModuleLoaderError(
      "module.entryAlias",
      `Module entry '${entry}' resolves through a path alias.`,
      { pathSuffix: "entry" },
    );
  }
  return resolved;
}

function validateModuleEntry(entry: string): void {
  if (
    entry.length === 0
    || entry.includes("\\")
    || entry.includes(":")
    || entry.includes("\0")
    || /[\u0000-\u001f\u007f-\u009f]/u.test(entry)
    || entry.startsWith("/")
    || path.isAbsolute(entry)
  ) {
    throw new ModuleLoaderError(
      "module.invalidPath",
      `Module entry '${entry}' must be a normalized project-relative path using '/' separators.`,
      { pathSuffix: "entry" },
    );
  }
  const segments = entry.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new ModuleLoaderError(
      "module.invalidPath",
      `Module entry '${entry}' must not contain empty, '.' or '..' segments.`,
      { pathSuffix: "entry" },
    );
  }
  if (!entry.endsWith(PROJECT_MODULE_ENTRY_SUFFIX)) {
    throw new ModuleLoaderError(
      "module.invalidPath",
      `Module entry '${entry}' must end with '${PROJECT_MODULE_ENTRY_SUFFIX}'.`,
      { pathSuffix: "entry" },
    );
  }
  if (entry === PROJECT_MODULE_ENTRY_SUFFIX) {
    throw new ModuleLoaderError(
      "module.invalidPath",
      "Module entry must include a file name stem before '.vbmodule.js'.",
      { pathSuffix: "entry" },
    );
  }
}

function ensureInside(root: string, candidate: string, displayPath: string): void {
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ModuleLoaderError(
      "module.invalidPath",
      `Module entry '${displayPath}' leaves the Project root.`,
      { pathSuffix: "entry" },
    );
  }
}

async function readModuleBytes(entryPath: string, entry: string): Promise<Buffer> {
  try {
    return await readFile(entryPath);
  } catch (errorValue) {
    throw new ModuleLoaderError(
      "module.notFound",
      `Module entry '${entry}' is unavailable: ${describeError(errorValue)}.`,
      { cause: errorValue, pathSuffix: "entry" },
    );
  }
}

function evaluateModule(code: string, filename: string): unknown {
  const moduleObject: { exports: unknown } = { exports: {} };
  const compiled = compileFunction(code, ["module", "exports", "require"], { filename });
  compiled(moduleObject, moduleObject.exports, guardedRequire);
  return moduleObject.exports;
}

class ModuleRequireBlockedError extends Error {
  public readonly specifier: string;

  public constructor(specifier: string) {
    super(`Module may only require Node builtins; '${specifier}' is not allowed.`);
    this.name = "ModuleRequireBlockedError";
    this.specifier = specifier;
  }
}

function guardedRequire(specifier: string): unknown {
  if (typeof specifier !== "string" || !isBuiltin(specifier)) {
    throw new ModuleRequireBlockedError(String(specifier));
  }
  return nodeRequire(specifier);
}

const nodeRequire: (specifier: string) => unknown = require;

function stripByteOrderMark(value: string): string {
  return value.charCodeAt(0) === 0xFEFF ? value.slice(1) : value;
}

function hashBytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function diagnostic(
  code: ModuleErrorCode,
  message: string,
  diagnosticPath: string,
  severity: "error" | "warning" = "error",
): ModuleDiagnostic {
  return { code, severity, message, path: diagnosticPath };
}

function addDiagnosticOnce(diagnostics: ModuleDiagnostic[], entry: ModuleDiagnostic): void {
  if (diagnostics.some((existing) => existing.code === entry.code && existing.path === entry.path)) return;
  diagnostics.push(entry);
}

function modulePath(index: number): string {
  return `modules[${index}]`;
}

function pathIdentity(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function emptyClaims(): ClaimTables {
  return {
    editors: new Map(),
    referenceKinds: new Map(),
    debugCategories: new Map(),
  };
}

function describeError(errorValue: unknown): string {
  return errorValue instanceof Error ? `${errorValue.name}: ${errorValue.message}` : String(errorValue);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
