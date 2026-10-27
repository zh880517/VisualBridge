/**
 * 调试契约注册表（附录 C.8、B.5）：定位 Unity 生成器的 `debug-contracts.json`，
 * 按 `(category, methodId)` 暴露参数名/类型/枚举宽度，并给出可发布的 `contractHash`。
 *
 * 定位规则（C.8）：
 * 1. **主来源**：从 VisualBridge Project 根向上找到 Unity 工程根
 *    （`ProjectSettings/ProjectVersion.txt`），读 `VisualBridgeDebugConfig.ArtifactsRoot`
 *    （缺失或空串 = D2 默认 `Assets/VisualBridgeGenerated/Debug`，即附录 A.8 的 `""`
 *    与 D2 默认值的对齐点），取 `<UnityRoot>/<ArtifactsRoot>/debug-contracts.json`。
 * 2. **补充/覆盖**：`visualbridge.debug.contractDirectories`（工作区相对路径，递归查找同名文件）。
 *
 * 合并键是接口全名（C.8）：补充目录只能新增接口，与主来源同名但内容不同时**保留主来源**
 * 并记一条冲突（界面标红，记录不丢）。
 *
 * 缓存按 **Project 根分别进行**（评审 P0：多 Project 工作区里不得张冠李戴）；快照不可变，
 * 热更新只替换快照对象，已按旧快照解出的记录不会被回溯重解（评审 P0）。
 */

import { promises as fs } from "node:fs";
import * as nodePath from "node:path";
import { BRIDGE_CONTRACT_SCHEMA_VERSION } from "./bridgeProtocol";

/** Unity 生成器写出的契约文件名（附录 B.5）。 */
export const DEBUG_CONTRACTS_FILE_NAME = "debug-contracts.json";

/** `VisualBridgeDebugConfig.ArtifactsRoot` 的默认值（D2；附录 A.8 的 `""` 即取此值）。 */
export const DEBUG_ARTIFACTS_ROOT_DEFAULT = "Assets/VisualBridgeGenerated/Debug";

/** 补充/覆盖目录的 VS Code 设置键（附录 A.8/C.8）。 */
export const DEBUG_CONTRACT_DIRECTORIES_SETTING = "visualbridge.debug.contractDirectories";

/** Unity 工程根标记：有它才算一个 Unity 工程（避免把任意工作区当工程）。 */
export const UNITY_PROJECT_MARKER = "ProjectSettings/ProjectVersion.txt";

/** 调试契约配置资产（ScriptableObject）；显式 `ArtifactsRoot` 从这里读。 */
const DEBUG_CONFIG_ASSET_NAME = "VisualBridgeDebugConfig.asset";

/** A.4 的线上类型名（JSON `args[].type` 用同一套名字）。 */
export type DebugContractWireType = "bool" | "int" | "long" | "ulong" | "float" | "double" | "enum" | "string" | "byte[]";

/** 二进制枚举值的宽度（字节）；A.4 要求按契约 `underlyingType` 推进。 */
export type DebugContractEnumWidth = 1 | 2 | 4 | 8;

/** 记录/消息的契约匹配状态（C.2 的 `contractState`）。 */
export type DebugContractState = "matched" | "unknown-interface" | "contract-conflict";

export interface DebugContractParameter {
  readonly tag: number;
  readonly name: string;
  /** 契约里的声明类型（`sbyte` / `uint` / `Sample.Graph.Mode` 等）。 */
  readonly declaredType: string;
  readonly wireType: DebugContractWireType;
  readonly enumName: string | undefined;
  readonly enumWidth: DebugContractEnumWidth | undefined;
  readonly optional: boolean;
}

export interface DebugContractMethod {
  readonly category: string;
  /** 短接口名（D4/E6 的 `interfaceId`，如 `IGraphDebuger`）。 */
  readonly interfaceId: string;
  /** 接口全名（C.8 的合并键）。 */
  readonly interfaceFullName: string;
  readonly name: string;
  readonly methodId: number;
  readonly kind: string;
  /** 只有进入载荷的参数（带 `tag`）；`instance` / `request` 参数不在此列（A.4）。 */
  readonly parameters: readonly DebugContractParameter[];
  readonly result: DebugContractParameter | undefined;
}

export interface DebugContractSourceInfo {
  readonly directory: string;
  readonly file: string;
  readonly contractHash: string;
  readonly schemaVersion: number;
  readonly interfaces: number;
  readonly methods: number;
  readonly role: "primary" | "supplemental";
}

export type DebugContractConflictKind = "interface" | "method";

export interface DebugContractConflict {
  readonly kind: DebugContractConflictKind;
  /** 冲突键：接口全名（`interface`）或 `category#methodId`（`method`）。 */
  readonly key: string;
  readonly detail: string;
  readonly primaryDirectory: string;
  readonly supplementalDirectory: string;
  /** `method` 冲突的分类名与方法号（界面据此定位号段；`interface` 冲突不填）。 */
  readonly category?: string;
  readonly methodId?: number;
}

