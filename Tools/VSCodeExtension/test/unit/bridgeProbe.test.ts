import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_BRIDGE_PROBE_CONCURRENCY,
  DEFAULT_BRIDGE_PROBE_TIMEOUT_MS,
  BridgeProbeTarget,
  probeBridgePorts,
} from "../../src/bridge/bridgeProbe";

/** 记录每次尝试的端口、并发峰值与取消信号，用于验证调度语义而不是协议。 */
interface ProbeLog {
  readonly attempted: number[];
  maxInFlight: number;
  abortedSignalSeen: boolean;
}

function createLog(): ProbeLog {
  return { attempted: [], maxInFlight: 0, abortedSignalSeen: false };
}

test("probe bridge ports picks the first successful handshake and aborts the rest", async () => {
  const log = createLog();
  let inFlight = 0;
  const outcome = await probeBridgePorts<string>({
    portRangeStart: 28300,
    portRangeEnd: 28319,
    timeoutMs: 1000,
    attempt: async (target, _timeoutMs, signal) => {
      log.attempted.push(target.port);
      inFlight += 1;
      log.maxInFlight = Math.max(log.maxInFlight, inFlight);
      try {
        if (target.port === 28305) {
          return `endpoint-${target.port}`;
        }

        // 慢失败者：必须在胜出者出现后被 abort（而不是继续等到超时）。
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 5000);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            log.abortedSignalSeen = true;
            reject(new Error("aborted"));
          }, { once: true });
        });
        return `late-${target.port}`;
      } finally {
        inFlight -= 1;
      }
    },
  });

  assert.equal(outcome.ok, true);
  assert.ok(outcome.ok);
  assert.equal(outcome.value, "endpoint-28305");
  assert.equal(outcome.target.port, 28305, "The winning port must be reported, not the first candidate.");
  // 首批并发窗口（8 个）已经发出；胜出后队列不再发牌。
  assert.equal(outcome.attempts, 8);
  assert.deepEqual(
    [...log.attempted].sort((left, right) => left - right),
    [28300, 28301, 28302, 28303, 28304, 28305, 28306, 28307],
    "Probing must stop handing out ports once a winner appears.",
  );
  assert.equal(log.attempted.length, 8, "The whole first concurrency window starts before the winner settles.");
  assert.equal(log.abortedSignalSeen, true, "Losing attempts must observe the abort signal.");
});

test("probe bridge ports reports runtime.noEndpoint when every port fails", async () => {
  const log = createLog();
  const outcome = await probeBridgePorts<never>({
    portRangeStart: 28300,
    portRangeEnd: 28304,
    attempt: async (target) => {
      log.attempted.push(target.port);
      throw new Error(`refused ${target.port}`);
    },
  });

  assert.equal(outcome.ok, false);
  assert.ok(!outcome.ok);
  assert.equal(outcome.code, "runtime.noEndpoint");
  assert.equal(outcome.attempts, 5);
  assert.deepEqual([...log.attempted].sort((left, right) => left - right), [28300, 28301, 28302, 28303, 28304]);
  assert.match(outcome.lastError?.message ?? "", /refused/u);
});

test("probe bridge ports connects only the explicit port", async () => {
  const log = createLog();
  const outcome = await probeBridgePorts<string>({
    portRangeStart: 28300,
    portRangeEnd: 28349,
    explicitPort: 28317,
    attempt: async (target) => {
      log.attempted.push(target.port);
      return "explicit";
    },
  });

  assert.ok(outcome.ok);
  assert.equal(outcome.target.port, 28317);
  assert.deepEqual(log.attempted, [28317], "An explicit host:port must never widen into the port range.");
});

test("probe bridge ports honours the concurrency cap", async () => {
  const log = createLog();
  let inFlight = 0;
  const outcome = await probeBridgePorts<never>({
    portRangeStart: 28300,
    portRangeEnd: 28339,
    attempt: async () => {
      inFlight += 1;
      log.maxInFlight = Math.max(log.maxInFlight, inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, 5));
        throw new Error("no endpoint");
      } finally {
        inFlight -= 1;
      }
    },
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.attempts, 40);
  assert.equal(log.maxInFlight, DEFAULT_BRIDGE_PROBE_CONCURRENCY);
});

test("probe bridge ports enforces the per-port timeout", async () => {
  const startedAt = Date.now();
  const outcome = await probeBridgePorts<never>({
    portRangeStart: 28300,
    portRangeEnd: 28301,
    timeoutMs: 60,
    attempt: () => new Promise<never>(() => {
      // 永不 settle：超时必须由探测层兜住，否则探测会被单个挂死端口拖住。
    }),
  });
  const elapsed = Date.now() - startedAt;

  assert.equal(outcome.ok, false);
  assert.ok(!outcome.ok);
  assert.equal(outcome.attempts, 2);
  assert.match(outcome.lastError?.message ?? "", /timed out/u);
  assert.ok(elapsed < 2000, `Probingle must not hang on a stuck port (took ${elapsed} ms).`);
  assert.equal(DEFAULT_BRIDGE_PROBE_TIMEOUT_MS, 300);
});

test("probe bridge ports rejects an empty candidate set without attempting", async () => {
  let attempted = 0;
  const outcome = await probeBridgePorts<never>({
    portRangeEnd: 28300,
    attempt: async (target: BridgeProbeTarget) => {
      attempted += 1;
      throw new Error(`unexpected ${target.port}`);
    },
  });

  assert.equal(outcome.ok, false);
  assert.ok(!outcome.ok);
  assert.equal(outcome.attempts, 0);
  assert.equal(attempted, 0);
});
