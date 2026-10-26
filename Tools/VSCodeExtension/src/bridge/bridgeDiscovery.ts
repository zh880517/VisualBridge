/**
 * 发现记录 v2 的文件层（附录 A.7）：原子写、mtime 心跳与陈旧判定。
 *
 * 记录由监听方写入 `<temp>/visualbridge-bridge/<windowId>.json`；读取方把
 * formatVersion 不符、心跳超过 5 秒、pid 已死的记录一律视为"无记录"，
 * 因此客户端最终只会报 `runtime.noEndpoint`。
 */
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  BRIDGE_DISCOVERY_FORMAT_VERSION,
  BRIDGE_HEARTBEAT_TIMEOUT_MS,
  BridgeDiscoveryRecord,
  BridgeProtocolError,
  parseDiscoveryRecord,
} from "./bridgeProtocol";

export interface BridgeDiscoveryEnvironment {
  readonly now?: () => number;
  readonly isProcessAlive?: (pid: number) => boolean;
}

export interface BridgeLiveDiscoveryRecord {
  readonly record: BridgeDiscoveryRecord;
  readonly recordPath: string;
  readonly heartbeatAgeMs: number;
}

export type BridgeDiscoveryProbe =
  | ({ readonly status: "live" } & BridgeLiveDiscoveryRecord)
  | { readonly status: "missing"; readonly recordPath: string }
  | { readonly status: "invalid"; readonly recordPath: string; readonly code: string; readonly detail: string }
  | { readonly status: "unsupported"; readonly recordPath: string; readonly code: string; readonly detail: string }
  | {
      readonly status: "stale";
      readonly recordPath: string;
      readonly code: "runtime.staleRecord" | "runtime.stalePid";
      readonly detail: string;
      readonly record?: BridgeDiscoveryRecord;
    };

/** 客户端本地错误：端口段内没有可握手端点（附录 A.6）。 */
export class BridgeDiscoveryError extends Error {
  public constructor(
    public readonly code: "runtime.noEndpoint",
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "BridgeDiscoveryError";
  }
}

export function discoveryRecordPath(directory: string, windowId: string): string {
  return path.join(directory, `${windowId}.json`);
}

/**
 * 原子发布：先写同目录临时文件，再 rename 覆盖正式记录。
 * 读取方要么看到旧记录，要么看到完整新记录，不会读到半份 JSON。
 */
export async function writeDiscoveryRecordAtomically(
  recordPath: string,
  record: BridgeDiscoveryRecord,
): Promise<void> {
  const directory = path.dirname(recordPath);
  await fs.mkdir(directory, { recursive: true });
  // 每次写用独立临时名：并发写不会互相截断；rename 保证读方只看到完整记录。
  const temporaryPath = `${recordPath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(record)}\n`, "utf8");
  try {
    await renameWithRetry(temporaryPath, recordPath);
  } catch (errorValue) {
    await fs.unlink(temporaryPath).catch(() => undefined);
    throw errorValue;
  }
}