export type DebugContractSkipReason =
  | "missing"
  | "unreadable"
  | "malformed"
  | "schemaVersion"
  | "contractHash"
  | "artifactsRoot";

export interface DebugContractSkip {
  readonly directory: string;
  readonly reason: DebugContractSkipReason;
  readonly detail: string;
}

/** 只在目录**首次**被判定为缺失/不可读时产生（C.8：目录不存在只警告一次）。 */
export interface DebugContractWarning {
  readonly directory: string;
  readonly message: string;
}

export interface DebugContractSnapshotSet {
  /** 全部不同快照（按 Project 根顺序去重后的稳定顺序）。 */
  readonly snapshots: readonly DebugContractSnapshot[];
  /** Project 根 → 快照（每个根都有自己的定位结果）。 */
  readonly byProjectRoot: ReadonlyMap<string, DebugContractSnapshot>;
  /** 已知的非空契约指纹（16 位十六进制），升序。 */
  readonly hashes: readonly string[];
  readonly snapshotForHash: (contractHash: string) => DebugContractSnapshot | undefined;
  readonly warnings: readonly DebugContractWarning[];
}

const EMPTY_SNAPSHOTS: readonly DebugContractSnapshot[] = [];

/** 空快照集合（未定位到任何契约时的稳定初值）。 */
export const EMPTY_DEBUG_CONTRACT_SNAPSHOT_SET: DebugContractSnapshotSet = {
  snapshots: EMPTY_SNAPSHOTS,
  byProjectRoot: new Map<string, DebugContractSnapshot>(),
  hashes: [],
  snapshotForHash: () => undefined,
  warnings: [],
};

/**
 * 不可变契约快照：一次加载的结果。已产出的记录持有自己的快照引用，
 * 热更新只替换注册表里的当前快照（C.8：契约热更新不回溯重解旧记录）。
 */
export class DebugContractSnapshot {
  public readonly contractHash: string;
  public readonly schemaVersion: number | undefined;
  public readonly primary: DebugContractSourceInfo | undefined;
  public readonly supplemental: readonly DebugContractSourceInfo[];
  public readonly conflicts: readonly DebugContractConflict[];
  public readonly skipped: readonly DebugContractSkip[];
  public readonly methods: readonly DebugContractMethod[];
  public readonly unityRoot: string | undefined;
  private readonly byMethodId: ReadonlyMap<string, DebugContractMethod>;
  private readonly byMethodName: ReadonlyMap<string, DebugContractMethod>;
  private readonly conflictedInterfaces: ReadonlySet<string>;
  private readonly conflictedMethods: ReadonlySet<string>;

  public constructor(init: {
    readonly unityRoot: string | undefined;
    readonly primary: DebugContractSourceInfo | undefined;
    readonly supplemental: readonly DebugContractSourceInfo[];
    readonly conflicts: readonly DebugContractConflict[];
    readonly skipped: readonly DebugContractSkip[];
    readonly methods: readonly DebugContractMethod[];
    readonly contractHash: string;
    readonly schemaVersion: number | undefined;
  }) {
    this.unityRoot = init.unityRoot;
    this.primary = init.primary;
    this.supplemental = init.supplemental;
    this.conflicts = init.conflicts;
    this.skipped = init.skipped;
    this.methods = init.methods;
    this.contractHash = init.contractHash;
    this.schemaVersion = init.schemaVersion;

    const byMethodId = new Map<string, DebugContractMethod>();
    const byMethodName = new Map<string, DebugContractMethod>();
    for (const method of init.methods) {
      const idKey = methodKey(method.category, method.methodId);
      // 主来源优先的确定性构建：合并阶段已让每个 (category, methodId) 只有一份声明，
      // 这里再用 first-wins 兜底，绝不靠"排序后 last-wins"。
      if (!byMethodId.has(idKey)) {
        byMethodId.set(idKey, method);
      }

      byMethodName.set(methodNameKey(method.category, method.interfaceId, method.name), method);
    }

    this.byMethodId = byMethodId;
    this.byMethodName = byMethodName;
    this.conflictedInterfaces = new Set(
      init.conflicts.filter((conflict) => conflict.kind === "interface").map((conflict) => conflict.key),
    );
    // method 级冲突的键是 `category#methodId`：命中的声明本身仍是主来源（解码正确），
    // 但要像接口冲突一样标红，说明该号段存在被跳过的竞争声明（C.8）。
    const conflictedMethods = new Set<string>();
    for (const conflict of init.conflicts) {
      if (conflict.kind === "method" && conflict.category !== undefined && conflict.methodId !== undefined) {
        conflictedMethods.add(methodKey(conflict.category, conflict.methodId));
      }
    }

    this.conflictedMethods = conflictedMethods;
  }

  /** 是否加载到了任何契约（否则全部走通用视图，C.8）。 */
  public get loaded(): boolean {
    return this.methods.length > 0;
  }

