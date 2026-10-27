"use strict";

/**
 * 宿主集成测试用的统一握手（附录 A.3）工厂。
 *
 * Runtime 腿与 Editor 腿共用同一形状（E5 统一）：hello 带 role/clientEndpointId/contractHash/payloads，
 * welcome 带 endpointId/sessionId/resumed/connectType/bootId/payloads/debugEnabled。
 * 假 Runtime 实例逐字段按此构造，避免每个用例重复一份字段表、也避免漏改导致假实例凭旧字段通过。
 */

const BOOT_ID = "b00t0000e5";

function runtimeSessionId(instanceId) {
  return `${instanceId}#${BOOT_ID}`;
}

/** @returns hello 消息对象（VS Code 拨号方）。 */
function createRuntimeHello(options) {
  const token = options.token;
  return {
    type: "hello",
    protocolVersion: 4,
    role: "vscode",
    clientEndpointId: options.clientEndpointId ?? "vscode-test-window",
    ...(token === undefined || token === null || token.length === 0 ? {} : { token }),
    contractHash: options.contractHash ?? "",
    payloads: ["json"],
    ...(options.resumeSessionId === undefined ? {} : { resumeSessionId: options.resumeSessionId }),
  };
}

/** @returns welcome 消息对象（假 Runtime 实例的监听方）。 */
function createRuntimeWelcome(options) {
  const instanceId = options.instanceId;
  return {
    type: "welcome",
    protocolVersion: 4,
    endpointId: instanceId,
    sessionId: runtimeSessionId(instanceId),
    resumed: options.resumed ?? false,
    connectType: options.connectType ?? (instanceId.startsWith("player-") ? "player" : "editor-player"),
    generation: options.generation ?? 1,
    bootId: BOOT_ID,
    contractHash: options.contractHash ?? "",
    payloads: ["json"],
    debugEnabled: options.debugEnabled ?? false,
    startedAt: options.startedAt,
  };
}

module.exports = { BOOT_ID, createRuntimeHello, createRuntimeWelcome, runtimeSessionId };