/** Windows 上并发 rename 可能短暂 EPERM/EBUSY（读方或杀毒软件持有句柄），退避重试。 */
async function renameWithRetry(source: string, target: string): Promise<void> {
  const retryable = new Set(["EPERM", "EBUSY", "EACCES"]);
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(source, target);
      return;
    } catch (errorValue) {
      const code = (errorValue as NodeJS.ErrnoException).code ?? "";
      if (!retryable.has(code) || attempt >= 8) {
        throw errorValue;
      }

      await new Promise<void>((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
}

/** 心跳 = 更新记录 mtime；内容不动，避免无意义的整文件重写。 */
export async function touchDiscoveryRecord(recordPath: string): Promise<void> {
  const now = new Date();
  await fs.utimes(recordPath, now, now);
}

/** 读取并判定单条记录；任何"不可用"原因都收敛为明确的 probe 状态。 */
export async function probeDiscoveryRecord(
  recordPath: string,
  environment: BridgeDiscoveryEnvironment = {},
): Promise<BridgeDiscoveryProbe> {
  let text: string;
  let mtimeMs: number;
  try {
    [text, mtimeMs] = await Promise.all([
      fs.readFile(recordPath, "utf8"),
      fs.stat(recordPath).then((stats) => stats.mtimeMs),
    ]);
  } catch {
    return { status: "missing", recordPath };
  }

  let record: BridgeDiscoveryRecord;
  try {
    record = parseDiscoveryRecord(JSON.parse(text));
  } catch (errorValue) {
    if (errorValue instanceof BridgeProtocolError) {
      if (errorValue.code === "bridge.unsupportedFormatVersion") {
        return { status: "unsupported", recordPath, code: errorValue.code, detail: errorValue.message };
      }

      return { status: "invalid", recordPath, code: errorValue.code, detail: errorValue.message };
    }

    return {
      status: "invalid",
      recordPath,
      code: "bridge.invalidJson",
      detail: errorValue instanceof Error ? errorValue.message : String(errorValue),
    };
  }

  const now = environment.now ?? Date.now;
  const isProcessAlive = environment.isProcessAlive ?? defaultIsProcessAlive;
  const heartbeatAgeMs = now() - mtimeMs;
  if (heartbeatAgeMs > BRIDGE_HEARTBEAT_TIMEOUT_MS) {
    return {
      status: "stale",
      recordPath,
      code: "runtime.staleRecord",
      detail: `Discovery heartbeat is ${Math.round(heartbeatAgeMs)} ms old.`,
      record,
    };
  }

  if (!isProcessAlive(record.pid)) {
    return {
      status: "stale",
      recordPath,
      code: "runtime.stalePid",
      detail: `Discovery publisher pid ${record.pid} is no longer running.`,
      record,
    };
  }

  return { status: "live", record, recordPath, heartbeatAgeMs };
}

/**
 * 枚举目录中的存活记录。格式不符、心跳过期与死 pid 都直接忽略；
 * `onSkipped` 只用于诊断输出。
 */
export async function enumerateDiscoveryRecords(
  directory: string,
  environment: BridgeDiscoveryEnvironment = {},
  onSkipped?: (probe: BridgeDiscoveryProbe) => void,
): Promise<BridgeLiveDiscoveryRecord[]> {
  let entries: readonly string[];
  try {
    entries = await fs.readdir(directory);
  } catch {
    return [];
  }

  const live: BridgeLiveDiscoveryRecord[] = [];
  for (const entry of [...entries].sort()) {
    if (!entry.endsWith(".json")) {
      continue;
    }

    const probe = await probeDiscoveryRecord(path.join(directory, entry), environment);
    if (probe.status === "live") {
      live.push({ record: probe.record, recordPath: probe.recordPath, heartbeatAgeMs: probe.heartbeatAgeMs });
      continue;
    }

    if (probe.status !== "missing") {
      onSkipped?.(probe);
    }
  }

  return live.sort((left, right) => left.recordPath.localeCompare(right.recordPath));
}

/**
 * 取唯一可握手的端点；无存活记录（含全部陈旧）时抛 `runtime.noEndpoint`。
 * `accept` 用于按 role/projectRoots 等业务条件再筛选。
 */
export async function requireDiscoveryEndpoint(
  directory: string,
  environment: BridgeDiscoveryEnvironment = {},
  accept: (record: BridgeDiscoveryRecord) => boolean = () => true,
  onSkipped?: (probe: BridgeDiscoveryProbe) => void,
): Promise<BridgeLiveDiscoveryRecord> {
  const live = (await enumerateDiscoveryRecords(directory, environment, onSkipped))
    .filter((entry) => accept(entry.record));
  if (live.length === 0) {
    throw new BridgeDiscoveryError("runtime.noEndpoint", `No live bridge endpoint in '${directory}'.`);
  }

  if (live.length > 1) {
    throw new BridgeDiscoveryError(
      "runtime.noEndpoint",
      `${live.length} live bridge endpoints in '${directory}'; the caller must select one.`,
    );
  }

  return live[0]!;
}

export function formatBridgeDiscoveryRecord(record: BridgeDiscoveryRecord): string {
  return `${JSON.stringify(record)}\n`;
}

/** 写入方自检：序列化后的记录必须能被同一格式版本重新解析。 */
export function assertDiscoveryRecordRoundTrips(record: BridgeDiscoveryRecord): void {
  if (record.formatVersion !== BRIDGE_DISCOVERY_FORMAT_VERSION) {
    throw new BridgeProtocolError(
      "bridge.unsupportedFormatVersion",
      "$.formatVersion",
      `Expected formatVersion ${BRIDGE_DISCOVERY_FORMAT_VERSION}.`,
    );
  }

  parseDiscoveryRecord(JSON.parse(formatBridgeDiscoveryRecord(record)));
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (errorValue) {
    return (errorValue as NodeJS.ErrnoException).code === "EPERM";
  }
}