  /** 主来源与补充目录都为空：没有可加载的契约。 */
  public get empty(): boolean {
    return this.primary === undefined && this.supplemental.length === 0;
  }

  public resolveByMethodId(category: string, methodId: number): DebugContractMethod | undefined {
    return this.byMethodId.get(methodKey(category, methodId));
  }

  public resolveByMethodName(category: string, interfaceId: string, method: string): DebugContractMethod | undefined {
    return this.byMethodName.get(methodNameKey(category, interfaceId, method));
  }

  /**
   * 按消息实际携带的字段解析：二进制只有 `(category, methodId)`，JSON 有 `iface`/`method`。
   * 返回声明与契约匹配状态（C.2）；未命中不影响展示，只影响参数名与类型。
   */
  public resolveMessage(
    category: string | undefined,
    methodId: number | undefined,
    interfaceId: string | undefined,
    method: string | undefined,
  ): { readonly declaration: DebugContractMethod | undefined; readonly state: DebugContractState } {
    let declaration: DebugContractMethod | undefined;
    if (category !== undefined && methodId !== undefined) {
      declaration = this.resolveByMethodId(category, methodId);
    }

    if (declaration === undefined && category !== undefined && interfaceId !== undefined && method !== undefined) {
      declaration = this.resolveByMethodName(category, interfaceId, method);
    }

    if (declaration === undefined) {
      return { declaration: undefined, state: "unknown-interface" };
    }

    return {
      declaration,
      state: this.conflictedInterfaces.has(declaration.interfaceFullName)
        || this.conflictedMethods.has(methodKey(declaration.category, declaration.methodId))
        ? "contract-conflict"
        : "matched",
    };
  }

  /** 枚举参数的二进制宽度；拿不到就返回 undefined（解码端据此整条丢弃，A.4）。 */
  public resolveEnumWidth(category: string, methodId: number, tag: number): DebugContractEnumWidth | undefined {
    const declaration = this.resolveByMethodId(category, methodId);
    if (declaration === undefined) {
      return undefined;
    }

    for (const parameter of declaration.parameters) {
      if (parameter.tag === tag) {
        return parameter.enumWidth;
      }
    }

    return declaration.result !== undefined && declaration.result.tag === tag ? declaration.result.enumWidth : undefined;
  }

  /** 该接口是否出现在合并冲突里（界面据此标红）。 */
  public isConflicted(interfaceFullName: string): boolean {
    return this.conflictedInterfaces.has(interfaceFullName);
  }
}

export interface DebugContractLoadOptions {
  /** VisualBridge Project 根（绝对路径）；每个根单独定位，不共享猜测结果。 */
  readonly projectRoots: readonly string[];
  /** 补充/覆盖目录（绝对路径）；调用方负责把工作区相对路径解析成绝对路径。 */
  readonly supplementalDirectories?: readonly string[];
}

interface ParsedContractFile {
  readonly directory: string;
  readonly file: string;
  readonly contractHash: string;
  readonly schemaVersion: number;
  readonly interfaces: readonly ParsedInterface[];
}

interface ParsedInterface {
  readonly fullName: string;
  readonly category: string;
  readonly interfaceId: string;
  readonly canonical: string;
  readonly methods: readonly DebugContractMethod[];
}

interface SourceParseResult {
  readonly parsed: ParsedContractFile | undefined;
  readonly skips: readonly DebugContractSkip[];
}

/**
 * 契约注册表。一次 {@link load} 会重新定位全部 Project 根并产出新快照；
 * 旧快照对象不变（持有它的调用方按旧契约展示，C.8）。
 */
export class DebugContractRegistry {
  private readonly warnedDirectories = new Set<string>();
  private currentValue: DebugContractSnapshotSet = EMPTY_DEBUG_CONTRACT_SNAPSHOT_SET;

  public get current(): DebugContractSnapshotSet {
    return this.currentValue;
  }

