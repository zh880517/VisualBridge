/**
 * 重连宽限的纯决策（附录 A.3/A.8 的 `ReconnectGraceMs`）。
 *
 * 监听方（Editor 模式的 VS Code、Player 模式的 Unity）在断开后保留会话身份
 * `endpointId#bootId` 至多 15 s：期间拨号方带 `resumeSessionId` 重连才算 `resumed`。
 * 超过宽限即视为**新会话**——必须换发新的 `bootId`（`sessionId` 随之变化），
 * 让调用方清空旧会话数据，而不是继续用一个已失效的会话 id。
 *
 * 判定与身份换发抽成纯函数是为了让 14.9 s / 15.1 s 这类边界可以用假时钟钉住，
 * 不用真的等 15 秒；监听方只负责提供 `now`、断开时刻与新的 bootId 生成器。
 */

/** 附录 A.8：重连宽限期（毫秒）。 */
export const DEFAULT_RECONNECT_GRACE_MS = 15_000;

export interface ReconnectGraceInput {
  /** 监听方当前会话身份（`endpointId#bootId`）。 */
  readonly sessionId: string;
  readonly bootId: string;
  /** 拨号方 hello 携带的 `resumeSessionId`；缺省表示不请求续接。 */
  readonly resumeSessionId?: string;
  /** 监听方观察到上一次连接断开的时刻（epoch ms）；从未断开过时为缺省。 */
  readonly disconnectedAtMs?: number;
  /** 判定用的当前时刻（epoch ms）；测试注入假时钟。 */
  readonly nowMs: number;
  /** 宽限期覆盖；缺省 {@link DEFAULT_RECONNECT_GRACE_MS}。 */
  readonly graceMs?: number;
  /** 宽限到期时生成新 `bootId` 的工厂；测试可注入固定值。 */
  readonly nextBootId: () => string;
}

export interface ReconnectGraceDecision {
  /** 是否续接（仅当 `resumeSessionId` 命中且仍在宽限内）。 */
  readonly resumed: boolean;
  /** 本连接生效的会话身份；宽限到期时是新值。 */
  readonly sessionId: string;
  readonly bootId: string;
  /** 是否因宽限到期而换发了新会话身份。 */
  readonly rotated: boolean;
}

export function planReconnectGrace(input: ReconnectGraceInput): ReconnectGraceDecision {
  const matched = input.resumeSessionId !== undefined && input.resumeSessionId === input.sessionId;
  if (!matched) {
    // 不匹配（含未请求续接）：保持当前身份，安全起新会话。
    return { resumed: false, sessionId: input.sessionId, bootId: input.bootId, rotated: false };
  }

  const graceMs = input.graceMs ?? DEFAULT_RECONNECT_GRACE_MS;
  // 没有断开记录说明本端从未观察到会话消失（会话仍被认为存活）：保持原有"匹配即续接"。
  // 一旦记录了断开时刻，就必须落在宽限内，否则换发新会话身份。
  const withinGrace = input.disconnectedAtMs === undefined
    || input.nowMs - input.disconnectedAtMs <= graceMs;
  if (withinGrace) {
    return { resumed: true, sessionId: input.sessionId, bootId: input.bootId, rotated: false };
  }

  const bootId = input.nextBootId();
  return { resumed: false, sessionId: `${endpointOf(input.sessionId)}#${bootId}`, bootId, rotated: true };
}

/** 从 `endpointId#bootId` 取端点部分；缺 `#` 时原样返回（监听方自身身份总是合法形状）。 */
function endpointOf(sessionId: string): string {
  const separator = sessionId.indexOf("#");
  return separator < 0 ? sessionId : sessionId.slice(0, separator);
}
