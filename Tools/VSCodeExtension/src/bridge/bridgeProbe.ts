/**
 * 端口段探测（附录 A.8 的 `portRangeStart` / `portRangeEnd` / `probeTimeoutMs` / `probeConcurrency`）。
 *
 * Player 模式由 Unity 监听端口段，VS Code 不知道具体端口：并发探测候选端口，
 * 每个端口跑一次完整握手，**第一个握手成功者胜出**，其余在途尝试立即被 abort。
 * 显式 `host:port` 时只连该端口，绝不扩散到端口段。
 *
 * 本模块只负责调度与取消，不关心协议细节：握手由注入的 `attempt` 完成，
 * 因此调度语义（并发上限、单口超时、首个成功、取消）可以在单测里用假实现逐一验证。
 */

export interface BridgeProbeTarget {
  readonly host: string;
  readonly port: number;
}

export interface BridgeProbeOptions<TValue> {
  /** 监听地址；缺省 127.0.0.1。 */
  readonly host?: string;
  /** 端口段起点（含）；与 `explicitPort` 互斥。 */
  readonly portRangeStart?: number;
  /** 端口段终点（含）。 */
  readonly portRangeEnd?: number;
  /** 显式端口：只连这一个，不扩散。 */
  readonly explicitPort?: number;
  /** 单端口握手超时；缺省 300 ms（A.8）。 */
  readonly timeoutMs?: number;
  /** 并发上限；缺省 8（A.8）。 */
  readonly concurrency?: number;
  /** 对单个端口尝试握手；抛错或超时即视为该端口失败。 */
  readonly attempt: (target: BridgeProbeTarget, timeoutMs: number, signal: AbortSignal) => Promise<TValue>;
}

export type BridgeProbeOutcome<TValue> =
  | {
    readonly ok: true;
    readonly target: BridgeProbeTarget;
    readonly value: TValue;
    /**
     * 本轮**真正开始过**的端口数：含失败者，也含开始后被取消者（取消发生在启动之后，
     * 按启动计数才有意义）。并发上限决定它与端口总数的关系。
     */
    readonly attempts: number;
  }
  | {
    readonly ok: false;
    /** 端口段内没有可握手端点（A.2：客户端本地错误码，不区分禁用/占用/未启动）。 */
    readonly code: "runtime.noEndpoint";
    readonly attempts: number;
    readonly lastError?: Error;
  };

export const DEFAULT_BRIDGE_PROBE_TIMEOUT_MS = 300;
export const DEFAULT_BRIDGE_PROBE_CONCURRENCY = 8;

export async function probeBridgePorts<TValue>(options: BridgeProbeOptions<TValue>): Promise<BridgeProbeOutcome<TValue>> {
  const host = options.host ?? "127.0.0.1";
  const timeoutMs = options.timeoutMs ?? DEFAULT_BRIDGE_PROBE_TIMEOUT_MS;
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_BRIDGE_PROBE_CONCURRENCY);
  const candidates = candidatePorts(options);
  if (candidates.length === 0) {
    return { ok: false, code: "runtime.noEndpoint", attempts: 0 };
  }

  const controller = new AbortController();
  const queue = [...candidates];
  let attempts = 0;
  let lastError: Error | undefined;
  let winner: { readonly target: BridgeProbeTarget; readonly value: TValue } | undefined;

  const worker = async (): Promise<void> => {
    while (!controller.signal.aborted) {
      const port = queue.shift();
      if (port === undefined) {
        return;
      }

      const target: BridgeProbeTarget = { host, port };
      attempts += 1;
      try {
        const value = await withTimeout(
          (signal) => options.attempt(target, timeoutMs, signal),
          timeoutMs,
          controller.signal,
          `Probing ${host}:${port} timed out after ${timeoutMs} ms.`,
        );
        if (winner === undefined) {
          // 单线程事件循环内的同步赋值：第一个 resolve 的成功者胜出，后到者被忽略。
          winner = { target, value };
          controller.abort();
        }

        return;
      } catch (errorValue) {
        lastError = toError(errorValue);
      }
    }
  };

  const workers: Promise<void>[] = [];
  for (let index = 0; index < Math.min(concurrency, candidates.length); index++) {
    workers.push(worker());
  }

  await Promise.all(workers);

  return winner === undefined
    ? { ok: false, code: "runtime.noEndpoint", attempts, ...(lastError === undefined ? {} : { lastError }) }
    : { ok: true, target: winner.target, value: winner.value, attempts };
}

function candidatePorts(options: BridgeProbeOptions<unknown>): readonly number[] {
  if (options.explicitPort !== undefined) {
    return [options.explicitPort];
  }

  const start = options.portRangeStart;
  const end = options.portRangeEnd;
  if (start === undefined || end === undefined || end < start) {
    return [];
  }

  const ports: number[] = [];
  for (let port = start; port <= end; port++) {
    ports.push(port);
  }

  return ports;
}

/**
 * 单次尝试的实际超时：`attempt` 自己的实现可能不理会 signal（例如阻塞在 socket 上），
 * 所以这里再兜一层定时器，保证"单端口 300 ms"是硬上限。
 */
async function withTimeout<TValue>(
  run: (signal: AbortSignal) => Promise<TValue>,
  timeoutMs: number,
  roundSignal: AbortSignal,
  timeoutMessage: string,
): Promise<TValue> {
  const attemptController = new AbortController();
  const relay = (): void => attemptController.abort();
  roundSignal.addEventListener("abort", relay, { once: true });
  if (roundSignal.aborted) {
    attemptController.abort();
  }

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      attemptController.abort();
      reject(new Error(timeoutMessage));
    }, timeoutMs);
  });

  try {
    // 超时/取消后 attempt 的 promise 可能还会迟到失败：挂一个空 catch，
    // 否则探测会以 unhandled rejection 的形式炸掉宿主。
    const attempt = run(attemptController.signal);
    attempt.catch(() => undefined);
    return await Promise.race([attempt, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }

    roundSignal.removeEventListener("abort", relay);
  }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