  /** 重新定位并加载；返回的新快照集合同时成为 {@link current}。 */
  public async load(options: DebugContractLoadOptions): Promise<DebugContractSnapshotSet> {
    const warnings: DebugContractWarning[] = [];
    const supplementalDirectories = [...new Set(options.supplementalDirectories ?? [])]
      .map((directory) => nodePath.resolve(directory))
      .sort(compareText);

    // 补充目录与 Unity 工程无关：只解析一次，再按 Project 根合并。
    const supplementalSources: ParsedContractFile[] = [];
    const supplementalSkips: DebugContractSkip[] = [];
    for (const directory of supplementalDirectories) {
      const files = await findContractFiles(directory);
      if (files === undefined) {
        this.warnOnce(warnings, directory, `Contract directory '${directory}' does not exist.`);
        supplementalSkips.push({ directory, reason: "missing", detail: "Directory does not exist." });
        continue;
      }

      if (files.length === 0) {
        this.warnOnce(warnings, directory, `Contract directory '${directory}' has no ${DEBUG_CONTRACTS_FILE_NAME}.`);
        supplementalSkips.push({
          directory,
          reason: "missing",
          detail: `No ${DEBUG_CONTRACTS_FILE_NAME} found below this directory.`,
        });
        continue;
      }

      for (const file of files) {
        const result = await parseContractFile(file);
        supplementalSkips.push(...result.skips);
        if (result.parsed !== undefined) {
          supplementalSources.push(result.parsed);
        }
      }
    }

    const byProjectRoot = new Map<string, DebugContractSnapshot>();
    const snapshots: DebugContractSnapshot[] = [];
    const snapshotByUnityRoot = new Map<string, DebugContractSnapshot>();

    for (const projectRootValue of options.projectRoots) {
      const projectRoot = nodePath.resolve(projectRootValue);
      const unityRoot = await findUnityProjectRoot(projectRoot);
      const cacheKey = unityRoot === undefined ? `project:${projectRoot}` : `unity:${unityRoot}`;
      const cached = snapshotByUnityRoot.get(cacheKey);
      if (cached !== undefined) {
        byProjectRoot.set(projectRoot, cached);
        continue;
      }

      const snapshot = await this.loadSnapshot(
        projectRoot,
        unityRoot,
        supplementalSources,
        supplementalSkips,
        warnings,
      );
      snapshotByUnityRoot.set(cacheKey, snapshot);
      byProjectRoot.set(projectRoot, snapshot);
      if (!snapshots.includes(snapshot)) {
        snapshots.push(snapshot);
      }
    }

    const hashes = [...new Set(snapshots.map((snapshot) => snapshot.contractHash).filter((hash) => hash.length > 0))]
      .sort(compareText);
    const set: DebugContractSnapshotSet = {
      snapshots,
      byProjectRoot,
      hashes,
      snapshotForHash: (contractHash: string) => {
        if (contractHash.length === 0) {
          return undefined;
        }

        return snapshots.find((snapshot) => snapshot.contractHash === contractHash);
      },
      warnings,
    };
    this.currentValue = set;
    return set;
  }

