/**
 * 模块装载授权（附录 D.6）。
 *
 * 只有三个来源参与判定，Tool 参数无法提权：
 * 1. `VISUALBRIDGE_MODULES_ENABLED` 环境变量（只接受 `0` / `1` / 未设置）；
 * 2. Project File 的 `modules[]` 声明；
 * 3. 模块 entry 的 realpath 必须落在 `VISUALBRIDGE_WORKSPACE` 内（拒绝 junction/symlink 逃逸）。
 *
 * 与 Provider 授权相互独立：模块授权失败只影响该 editor 的领域请求。
 */
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { DocumentDiagnostic, ProjectModuleDefinition } from "@visualbridge/core";
import type { ProjectContext } from "./projectWorkspace.js";

export const MODULES_ENABLED_ENVIRONMENT_VARIABLE = "VISUALBRIDGE_MODULES_ENABLED";

export type ModuleStatus = "loaded" | "failed" | "untrusted" | "disabled";

/** 一个已声明模块的装载结果；`disabled` 表示模块平台整体关闭（此时不校验 entry）。 */
export interface ModuleEntryReport {
  readonly id: string;
  readonly entry: string;
  readonly status: ModuleStatus;
  readonly version?: string;
  readonly sha256?: string;
  readonly editors: readonly string[];
  readonly diagnostics: readonly DocumentDiagnostic[];
}

/** 解析环境变量；非法取值在启动期直接失败，避免"看起来开着其实没开"。 */
export function readModulesEnabled(environment: NodeJS.ProcessEnv): boolean {
  const raw = environment[MODULES_ENABLED_ENVIRONMENT_VARIABLE];
  if (raw === undefined || raw === "" || raw === "0") return false;
  if (raw === "1") return true;
  throw new Error(
    `${MODULES_ENABLED_ENVIRONMENT_VARIABLE} must be '0', '1' or unset; got '${raw}'.`,
  );
}

export type ModuleEntryVerification =
  | { readonly status: "loaded"; readonly sha256?: string; readonly diagnostics: readonly DocumentDiagnostic[] }
  | { readonly status: "failed" | "untrusted"; readonly diagnostics: readonly DocumentDiagnostic[] };

/**
 * 校验模块 entry 的物理位置与可选 Hash。
 *
 * C1 之前模块以进程内 facet 形式登记，entry bundle 可能尚未生成；缺失 entry 视为"待构建"，
 * 不阻止装载，也不提供 `sha256`。一旦 entry 存在，就必须同时满足工作区包含与 Hash 一致：
 * 存在但不可读（例如 entry 是目录）是**失败**而不是"待构建"，否则"目录 junction 逃逸"
 * 会被 readFile 的 EISDIR 掩盖成 `loaded`。
 */
export async function verifyModuleEntry(
  project: ProjectContext,
  moduleDefinition: ProjectModuleDefinition,
  workspaceRoot: string,
): Promise<ModuleEntryVerification> {
  const trustedRoot = await workspaceRealPath(workspaceRoot);
  const lexical = path.resolve(project.projectRoot, ...moduleDefinition.entry.split("/"));
  const lexicalIssue = containmentIssue(project, moduleDefinition, trustedRoot, lexical, "entry");
  if (lexicalIssue !== undefined) {
    return { status: "untrusted", diagnostics: [lexicalIssue] };
  }
  let resolved: string;
  try {
    resolved = await realpath(lexical);
  } catch (errorValue) {
    if (isMissingPath(errorValue)) {
      // entry 尚未生成（C1 才产出 bundle）：进程内 facet 仍可用，只报告"无 sha256"。
      return { status: "loaded", diagnostics: [] };
    }
    return { status: "failed", diagnostics: [entryUnreadable(moduleDefinition, lexical, errorValue)] };
  }
  // 别名判定必须与真实根比较：workspace 本身可能就是 junction（例如托管测试的工作区夹具）。
  const resolvedIssue = containmentIssue(project, moduleDefinition, trustedRoot, resolved, "entryRealPath");
  if (resolvedIssue !== undefined) {
    return { status: "untrusted", diagnostics: [resolvedIssue] };
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(resolved);
  } catch (errorValue) {
    return { status: "failed", diagnostics: [entryUnreadable(moduleDefinition, resolved, errorValue)] };
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (moduleDefinition.hash !== undefined && moduleDefinition.hash !== sha256) {
    return {
      status: "failed",
      diagnostics: [{
        severity: "error",
        code: "module.hashMismatch",
        path: `modules.${moduleDefinition.id}.hash`,
        message: `Module '${moduleDefinition.id}' entry Hash does not match the Project declaration.`,
      }],
    };
  }
  return { status: "loaded", sha256, diagnostics: [] };
}

/** `VISUALBRIDGE_WORKSPACE` 自身也可能是别名路径；containment 判定统一用真实路径。 */
async function workspaceRealPath(workspaceRoot: string): Promise<string> {
  try {
    return await realpath(workspaceRoot);
  } catch {
    return path.resolve(workspaceRoot);
  }
}

function isMissingPath(errorValue: unknown): boolean {
  const code = (errorValue as { readonly code?: unknown } | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function entryUnreadable(
  moduleDefinition: ProjectModuleDefinition,
  candidate: string,
  errorValue: unknown,
): DocumentDiagnostic {
  const detail = errorValue instanceof Error ? errorValue.message : String(errorValue);
  return {
    severity: "error",
    code: "module.loadFailed",
    path: `modules.${moduleDefinition.id}.entry`,
    message: `Module '${moduleDefinition.id}' entry '${candidate}' is not a readable file: ${detail}`,
  };
}

function containmentIssue(
  project: ProjectContext,
  moduleDefinition: ProjectModuleDefinition,
  workspaceRoot: string,
  candidate: string,
  field: string,
): DocumentDiagnostic | undefined {
  if (isInside(workspaceRoot, candidate)) return undefined;
  return {
    severity: "error",
    code: "module.entryAlias",
    path: `modules.${moduleDefinition.id}.${field}`,
    message: `Module '${moduleDefinition.id}' entry resolves outside the MCP workspace.`,
  };
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== ""
    && !relative.startsWith("..")
    && !path.isAbsolute(relative)
    && relative.split(path.sep).every((segment) => segment !== "..");
}
