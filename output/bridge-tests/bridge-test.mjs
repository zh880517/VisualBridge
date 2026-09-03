// VisualBridge Runtime Bridge 临时测试客户端（VS Code 侧语义的独立镜像）。
// 零依赖（Node 内置模块），覆盖：发现（discover）、通信（comm）、
// domain reload 重连监视（watch）。协议镜像
// Packages/com.kyle.visualbridge/Runtime/Bridge/VisualBridgeRuntimeBridgeValidator.cs。
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PROTOCOL_VERSION = 1;
const CORE_VERSION = 1;
const DISCOVERY_FORMAT_VERSION = 1;
const CAPABILITIES = ['snapshot', 'events', 'lease', 'sources', 'graphExecution'];
const INSTANCE_KINDS = ['editor-play', 'player'];
const HEARTBEAT_TIMEOUT_MS = 5000;

const TOKEN_RE = /^[0-9a-f]{48,64}$/;
const INSTANCE_ID_RE = /^(editor|player)-[0-9]+$/;
const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const STARTED_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const recordsDir = path.join(os.tmpdir(), 'visualbridge-runtime');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`PASS ${name}${detail ? ' — ' + detail : ''}`);
  } else {
    failed++;
    console.log(`FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function uuidV4() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// —— 发现：枚举 + 严格校验 + 心跳/pid 双信号陈旧判定（绝不连接陈旧记录）——

function loadRecords() {
  if (!fs.existsSync(recordsDir)) {
    return [];
  }
  return fs
    .readdirSync(recordsDir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const recordPath = path.join(recordsDir, name);
      const problems = [];
      let record = null;
      try {
        record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
      } catch {
        return { recordPath, record: null, problems: ['invalidJson'], stale: true, skip: true };
      }

      const expectedKeys = ['formatVersion', 'protocolVersion', 'coreVersion', 'instanceId', 'kind', 'capabilities', 'tcpPort', 'token', 'pid', 'generation', 'startedAt'];
      const actualKeys = Object.keys(record).sort();
      if (JSON.stringify(actualKeys) !== JSON.stringify([...expectedKeys].sort())) {
        problems.push(`unexpected keys: ${actualKeys.join(',')}`);
      }
      if (record.formatVersion !== DISCOVERY_FORMAT_VERSION) problems.push('formatVersion');
      if (record.protocolVersion !== PROTOCOL_VERSION) problems.push('protocolVersion');
      if (record.coreVersion !== CORE_VERSION) problems.push('coreVersion');
      if (!INSTANCE_ID_RE.test(record.instanceId ?? '')) problems.push('instanceId');
      if (!INSTANCE_KINDS.includes(record.kind ?? '')) problems.push('kind');
      if (!Array.isArray(record.capabilities) || record.capabilities.length === 0 || record.capabilities.some((c) => !CAPABILITIES.includes(c))) problems.push('capabilities');
      if (!Number.isInteger(record.tcpPort) || record.tcpPort < 1 || record.tcpPort > 65535) problems.push('tcpPort');
      if (!TOKEN_RE.test(record.token ?? '')) problems.push('token');
      if (!Number.isInteger(record.pid) || record.pid < 1) problems.push('pid');
      if (!Number.isInteger(record.generation) || record.generation < 1) problems.push('generation');
      if (!STARTED_AT_RE.test(record.startedAt ?? '')) problems.push('startedAt');

      const staleReasons = [];
      const heartbeatAge = Date.now() - fs.statSync(recordPath).mtimeMs;
      if (heartbeatAge > HEARTBEAT_TIMEOUT_MS) staleReasons.push(`heartbeat ${Math.round(heartbeatAge / 1000)}s old`);
      if (!isProcessAlive(record.pid)) staleReasons.push(`pid ${record.pid} dead`);
      return {
        recordPath,
        record,
        problems,
        staleReasons,
        stale: staleReasons.length > 0 || problems.length > 0,
        heartbeatAge,
      };
    });
}

function plantStaleRecords() {
  // 两条伪造陈旧记录：pid 已死（心跳新鲜）、心跳过期（pid 存活=本进程）。
  const deadPidRecord = {
    formatVersion: 1, protocolVersion: 1, coreVersion: 1,
    instanceId: 'editor-999999', kind: 'editor-play', capabilities: ['snapshot'],
    tcpPort: 12345, token: 'ab'.repeat(24), pid: 999999, generation: 1,
    startedAt: new Date().toISOString().replace(/\.\d+Z$/, '.000Z'),
  };
  fs.writeFileSync(path.join(recordsDir, 'editor-999999.json'), JSON.stringify(deadPidRecord));
  const oldHeartbeatRecord = { ...deadPidRecord, instanceId: 'editor-888888', pid: process.pid };
  const oldPath = path.join(recordsDir, 'editor-888888.json');
  fs.writeFileSync(oldPath, JSON.stringify(oldHeartbeatRecord));
  const stale = new Date(Date.now() - 30000);
  fs.utimesSync(oldPath, stale, stale);
  return ['editor-999999', 'editor-888888'];
}

// —— 连接原语：JSON 行协议客户端 ——

class BridgeConnection {
  constructor(port, token, capabilities) {
    this.port = port;
    this.lines = [];
    this.waiters = [];
    this.closed = false;
    this.closeReason = null;
    this.socket = net.connect({ host: '127.0.0.1', port }, () => {
      this.send({
        type: 'hello', protocolVersion: PROTOCOL_VERSION, coreVersion: CORE_VERSION,
        token, clientInstanceId: uuidV4(), capabilities,
      });
    });
    let buffer = '';
    this.socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        this.lines.push(line);
        this.waiters.shift()?.();
      }
    });
    this.socket.on('close', () => {
      this.closed = true;
      this.closeReason = 'close';
      for (const wake of this.waiters.splice(0)) wake();
    });
    this.socket.on('error', () => {});
  }

  send(object) {
    this.socket.write(JSON.stringify(object) + '\n');
  }

  sendRaw(text) {
    this.socket.write(text + '\n');
  }

  async nextLine(timeoutMs = 5000) {
    if (this.lines.length > 0) return this.lines.shift();
    if (this.closed) return null;
    return await new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(this.lines.length > 0 ? this.lines.shift() : null);
      };
      const timer = setTimeout(done, timeoutMs);
      this.waiters.push(done);
    });
  }

  async expectWelcome(timeoutMs = 5000) {
    const line = await this.nextLine(timeoutMs);
    if (line === null) return { error: 'connection closed before welcome' };
    try {
      return { message: JSON.parse(line) };
    } catch {
      return { error: 'non-JSON line: ' + line.slice(0, 120) };
    }
  }

  async request(requestId, action, extra = {}, timeoutMs = 5000) {
    this.send({ type: 'request', requestId, action, ...extra });
    while (true) {
      const line = await this.nextLine(timeoutMs);
      if (line === null) return { error: 'connection closed' };
      const message = JSON.parse(line);
      if (message.type === 'response' && message.requestId === requestId) return { message };
      // 事件等其它消息先存回去，保持顺序语义简单化：直接丢弃并继续等。
    }
  }

  destroy() {
    this.socket.destroy();
  }
}

function assertResponseOk(name, result) {
  check(
    name,
    result.message !== undefined && result.message.type === 'response' && result.message.status === 'ok',
    result.message !== undefined ? JSON.stringify(result.message).slice(0, 160) : result.error,
  );
  return result.message;
}

function assertResponseError(name, result, expectedCode) {
  const message = result.message;
  check(
    name,
    message !== undefined && message.type === 'response' && message.status === 'error' && message.error === expectedCode,
    message !== undefined ? JSON.stringify(message).slice(0, 160) : result.error,
  );
  return message;
}

// —— 子命令 ——

async function cmdDiscover(args) {
  const expectInstance = args.find((a) => a.startsWith('--instance='))?.slice('--instance='.length);
  const expectGone = args.includes('--expect-gone');
  const plantStale = args.includes('--plant-stale');
  const planted = plantStale ? plantStaleRecords() : [];

  const records = loadRecords();
  for (const entry of records) {
    const id = entry.record ? entry.record.instanceId : path.basename(entry.recordPath);
    const staleText = entry.stale ? `STALE(${(entry.staleReasons || entry.problems).join('; ')})` : `fresh(hb=${Math.round(entry.heartbeatAge)}ms)`;
    console.log(`record ${id} gen=${entry.record?.generation} port=${entry.record?.tcpPort} pid=${entry.record?.pid} ${staleText}`);
  }

  if (expectInstance && !expectGone) {
    const match = records.find((r) => r.record?.instanceId === expectInstance);
    check(`discover: 记录存在且新鲜 (${expectInstance})`, match !== undefined && !match.stale,
      match ? '' : 'record not found');
    if (match) {
      check(`discover: instanceId/kind/generation 合法`, INSTANCE_ID_RE.test(match.record.instanceId) && INSTANCE_KINDS.includes(match.record.kind) && match.record.generation >= 1);
      check(`discover: capabilities 广播完整`, JSON.stringify([...match.record.capabilities].sort()) === JSON.stringify([...CAPABILITIES].sort()));
      check(`discover: token 满足 48-64 hex`, TOKEN_RE.test(match.record.token));
    }
  }

  if (expectGone) {
    const match = records.find((r) => r.record?.instanceId === expectInstance);
    check(`discover: 记录已删除 (${expectInstance})`, match === undefined);
  }

  if (plantStale) {
    const deadPid = records.find((r) => r.record?.instanceId === 'editor-999999');
    check('discover: 死 pid 记录判定为陈旧', deadPid !== undefined && deadPid.stale && deadPid.staleReasons.some((r) => r.includes('dead')));
    const oldHeartbeat = records.find((r) => r.record?.instanceId === 'editor-888888');
    check('discover: 心跳过期记录判定为陈旧', oldHeartbeat !== undefined && oldHeartbeat.stale && oldHeartbeat.staleReasons.some((r) => r.includes('heartbeat')));
    for (const id of planted) fs.rmSync(path.join(recordsDir, id + '.json'));
  }

  report();
}

async function cmdComm(args) {
  const artifactsRoot = args[0];
  if (!artifactsRoot) {
    console.error('usage: comm <artifactsRoot> [--instance=<id>]');
    process.exit(2);
  }
  const instanceArg = args.find((a) => a.startsWith('--instance='))?.slice('--instance='.length);
  const records = loadRecords().filter((r) => !r.stale && r.record);
  if (records.length === 0) {
    check('comm: 存在可连接的新鲜记录', false, 'discovery 目录无新鲜记录');
    report();
    return;
  }
  const target = instanceArg ? records.find((r) => r.record.instanceId === instanceArg) : records[0];
  check('comm: 目标记录存在', target !== undefined);
  const { record } = target;

  // 1. 握手：hello → welcome。
  const conn = new BridgeConnection(record.tcpPort, record.token, ['snapshot', 'events', 'lease', 'sources', 'graphExecution']);
  const welcome = await conn.expectWelcome();
  check('comm: welcome 到达且结构合法',
    welcome.message?.type === 'welcome' && welcome.message.instanceId === record.instanceId
      && welcome.message.kind === record.kind && welcome.message.generation === record.generation
      && JSON.stringify([...welcome.message.capabilities].sort()) === JSON.stringify([...CAPABILITIES].sort())
      && STARTED_AT_RE.test(welcome.message.startedAt),
    welcome.error ?? JSON.stringify(welcome.message).slice(0, 160));
  const generation = welcome.message?.generation ?? 0;

  // 2. getSnapshot：ok + documents 数组（产物目录可能为空）。
  const snapshot = assertResponseOk('comm: getSnapshot → ok', await conn.request('req-snap', 'getSnapshot'));
  check('comm: getSnapshot documents 是数组', Array.isArray(snapshot.documents));

  // 3. getSnapshot 带 documentTypeIds 过滤。
  assertResponseOk('comm: getSnapshot(filter) → ok', await conn.request('req-snap2', 'getSnapshot', { documentTypeIds: ['visualbridge.structured'] }));

  // 4. 租约：acquire → getDocumentSources → release。
  assertResponseOk('comm: acquireLease → ok', await conn.request('req-lease', 'acquireLease'));
  const sources = assertResponseOk('comm: getDocumentSources(持租约) → ok', await conn.request('req-src', 'getDocumentSources'));
  check('comm: sources 是数组', Array.isArray(sources.sources));
  assertResponseOk('comm: releaseLease → ok', await conn.request('req-release', 'releaseLease'));

  // 5. 释放后：getDocumentSources → leaseRequired。
  assertResponseError('comm: 释放后再取 sources → leaseRequired', await conn.request('req-src2', 'getDocumentSources'), 'runtime.leaseRequired');

  // 6. 未知 action：请求级错误，连接保持。
  assertResponseError('comm: 未知 action → unknownRequest', await conn.request('req-bogus', 'totallyBogusAction'), 'runtime.unknownRequest');
  assertResponseOk('comm: 未知 action 后连接仍可用', await conn.request('req-after', 'getSnapshot'));

  // 7. 事件推送：artifacts 目录变化 → artifactsChanged（仅 events 能力连接收到）。
  const noEvents = new BridgeConnection(record.tcpPort, record.token, ['snapshot']);
  check('comm: 无 events 能力连接完成握手', (await noEvents.expectWelcome()).message?.type === 'welcome');
  const documentsDir = path.join(artifactsRoot, 'documents');
  fs.mkdirSync(documentsDir, { recursive: true });
  const probeFile = path.join(documentsDir, 'probe-test.vbcompiled.json');
  fs.writeFileSync(probeFile, JSON.stringify({ formatVersion: 1, kind: 'visualbridge.structured.compiled', projectId: 'probe', data: {} }));
  const eventStart = Date.now();
  const eventLine = await conn.nextLine(6000);
  const eventMessage = eventLine ? JSON.parse(eventLine) : null;
  check('comm: artifactsChanged 事件推送',
    eventMessage?.type === 'event' && eventMessage.event === 'artifactsChanged' && Array.isArray(eventMessage.documents),
    eventMessage ? `after ${Date.now() - eventStart}ms` : 'timeout');
  const quietLine = await noEvents.nextLine(1500);
  check('comm: 无 events 能力连接不收到推送', quietLine === null, quietLine ? 'unexpected: ' + quietLine.slice(0, 80) : '');
  fs.rmSync(probeFile);
  const removalEvent = await conn.nextLine(6000);
  check('comm: 删除产物后再次推送', removalEvent !== null && JSON.parse(removalEvent).event === 'artifactsChanged');

  // 8. 负路径（各自独立连接）：坏 token / 非 hello 首消息 / 残缺 JSON / 握手后再发 hello。
  const badToken = new BridgeConnection(record.tcpPort, '00'.repeat(24), ['snapshot']);
  const badTokenReply = await badToken.nextLine();
  check('comm: 错误 token → runtime.invalidToken 并断开',
    badTokenReply !== null && JSON.parse(badTokenReply).type === 'error' && JSON.parse(badTokenReply).code === 'runtime.invalidToken'
      && (await badToken.nextLine(2000)) === null,
    badTokenReply?.slice(0, 100));

  const notHello = new BridgeConnection(record.tcpPort, record.token, ['snapshot']);
  notHello.send({ type: 'request', requestId: 'req-x', action: 'getSnapshot' });
  const notHelloReply = await notHello.nextLine();
  check('comm: 首条非 hello → runtime.unknownMessageType 并断开',
    notHelloReply !== null && JSON.parse(notHelloReply).code === 'runtime.unknownMessageType' && (await notHello.nextLine(2000)) === null,
    notHelloReply?.slice(0, 100));

  const malformed = new BridgeConnection(record.tcpPort, record.token, ['snapshot']);
  malformed.sendRaw('{"type": "hello", oops');
  const malformedReply = await malformed.nextLine();
  check('comm: 残缺 JSON → runtime.invalidJson 并断开',
    malformedReply !== null && JSON.parse(malformedReply).code === 'runtime.invalidJson' && (await malformed.nextLine(2000)) === null,
    malformedReply?.slice(0, 100));

  conn.send({ type: 'hello', protocolVersion: 1, coreVersion: 1, token: record.token, clientInstanceId: uuidV4(), capabilities: ['snapshot'] });
  const doubleHello = await conn.nextLine();
  check('comm: 握手后再发 hello → 连接级错误并断开',
    doubleHello !== null && JSON.parse(doubleHello).type === 'error' && (await conn.nextLine(2000)) === null,
    doubleHello?.slice(0, 100));

  console.log(`info: generation=${generation}`);
  conn.destroy();
  noEvents.destroy();
  badToken.destroy();
  notHello.destroy();
  malformed.destroy();
  report();
}

async function cmdWatch(args) {
  const instanceId = args[0];
  if (!instanceId) {
    console.error('usage: watch <instanceId> [--timeout=90]');
    process.exit(2);
  }
  const timeoutSec = Number(args.find((a) => a.startsWith('--timeout='))?.slice(10) ?? 90);
  const deadline = Date.now() + timeoutSec * 1000;

  const findFresh = () => loadRecords().find((r) => !r.stale && r.record?.instanceId === instanceId);
  let current = findFresh();
  if (!current) {
    check('watch: 初始记录存在', false, 'no fresh record');
    report();
    return;
  }
  const initialGeneration = current.record.generation;
  const initialPort = current.record.tcpPort;

  const conn = new BridgeConnection(current.record.tcpPort, current.record.token, ['snapshot', 'events', 'lease', 'sources', 'graphExecution']);
  const welcome = await conn.expectWelcome();
  check('watch: 初始连接握手成功', welcome.message?.type === 'welcome' && welcome.message.generation === initialGeneration);
  console.log(`watch: connected gen=${initialGeneration} port=${initialPort}, waiting for domain reload...`);

  // 等待断连（domain reload 杀掉旧 server）。
  while (!conn.closed && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  check('watch: domain reload 导致连接断开', conn.closed, conn.closed ? '' : 'still connected at timeout');
  if (!conn.closed) {
    report();
    return;
  }
  const disconnectedAt = Date.now();

  // 轮询重新发现：同 instanceId、generation 递增、心跳新鲜（绝不连陈旧记录）。
  let reborn = null;
  while (Date.now() < deadline) {
    const candidate = findFresh();
    if (candidate && candidate.record.generation > initialGeneration) {
      reborn = candidate;
      break;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  check('watch: reload 后重新发现新代记录', reborn !== undefined,
    reborn ? `gen=${reborn.record.generation}` : 'timeout');
  if (!reborn) {
    report();
    return;
  }

  const rebound = reborn.record.tcpPort === initialPort;
  console.log(`watch: new record gen=${reborn.record.generation} port=${reborn.record.tcpPort} (preferred port ${rebound ? 'rebound' : 'changed'}), reconnecting...`);
  const conn2 = new BridgeConnection(reborn.record.tcpPort, reborn.record.token, ['snapshot', 'events', 'lease', 'sources', 'graphExecution']);
  const welcome2 = await conn2.expectWelcome(10000);
  check('watch: 用新 token 重连握手成功',
    welcome2.message?.type === 'welcome' && welcome2.message.generation === initialGeneration + 1 && welcome2.message.instanceId === instanceId,
    welcome2.error ?? JSON.stringify(welcome2.message).slice(0, 160));
  assertResponseOk('watch: 重连后 getSnapshot 可用', await conn2.request('req-re-snap', 'getSnapshot'));
  check('watch: 旧 token 已失效',
    await (async () => {
      const old = new BridgeConnection(reborn.record.tcpPort, current.record.token, ['snapshot']);
      const line = await old.nextLine();
      old.destroy();
      return line !== null && JSON.parse(line).code === 'runtime.invalidToken';
    })());
  console.log(`watch: reload window = ${((Date.now() - disconnectedAt) / 1000).toFixed(1)}s`);
  conn2.destroy();
  report();
}

function report() {
  console.log(`SUMMARY pass=${passed} fail=${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case 'discover': await cmdDiscover(rest); break;
  case 'comm': await cmdComm(rest); break;
  case 'watch': await cmdWatch(rest); break;
  default:
    console.error('usage: bridge-test.mjs <discover|comm|watch> [args]');
    process.exit(2);
}