  private async loadSnapshot(
    projectRoot: string,
    unityRoot: string | undefined,
    supplementalSources: readonly ParsedContractFile[],
    supplementalSkips: readonly DebugContractSkip[],
    warnings: DebugContractWarning[],
  ): Promise<DebugContractSnapshot> {
    const skipped: DebugContractSkip[] = [...supplementalSkips];
    let primary: ParsedContractFile | undefined;
    let primarySkip: DebugContractSkip | undefined;
    if (unityRoot !== undefined) {
      // 不在 Unity 工程里时没有约定路径可推导，只可能靠补充目录。
      const artifactsRoot = await resolveArtifactsRoot(unityRoot);
      if (artifactsRoot.invalid !== undefined) {
        // 显式值非法不能变成"改了配置反而没契约"：回退 D2 默认路径继续加载，并把回退记成
        // 可见的 skip（§A.8 没规定非法值行为，这里取"更宽容 + 可见"）。
        skipped.push({
          directory: unityRoot,
          reason: "artifactsRoot",
          detail: `VisualBridgeDebugConfig.ArtifactsRoot '${artifactsRoot.invalid}' is not a project-relative directory; falling back to '${artifactsRoot.value}'.`,
        });
        this.warnOnce(
          warnings,
          unityRoot,
          `VisualBridgeDebugConfig.ArtifactsRoot '${artifactsRoot.invalid}' is not a project-relative directory; using '${artifactsRoot.value}' instead.`,
        );
      }

      const directory = nodePath.join(unityRoot, ...artifactsRoot.value.split("/"));
      const file = nodePath.join(directory, DEBUG_CONTRACTS_FILE_NAME);
      if (await exists(file)) {
        const result = await parseContractFile(file);
        skipped.push(...result.skips);
        primary = result.parsed;
      } else {
        this.warnOnce(
          warnings,
          directory,
          `Unity project '${unityRoot}' has no ${DEBUG_CONTRACTS_FILE_NAME} under '${artifactsRoot.value}'.`,
        );
        primarySkip = {
          directory,
          reason: "missing",
          detail: `No ${DEBUG_CONTRACTS_FILE_NAME} in the conventional ArtifactsRoot.`,
        };
      }
    }

    if (primarySkip !== undefined) {
      skipped.push(primarySkip);
    }

    const supplemental = supplementalSources.map((source) => sourceInfoOf(source, "supplemental"));
    const conflicts: DebugContractConflict[] = [];
    const methods: DebugContractMethod[] = [];
    // 合并键有两个（C.8）：接口全名决定整接口去留，(category, methodId) 决定单方法归属。
    // 主来源先认领两者；补充来源命中已认领的方法号一律跳过并记 method 级冲突，
    // 绝不静默顶替主来源（否则客户端按主来源指纹协商到 binary 却按补充声明解码 = 静默错解）。
    const claimedInterfaces = new Map<string, { readonly contractInterface: ParsedInterface; readonly source: ParsedContractFile }>();
    const claimedMethods = new Map<string, { readonly method: DebugContractMethod; readonly source: ParsedContractFile }>();

    const claimInterface = (contractInterface: ParsedInterface, source: ParsedContractFile): void => {
      claimedInterfaces.set(contractInterface.fullName, { contractInterface, source });
      for (const method of contractInterface.methods) {
        claimedMethods.set(methodKey(method.category, method.methodId), { method, source });
        methods.push(method);
      }
    };

    if (primary !== undefined) {
      for (const contractInterface of primary.interfaces) {
        claimInterface(contractInterface, primary);
      }
    }

    for (const source of supplementalSources) {
      for (const contractInterface of source.interfaces) {
        const existing = claimedInterfaces.get(contractInterface.fullName);
        if (existing !== undefined) {
          if (existing.contractInterface.canonical === contractInterface.canonical) {
            // 内容等价的补充声明不算冲突，也不重复登记。
            continue;
          }

          conflicts.push({
            kind: "interface",
            key: contractInterface.fullName,
            detail: `Interface '${contractInterface.fullName}' differs between '${existing.source.directory}' and '${source.directory}'; the earlier source wins.`,
            primaryDirectory: existing.source.directory,
            supplementalDirectory: source.directory,
          });
          continue;
        }

        // 新接口：逐方法认领 (category, methodId)，被先到者认领的方法跳过并记冲突。
        const acceptedMethods: DebugContractMethod[] = [];
        for (const method of contractInterface.methods) {
          const key = methodKey(method.category, method.methodId);
          const owner = claimedMethods.get(key);
          if (owner !== undefined) {
            conflicts.push({
              kind: "method",
              key: `${method.category}#${method.methodId}`,
              detail: `Method '${method.interfaceFullName}.${method.name}' (${method.category}#${method.methodId}) collides with '${owner.method.interfaceFullName}.${owner.method.name}' from '${owner.source.directory}'; the earlier declaration wins.`,
              primaryDirectory: owner.source.directory,
              supplementalDirectory: source.directory,
              category: method.category,
              methodId: method.methodId,
            });
            continue;
          }

          claimedMethods.set(key, { method, source });
          acceptedMethods.push(method);
        }

        claimedInterfaces.set(contractInterface.fullName, { contractInterface, source });
        methods.push(...acceptedMethods);
      }
    }

    const contractHash = primary?.contractHash ?? supplementalSources[0]?.contractHash ?? "";
    const schemaVersion = primary?.schemaVersion ?? supplementalSources[0]?.schemaVersion;
    return new DebugContractSnapshot({
      unityRoot,
      primary: primary === undefined ? undefined : sourceInfoOf(primary, "primary"),
      supplemental,
      conflicts,
      skipped: dedupeSkips(skipped),
      methods: sortMethods(methods),
      contractHash,
      schemaVersion,
    });
  }

  private warnOnce(warnings: DebugContractWarning[], directory: string, message: string): void {
    const key = nodePath.resolve(directory);
    if (this.warnedDirectories.has(key)) {
      return;
    }

    this.warnedDirectories.add(key);
    warnings.push({ directory: key, message });
  }
}

function sourceInfoOf(source: ParsedContractFile, role: "primary" | "supplemental"): DebugContractSourceInfo {
  return {
    directory: source.directory,
    file: source.file,
    contractHash: source.contractHash,
    schemaVersion: source.schemaVersion,
    interfaces: source.interfaces.length,
    methods: source.interfaces.reduce((total, entry) => total + entry.methods.length, 0),
    role,
  };
}

function dedupeSkips(skips: readonly DebugContractSkip[]): readonly DebugContractSkip[] {
  const seen = new Set<string>();
  const result: DebugContractSkip[] = [];
  for (const skip of skips) {
    const key = `${skip.directory}\u0000${skip.reason}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(skip);
  }

  return result.sort((left, right) => compareText(left.directory, right.directory) || compareText(left.reason, right.reason));
}

function sortMethods(methods: readonly DebugContractMethod[]): readonly DebugContractMethod[] {
  return [...methods].sort(
    (left, right) => compareText(left.category, right.category)
      || left.methodId - right.methodId
      || compareText(left.name, right.name),
  );
}

/** 从 Project 根向上找 Unity 工程根（`ProjectSettings/ProjectVersion.txt`）。 */
export async function findUnityProjectRoot(projectRoot: string): Promise<string | undefined> {
  let cursor = nodePath.resolve(projectRoot);
  for (let depth = 0; depth < 16; depth += 1) {
    if (await exists(nodePath.join(cursor, ...UNITY_PROJECT_MARKER.split("/")))) {
      return cursor;
    }

    const parent = nodePath.dirname(cursor);
    if (parent === cursor) {
      return undefined;
    }

    cursor = parent;
  }

  return undefined;
}

/**
 * 解析 Unity 工程根的 `ArtifactsRoot`：显式值来自 `VisualBridgeDebugConfig.asset`，
 * 缺失或空串回落到 D2 默认值（附录 A.8 的 `""`）。
 */
export async function resolveArtifactsRoot(
  unityRoot: string,
): Promise<{ readonly value: string; readonly invalid?: string }> {
  const configFiles = await walkForFile(nodePath.join(unityRoot, "Assets"), DEBUG_CONFIG_ASSET_NAME, 8);
  const configFile = selectDebugConfigFile(configFiles);
  if (configFile !== undefined) {
    let text: string | undefined;
    try {
      text = await fs.readFile(configFile, "utf8");
    } catch {
      text = undefined;
    }

    if (text !== undefined) {
      // ScriptableObject 的序列化字段是单行 `artifactsRoot: <值>`；不解析其余 YAML。
      const match = /^\s*artifactsRoot:\s*(.*)$/mu.exec(text);
      const raw = match?.[1]?.trim().replace(/^['"]|['"]$/gu, "") ?? "";
      if (raw.length > 0) {
        const normalized = normalizeProjectRelativePath(raw);
        if (normalized === undefined) {
          return { value: DEBUG_ARTIFACTS_ROOT_DEFAULT, invalid: raw };
        }

        return { value: normalized };
      }
    }
  }

  return { value: DEBUG_ARTIFACTS_ROOT_DEFAULT };
}

/**
 * 多个 `VisualBridgeDebugConfig.asset` 时取**排序首个**（与 D2 的 `LoadOrDefault` 同序）：
 * `walkForFile` 的产出顺序由文件系统决定，不能当选择依据。
 */
export function selectDebugConfigFile(files: readonly string[]): string | undefined {
  return [...files].sort(compareText)[0];
}

/** 工程相对目录：正斜杠、无盘符/绝对前缀、无 `.`/`..` 段（B.5 要求产物在工程内）。 */
export function normalizeProjectRelativePath(value: string): string | undefined {
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/+$/u, "");
  if (normalized.length === 0 || normalized.startsWith("/") || /^[A-Za-z]:/u.test(normalized)) {
    return undefined;
  }

  if (normalized.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    return undefined;
  }

  return normalized;
}

/** 递归查找目录下的 `debug-contracts.json`；目录不存在返回 undefined。 */
async function findContractFiles(directory: string): Promise<readonly string[] | undefined> {
  if (!(await isDirectory(directory))) {
    return undefined;
  }

  const files = await walkForFile(directory, DEBUG_CONTRACTS_FILE_NAME, 8);
  return [...files].sort(compareText);
}

const SKIPPED_DIRECTORY_NAMES = new Set([
  ".git",
  ".vs",
  "Library",
  "Logs",
  "Temp",
  "UserSettings",
  "bin",
  "node_modules",
  "obj",
  "target",
]);
const MAX_WALK_ENTRIES = 20_000;

/** 有界广度优先查找（跳过构建产物体积大户），返回匹配文件的绝对路径。 */
async function walkForFile(root: string, fileName: string, maxDepth: number): Promise<readonly string[]> {
  const matches: string[] = [];
  let queue: Array<{ readonly directory: string; readonly depth: number }> = [{ directory: root, depth: 0 }];
  let inspected = 0;
  while (queue.length > 0) {
    const next: Array<{ readonly directory: string; readonly depth: number }> = [];
    for (const entry of queue) {
      inspected += 1;
      if (inspected > MAX_WALK_ENTRIES) {
        return matches;
      }

      let entries;
      try {
        entries = await fs.readdir(entry.directory, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const child of entries) {
        const childPath = nodePath.join(entry.directory, child.name);
        if (child.isDirectory()) {
          if (entry.depth + 1 > maxDepth || SKIPPED_DIRECTORY_NAMES.has(child.name)) {
            continue;
          }

          next.push({ directory: childPath, depth: entry.depth + 1 });
          continue;
        }

        if (child.isFile() && child.name === fileName) {
          matches.push(childPath);
        }
      }
    }

    queue = next;
  }

  return matches;
}

async function parseContractFile(file: string): Promise<SourceParseResult> {
  const directory = nodePath.dirname(file);
  const skipped = (reason: DebugContractSkipReason, detail: string): SourceParseResult => ({
    parsed: undefined,
    skips: [{ directory, reason, detail }],
  });

  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (errorValue) {
    return skipped("unreadable", `Unable to read '${file}': ${String(errorValue)}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (errorValue) {
    return skipped("malformed", `'${file}' is not valid JSON: ${String(errorValue)}`);
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return skipped("malformed", `'${file}' must contain a JSON object.`);
  }

  const record = value as Record<string, unknown>;
  const manifest = record.manifest;
  const schemaVersion = typeof manifest === "object" && manifest !== null && !Array.isArray(manifest)
    ? (manifest as Record<string, unknown>).schemaVersion
    : undefined;
  if (schemaVersion !== BRIDGE_CONTRACT_SCHEMA_VERSION) {
    // 契约层拒绝（附录 A.3）：schemaVersion 不等时该目录的契约整体不加载。
    return skipped(
      "schemaVersion",
      `Expected manifest.schemaVersion ${BRIDGE_CONTRACT_SCHEMA_VERSION}, received ${String(schemaVersion)}.`,
    );
  }

  const contractHash = record.contractHash;
  if (typeof contractHash !== "string" || !/^[0-9a-f]{16}$/u.test(contractHash)) {
    return skipped("contractHash", `Expected a 16-character lowercase hex contractHash, received ${String(contractHash)}.`);
  }

  const enums = readEnums(record.enums);
  if (enums === undefined) {
    return skipped("malformed", "'enums' must be an array of { name, underlyingType } entries.");
  }

  const rawCategories = record.categories;
  if (rawCategories !== undefined && !Array.isArray(rawCategories)) {
    return skipped("malformed", "'categories' must be an array.");
  }

  const interfaces: ParsedInterface[] = [];
  for (const rawCategory of (rawCategories ?? []) as readonly unknown[]) {
    if (typeof rawCategory !== "object" || rawCategory === null || Array.isArray(rawCategory)) {
      return skipped("malformed", "Every category must be an object.");
    }

    const category = rawCategory as Record<string, unknown>;
    const categoryName = category.name;
    if (typeof categoryName !== "string" || categoryName.length === 0) {
      return skipped("malformed", "Every category requires a non-empty 'name'.");
    }

    const rawInterfaces = category.interfaces;
    if (rawInterfaces !== undefined && !Array.isArray(rawInterfaces)) {
      return skipped("malformed", `Category '${categoryName}' has a non-array 'interfaces'.`);
    }

    for (const rawInterface of (rawInterfaces ?? []) as readonly unknown[]) {
      const parsed = readInterface(rawInterface, categoryName, enums);
      if (typeof parsed === "string") {
        return skipped("malformed", `Category '${categoryName}': ${parsed}`);
      }

      interfaces.push(parsed);
    }
  }

  return {
    parsed: { directory, file, contractHash, schemaVersion, interfaces },
    skips: [],
  };
}

function readEnums(value: unknown): ReadonlyMap<string, DebugContractEnumWidth> | undefined {
  if (value === undefined) {
    return new Map<string, DebugContractEnumWidth>();
  }

  if (!Array.isArray(value)) {
    return undefined;
  }

  const enums = new Map<string, DebugContractEnumWidth>();
  for (const rawEnum of value as readonly unknown[]) {
    if (typeof rawEnum !== "object" || rawEnum === null || Array.isArray(rawEnum)) {
      return undefined;
    }

    const record = rawEnum as Record<string, unknown>;
    const name = record.name;
    const underlyingType = record.underlyingType;
    if (typeof name !== "string" || name.length === 0 || typeof underlyingType !== "string") {
      return undefined;
    }

    const width = ENUM_UNDERLYING_WIDTHS.get(underlyingType);
    if (width !== undefined) {
      enums.set(name, width);
    }
  }

  return enums;
}

function readInterface(
  value: unknown,
  categoryName: string,
  enums: ReadonlyMap<string, DebugContractEnumWidth>,
): ParsedInterface | string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "every interface must be an object.";
  }

  const record = value as Record<string, unknown>;
  const interfaceId = record.name;
  if (typeof interfaceId !== "string" || interfaceId.length === 0) {
    return "every interface requires a non-empty 'name'.";
  }

  const fullName = typeof record.fullName === "string" && record.fullName.length > 0 ? record.fullName : interfaceId;
  const kind = typeof record.kind === "string" && record.kind.length > 0 ? record.kind : "Event";
  const rawMethods = record.methods;
  if (rawMethods !== undefined && !Array.isArray(rawMethods)) {
    return `interface '${interfaceId}' has a non-array 'methods'.`;
  }

  const methods: DebugContractMethod[] = [];
  for (const rawMethod of (rawMethods ?? []) as readonly unknown[]) {
    const parsed = readMethod(rawMethod, categoryName, interfaceId, fullName, kind, enums);
    if (typeof parsed === "string") {
      return `interface '${interfaceId}': ${parsed}`;
    }

    methods.push(parsed);
  }

  return {
    fullName,
    category: categoryName,
    interfaceId,
    canonical: canonicalJson(record),
    methods,
  };
}

function readMethod(
  value: unknown,
  categoryName: string,
  interfaceId: string,
  interfaceFullName: string,
  kind: string,
  enums: ReadonlyMap<string, DebugContractEnumWidth>,
): DebugContractMethod | string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "every method must be an object.";
  }

  const record = value as Record<string, unknown>;
  const name = record.name;
  const methodId = record.id;
  if (typeof name !== "string" || name.length === 0) {
    return "every method requires a non-empty 'name'.";
  }

  if (typeof methodId !== "number" || !Number.isInteger(methodId) || methodId < 1 || methodId > 0xffff) {
    return `method '${name}' has an invalid 'id'.`;
  }

  const rawParameters = record.parameters;
  if (rawParameters !== undefined && !Array.isArray(rawParameters)) {
    return `method '${name}' has a non-array 'parameters'.`;
  }

  const parameters: DebugContractParameter[] = [];
  for (const rawParameter of (rawParameters ?? []) as readonly unknown[]) {
    if (typeof rawParameter !== "object" || rawParameter === null || Array.isArray(rawParameter)) {
      return `method '${name}' has a non-object parameter.`;
    }

    const parameter = rawParameter as Record<string, unknown>;
    const role = typeof parameter.role === "string" ? parameter.role : "payload";
    if (role !== "payload") {
      // 实例参数与请求句柄不进入载荷，也就没有二进制 tag（B.5）。
      continue;
    }

    const parameterName = parameter.name;
    const declaredType = parameter.type;
    const tag = parameter.tag;
    if (typeof parameterName !== "string" || parameterName.length === 0) {
      return `method '${name}' has a payload parameter without a 'name'.`;
    }

    if (typeof declaredType !== "string" || declaredType.length === 0) {
      return `method '${name}' parameter '${parameterName}' has no 'type'.`;
    }

    if (typeof tag !== "number" || !Number.isInteger(tag) || tag < 1 || tag > 0xffff) {
      return `method '${name}' parameter '${parameterName}' has an invalid 'tag'.`;
    }

    parameters.push({
      tag,
      name: parameterName,
      declaredType,
      ...describeContractType(declaredType, enums),
      optional: parameter.optional === true,
    });
  }

  const result = readResultParameter(record.result, enums);
  if (typeof result === "string") {
    return `method '${name}': ${result}`;
  }

  return {
    category: categoryName,
    interfaceId,
    interfaceFullName,
    name,
    methodId,
    kind,
    parameters: parameters.sort((left, right) => left.tag - right.tag),
    result,
  };
}

function readResultParameter(
  value: unknown,
  enums: ReadonlyMap<string, DebugContractEnumWidth>,
): DebugContractParameter | undefined | string {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "'result' must be an object.";
  }

  const record = value as Record<string, unknown>;
  const name = record.name;
  const declaredType = record.type;
  const tag = record.tag;
  if (typeof name !== "string" || name.length === 0 || typeof declaredType !== "string" || declaredType.length === 0) {
    return "'result' requires 'name' and 'type'.";
  }

  if (typeof tag !== "number" || !Number.isInteger(tag) || tag < 0 || tag > 0xffff) {
    return "'result' requires a valid 'tag'.";
  }

  return {
    tag,
    name,
    declaredType,
    ...describeContractType(declaredType, enums),
    optional: false,
  };
}

function describeContractType(
  declaredType: string,
  enums: ReadonlyMap<string, DebugContractEnumWidth>,
): { readonly wireType: DebugContractWireType; readonly enumName: string | undefined; readonly enumWidth: DebugContractEnumWidth | undefined } {
  const primitive = PRIMITIVE_WIRE_TYPES.get(declaredType);
  if (primitive !== undefined) {
    return { wireType: primitive, enumName: undefined, enumWidth: undefined };
  }

  // 契约里非基元的声明类型就是枚举完整名（B.5）；宽度来自 enums.underlyingType。
  return { wireType: "enum", enumName: declaredType, enumWidth: enums.get(declaredType) };
}

const PRIMITIVE_WIRE_TYPES = new Map<string, DebugContractWireType>([
  ["bool", "bool"],
  ["sbyte", "int"],
  ["byte", "int"],
  ["short", "int"],
  ["ushort", "int"],
  ["int", "int"],
  ["uint", "long"],
  ["long", "long"],
  ["ulong", "ulong"],
  ["float", "float"],
  ["double", "double"],
  ["string", "string"],
  ["byte[]", "byte[]"],
]);

const ENUM_UNDERLYING_WIDTHS = new Map<string, DebugContractEnumWidth>([
  ["sbyte", 1],
  ["byte", 1],
  ["short", 2],
  ["ushort", 2],
  ["int", 4],
  ["uint", 4],
  ["long", 8],
  ["ulong", 8],
]);

function methodKey(category: string, methodId: number): string {
  return `${category}\u0000${methodId}`;
}

function methodNameKey(category: string, interfaceId: string, method: string): string {
  return `${category}\u0000${interfaceId}\u0000${method}`;
}

/** 稳定序列化：键排序后拼串，用于判断两份声明是否等价。 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }

  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort(compareText);
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }

  return JSON.stringify(value) ?? "null";
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function exists(candidatePath: string): Promise<boolean> {
  try {
    await fs.stat(candidatePath);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(candidatePath: string): Promise<boolean> {
  try {
    return (await fs.stat(candidatePath)).isDirectory();
  } catch {
    return false;
  }
}
