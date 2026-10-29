const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { mkdtemp, readFile, rm, writeFile, stat } = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const vscode = require("vscode");

const EXTENSION_ID = "kyl.visualbridge";
/** 协议连接层版本（`src/bridge/bridgeProtocol.ts` 的 BRIDGE_PROTOCOL_VERSION）。 */
const BRIDGE_PROTOCOL_VERSION = 4;
const FRAME_HEADER_BYTES = 6;
const FRAME_PAYLOAD_KIND_SHIFT = 29;
/** E9 样例实例在面板里的键（`channel\u0000instance`）：多条用例共用，必须在文件顶部提前声明。 */
const DEBUG_INSTANCE_KEY = "e9-channel\u0000e9-debug-instance";
/** 单用例过滤（空串 = 跑全部）：只在显式设置 `VISUALBRIDGE_RUNTIME_E2E_ONLY` 时生效。 */
const onlyFilter = process.env.VISUALBRIDGE_RUNTIME_E2E_ONLY ?? "";

exports.run = async function run() {
  const repositoryRoot = requiredEnvironmentPath("VISUALBRIDGE_REPOSITORY_ROOT");
  const artifactsRoot = path.join(repositoryRoot, "UnityProject", "Library", "VisualBridge", "Compiled");

  // E10：生产连接触发。这一段**不调用任何 visualbridge.test.connect/probe 命令**：
  // 只执行生产命令（打开调试面板）与生产路径（打开图页面），连接必须由扩展自己建立。
  await test("production trigger connects the shared runtime bridge when the panel or a graph page opens", async () => {
    // 本用例排在激活用例之前：先显式激活扩展（生产入口本身由命令/编辑器打开触发）。
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `Extension '${EXTENSION_ID}' was not discovered.`);
    await extension.activate();

    // 只用来等 Unity 托管 Play 就绪（观测命令）；生产触发仍由面板/图页面自己发起。
    await waitForAsync(
      () => vscode.commands.executeCommand("visualbridge.test.enumerateRuntimeInstances"),
      (value) => Array.isArray(value) && value.some((instance) => instance.kind === "editor-play" && instance.staleReason === undefined),
      180_000,
      "No live editor-play runtime instance was discovered.",
    );

    const graphUri = vscode.Uri.file(path.join(
      repositoryRoot, "UnityProject", "VisualBridgeAuthoring", "Graphs", "Encounter.vbflow"));

    const expectDisconnected = async () => {
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.getRuntimeBridgeState"),
        (state) => state?.connected === false,
        15_000,
        "The shared runtime bridge did not start disconnected.",
      );
    };
    const expectConnected = async (reason) => waitForAsync(
      () => vscode.commands.executeCommand("visualbridge.test.getRuntimeBridgeState"),
      (state) => state?.connected === true && typeof state?.instanceId === "string",
      60_000,
      `Opening ${reason} did not establish a runtime bridge connection (no test connect command was used).`,
    );

    try {
      // 1) 生产命令打开调试面板 ⇒ 面板自己按需连接。
      await vscode.commands.executeCommand("visualbridge.test.disconnectRuntimeInstance");
      await expectDisconnected();
      await vscode.commands.executeCommand("visualbridge.openDebugPanel");
      const connectedByPanel = await expectConnected("the debug panel");
      assert.equal(connectedByPanel.kind, "editor-player");

      // 状态栏必须反映实际收帧来源（E10）：Runtime 腿在线时不能显示"未连接"。
      const panel = await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.debugPanel.state"),
        (state) => state?.connection?.state === "connected" && state?.connection?.sources?.runtime === true,
        30_000,
        "The debug panel did not report the runtime leg as its frame source.",
      );
      assert.equal(panel.connection.sources.editor, false, "The runtime E2E has no Editor Bridge leg.");
      assert.equal(panel.connection.canRequestEnable, false, "Runtime-only connection must not enable the debug reporting switch.");
      assert.equal(panel.connection.endpointId, connectedByPanel.instanceId);
      assert.equal(panel.connection.target, `127.0.0.1:${connectedByPanel.tcpPort}`);
      assert.equal(panel.connection.detail, undefined);
      console.log(`[runtime-e2e] debug panel opened -> connected ${connectedByPanel.instanceId} on port ${connectedByPanel.tcpPort} (source=runtime)`);

      // 面板关闭不断开：连接生命周期归扩展/DAP，关闭只收起 UI。
      await vscode.commands.executeCommand("visualbridge.test.debugPanel.close");
      const afterClose = await vscode.commands.executeCommand("visualbridge.test.getRuntimeBridgeState");
      assert.equal(afterClose.connected, true, "Closing the panel must not disconnect the shared runtime bridge.");

      // 2) 打开图页面（生产路径）同样按需连接。
      await vscode.commands.executeCommand("visualbridge.test.disconnectRuntimeInstance");
      await expectDisconnected();
      await vscode.commands.executeCommand("vscode.openWith", graphUri, "visualbridge.documentEditor");
      const connectedByGraph = await expectConnected("the graph page");
      assert.equal(connectedByGraph.kind, "editor-player");
      console.log(`[runtime-e2e] graph page opened -> connected ${connectedByGraph.instanceId} on port ${connectedByGraph.tcpPort}`);
    } finally {
      await vscode.commands.executeCommand("workbench.action.closeActiveEditor").catch(() => undefined);
    }
  });

  // E10 P0：真实第二连接（MCP 一类短命客户端）压栈后退出，不能把面板的会话一起 Detach；
  // 否则面板显示「已连接 · 来源 Runtime」却再也收不到帧。用真实握手 + 立即断开模拟临时连接。
  await test("a temporary second debug link does not detach the panel session", async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `Extension '${EXTENSION_ID}' was not discovered.`);
    await extension.activate();

    // 生产命令打开面板：复用上一条用例建立的连接（不断开）。
    await vscode.commands.executeCommand("visualbridge.openDebugPanel");
    const readPanelState = () => vscode.commands.executeCommand("visualbridge.test.debugPanel.state");
    const readBridgeState = () => vscode.commands.executeCommand("visualbridge.test.getRuntimeBridgeState");
    const controlPath = process.env.VISUALBRIDGE_RUNTIME_E2E_CONTROL;
    const unityLogPath = process.env.VISUALBRIDGE_RUNTIME_E2E_LOG;
    assert.ok(controlPath, "The E2E runner must provide VISUALBRIDGE_RUNTIME_E2E_CONTROL.");
    assert.ok(unityLogPath, "The E2E runner must provide VISUALBRIDGE_RUNTIME_E2E_LOG.");

    // 本 E2E 的运行时探针有两种既有状态：面板已收到探针实例（可查询），或一条都没收到
    // （帧与实例都被"重连后槽位表为空"的已知缺口吞掉，见 F8 记录）。**判据不依赖**探针实例：
    // 下面的会话可用性用"临时连接关闭后新建一个实例"证明，所以冷状态也照测，不做自愈重连
    // （自愈会引入第二条连接，让查询路由出现"多连接歧义"的假红）。
    const bridgeState = await readBridgeState();
    // 只要求"面板的 Runtime 腿已连接"：帧号之后只用于打印（冷态里它可能是 -1），不作为前置条件，
    // 否则会把"探针还没发帧"的合法状态误判成没连上。
    const panelBefore = await waitForAsync(
      readPanelState,
      (state) => state?.connection?.state === "connected"
        && state?.connection?.sources?.runtime === true,
      60_000,
      "The panel runtime leg was not connected before the temporary link test.",
    );
    console.log(`[runtime-e2e] panel runtime leg ready: frame=${String(panelBefore.connection.frame)} `
      + `instances=${bridgeState?.debugInstances ?? 0}`);

    const instances = await vscode.commands.executeCommand("visualbridge.test.enumerateRuntimeInstances");
    const instance = instances.find((entry) => entry.kind === "editor-play" && entry.staleReason === undefined);
    assert.ok(instance, "No live editor-play runtime instance to dial the temporary second link.");

    const readPanelFrame = async () => {
      const state = await vscode.commands.executeCommand("visualbridge.test.debugPanel.state");
      return state?.connection?.frame;
    };

    // 因果正控：临时连接真的压成了栈顶（否则关闭它不会触发"出栈恢复 A"，用例就是空转）。
    // 证据取自 Unity 自己的日志（`[runtime-bridge] debug link stacked`），不依赖探针是否在发帧。
    // 只回传"关键事实的位置 + 尾部片段"：失败信息要能读，不能把整段 Unity 堆栈糊上去；
    // 位置是相对同一个绝对偏移量的下标，方便对"关闭之后"这个窗口做范围判定（而不是扫整份日志）。
    const logOffset = (await readFile(unityLogPath, "utf8").catch(() => "")).length;
    const readLogSince = (offset) => (async () => {
      const text = await readFile(unityLogPath, "utf8").catch(() => "");
      const appended = text.slice(offset);
      return {
        stackedAt: appended.indexOf("debug link stacked"),
        keptAt: appended.indexOf("debug link closed (session kept: another link is live)"),
        detachedAt: appended.indexOf("debug link closed (session detached"),
        tail: appended.slice(-240).replaceAll(/\s+/gu, " "),
      };
    });
    const framesBefore = await readPanelFrame();

    const temporary = await dialTemporaryDebugLink(instance.tcpPort, instance.token);
    try {
      await waitForAsync(
        readLogSince(logOffset),
        (observed) => (observed.stackedAt >= 0 ? observed : undefined),
        20_000,
        "Unity never reported a second debug link being stacked: the temporary connection never became the active wire.",
      );

      const during = await vscode.commands.executeCommand("visualbridge.test.getRuntimeBridgeState");
      assert.equal(during.connected, true,
        "The shared runtime bridge must stay connected while the temporary link is layered on top.");
      console.log(`[runtime-e2e] temporary link stacked on the panel session (frames ${String(framesBefore)}, informational)`);
    } finally {
      temporary.destroy();
    }

    const after = await vscode.commands.executeCommand("visualbridge.test.getRuntimeBridgeState");
    assert.equal(after.connected, true,
      "Closing the temporary debug link must not disconnect the shared runtime bridge.");
    assert.equal(after.instanceId, panelBefore.connection.endpointId,
      "The restored connection must still be the panel's instance.");

    // 信息项（**不是判别器**）：让探针在 Unity 里新建一个实例，记下 Create 的回执。
    // 注意 `VisualBridgeDebugSession.Create`（`Runtime/Debug/Internal/VisualBridgeDebugSession.cs:180-275`）
    // 在 Detach 之后**仍会返回 true**：`Connected=false` 走 else 把描述塞进 `s_pendingCreates`（`:266-271`）
    // 然后 `return true`（`:273`）。所以 `ok=True` 只说明"没有致命失败"，**不能**证明会话没被 Detach。
    // 新实例走当前活动 wire 的槽位表，与临时连接在位期间的历史无关，因此不受"Bind 重置槽位表"的已知缺口影响（F8）。
    const probeInstanceId = "e10-after-temporary";
    const probeKey = `e9-channel\u0000${probeInstanceId}`;
    const controlResultPath = `${controlPath}.result`;
    const controlResultBefore = (await readFile(controlResultPath, "utf8").catch(() => "")).length;
    await writeFile(controlPath, `create ${probeInstanceId}\n`, "utf8");
    const controlAnswer = await waitForAsync(
      () => readFile(controlResultPath, "utf8").catch(() => ""),
      (text) => (text.length > controlResultBefore ? text.slice(controlResultBefore) : undefined),
      30_000,
      "Unity never answered the 'create' command after the temporary link closed "
      + "(the hosted Play mode host may be gone; see the Unity log).",
    );
    console.log(`[runtime-e2e] probe create answer (informational): ${controlAnswer.trim()}`);

    // 主判据一（面板侧可达）：新实例必须真的经面板那条连接送到面板。
    // 会话被 Detach 时这条**必红**：`snapshot.Connected=false` ⇒ Create 只入 pending（上面的 `:266-271`），
    // 只有下一次 Attach/heal 才 flush ⇒ 面板永远等不到这个 key。
    // 失败信息只回传"实例键清单 + 查询可用性"，别把整份面板快照（几十 KB）糊到日志里。
    const readPanelInstances = async () => {
      const state = await vscode.commands.executeCommand("visualbridge.test.debugPanel.state");
      return {
        keys: Array.isArray(state?.instances) ? state.instances.map((entry) => entry.key) : [],
        queryAvailable: state?.query?.available,
      };
    };
    await waitForAsync(
      readPanelInstances,
      (observed) => (observed.keys.includes(probeKey) ? observed : undefined),
      30_000,
      "The panel never received the instance created after the temporary link closed: "
      + "the restored connection is not delivering debugCreate (a detached session only queues it).",
    );

    // 主判据二（可往返）：经面板自己的查询客户端对这个**新**实例做一次 debug query。
    // 会话被 Detach 时这条**必红**：应答的 `End` 在 `VisualBridgeDebugSession.cs:536-541` 因 `s_attached=false`
    // 被丢弃（只计 droppedMessages、不发出去）⇒ 客户端在超时内拿不到结果。
    await vscode.commands.executeCommand("visualbridge.test.debugPanel.command", "select", { key: probeKey });
    const query = await waitForAsync(
      () => vscode.commands.executeCommand("visualbridge.test.debugPanel.queryDebug", {
        key: probeKey,
        interfaceId: "IE9SampleQuery",
        method: "Echo",
        // 样例工程没有调试契约，方法名无法解析成方法号，显式给号（同 E9 用例）。
        methodId: 10,
      }),
      (result) => (result?.ok === true ? result : undefined),
      15_000,
      "The debug query for the freshly created instance failed after the temporary link closed.",
    );
    assert.equal(query.value, "e9-query-ok", "The query result must come from the Unity handler.");

    // 支撑证据（不是主判据，但同样是硬断言）：临时连接关闭后 Unity 侧会话必须仍然挂接。
    // 窗口收紧到"栈顶事件之后"：更早的用例可能合法地 Detach 过（那是它们的语义），不能扫整份日志；
    // 窗口内要求 kept 出现，且**在它之前**不得出现 session detached（同一窗口两条都出现时不能假绿）。
    // 放在主判据之后：真被 Detach 时先报"面板收不到实例"，那才是用户看到的症状；这里补上日志层的因果证据。
    const stackedMark = (await readFile(unityLogPath, "utf8").catch(() => ""))
      .indexOf("debug link stacked", logOffset);
    const closeWindow = await waitForAsync(
      readLogSince(stackedMark >= 0 ? stackedMark : logOffset),
      (observed) => (observed.keptAt >= 0 || observed.detachedAt >= 0 ? observed : undefined),
      10_000,
      "Unity never reported closing the temporary debug link (no 'debug link closed' line after it was stacked).",
    );
    assert.ok(
      closeWindow.keptAt >= 0
        && (closeWindow.detachedAt < 0 || closeWindow.detachedAt > closeWindow.keptAt),
      "The Unity host did not keep the session: expected 'debug link closed (session kept: …)' first, "
      + "with no 'session detached' before it. If the line is missing entirely, the host is on the old "
      + `P0 wiring (unconditional Detach). Last observed: ${JSON.stringify(closeWindow)}`,
    );

    // 附加信息（不作判据）：帧号是否继续增长取决于探针是否在发帧，本 E2E 两种状态都合法，只记录。
    const framesAfter = await readPanelFrame().catch(() => undefined);
    console.log(`[runtime-e2e] temporary link closed -> session usable: created ${probeInstanceId}, `
      + `panel query value=${query.value} (frames ${framesBefore} -> ${framesAfter}, informational)`);
    await vscode.commands.executeCommand("visualbridge.test.debugPanel.close");
  });

  await test("activates VisualBridge and discovers the runtime instance", async () => {
    const candidate = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(candidate, `Extension '${EXTENSION_ID}' was not discovered.`);
    await waitFor(
      () => candidate.isActive,
      (isActive) => isActive,
      60_000,
      `Extension '${EXTENSION_ID}' was not activated.`,
    );
    const instances = await waitForAsync(
      () => vscode.commands.executeCommand("visualbridge.test.enumerateRuntimeInstances"),
      (value) => Array.isArray(value) && value.some((instance) => instance.kind === "editor-play" && instance.staleReason === undefined),
      120_000,
      "No live editor-play runtime instance was discovered.",
    );
    const instance = instances.find((entry) => entry.kind === "editor-play" && entry.staleReason === undefined);
    const welcome = await vscode.commands.executeCommand("visualbridge.test.connectRuntimeInstance", instance);
    assert.equal(welcome.instanceId, instance.instanceId);
    assert.equal(welcome.generation, instance.generation);
    // 握手统一（附录 A.3）：welcome 带会话身份与载荷，首连不算续接（E5）。
    assert.equal(welcome.kind, "editor-player");
    assert.equal(welcome.resumed, false);
    assert.match(welcome.sessionId, new RegExp(`^${instance.instanceId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}#`),
      "welcome.sessionId must be '<endpointId>#<bootId>'.");
    assert.deepEqual([...welcome.payloads], ["json"], "The runtime leg negotiates JSON payloads.");
    console.log(`[runtime-e2e] connected to ${welcome.instanceId} generation ${welcome.generation} session ${welcome.sessionId} on port ${instance.tcpPort}`);
  });

  await test("probes the player-style port range and adopts the handshaken endpoint", async () => {
    const instances = await vscode.commands.executeCommand("visualbridge.test.enumerateRuntimeInstances");
    const instance = instances.find((entry) => entry.kind === "editor-play" && entry.staleReason === undefined);
    assert.ok(instance, "No live runtime instance is available to probe.");

    // 端口段探测（附录 A.8）：并发 8、单口 300 ms、第一个握手成功者胜出。
    // Play 模式 server 在 28300–28349 里取第一个可用端口（E2E 编排注入的端口段）。
    const probed = await vscode.commands.executeCommand("visualbridge.test.probeRuntimePorts", {
      host: "127.0.0.1",
      portRangeStart: 28300,
      portRangeEnd: 28349,
      token: instance.token,
    });
    assert.equal(probed.instanceId, instance.instanceId);
    assert.equal(probed.kind, "editor-player");
    assert.equal(probed.port, instance.tcpPort, "The probe must adopt the port discovery reported.");
    assert.equal(probed.resumed, false, "A fresh probe starts a new session.");

    // token 不匹配：TCP 可连但握手失败 => 整段按 runtime.noEndpoint 报错
    // （禁用 / 端口占用 / 未启动不再区分）。
    await assert.rejects(
      vscode.commands.executeCommand("visualbridge.test.probeRuntimePorts", {
        host: "127.0.0.1",
        portRangeStart: 28300,
        portRangeEnd: 28349,
        token: "b".repeat(48),
      }),
      (error) => /runtime\.noEndpoint/.test(String(error && error.message ? error.message : error)),
      "A probe with a mismatched token must fail as runtime.noEndpoint.",
    );
    console.log(`[runtime-e2e] probed port range and adopted ${probed.instanceId} on port ${probed.port}`);

    // 探测失败会把服务置为未连接（探测先断开再挑端点）：恢复连接，后续用例继续用同一条链路。
    const restored = await vscode.commands.executeCommand("visualbridge.test.connectRuntimeInstance", instance);
    assert.equal(restored.instanceId, instance.instanceId);
  });

  await test("receives the compiled artifact snapshot from the runtime instance", async () => {
    const documents = await vscode.commands.executeCommand("visualbridge.test.getRuntimeSnapshot");
    assert.ok(Array.isArray(documents), "Snapshot response did not carry a documents array.");
    const hero = documents.find((document) => document.documentId === "sample.unity.hero.default");
    assert.ok(hero, "Snapshot does not contain the compiled entity fixture.");
    assert.equal(hero.documentTypeId, "sample.unity.hero");
    assert.equal(hero.kind, "visualbridge.entity.compiled");
    assert.equal(hero.data.properties.name, "Ranger");
    assert.ok(documents.length >= 4, `Expected all four domain artifacts, found ${documents.length}.`);
    const state = await vscode.commands.executeCommand("visualbridge.test.getRuntimeBridgeState");
    assert.equal(state.connected, true);
    assert.equal(state.lastSnapshotCount, 1);
  });

  await test("acquires the debug lease and maps document sources with drift detection", async () => {
    await vscode.commands.executeCommand("visualbridge.test.acquireRuntimeLease");
    const sources = await vscode.commands.executeCommand("visualbridge.test.getRuntimeDocumentSources");
    assert.ok(Array.isArray(sources) && sources.length >= 4, `Expected source mappings for all domains, found ${sources?.length}.`);
    const heroSource = sources.find((source) => source.documentId === "sample.unity.hero.default");
    assert.ok(heroSource, "Source mapping does not contain the entity fixture.");
    assert.equal(heroSource.documentTypeId, "sample.unity.hero");
    assert.match(heroSource.sourcePath, /Entities\/Hero\.vbentity$/);
    assert.match(heroSource.sourceSha256, /^[0-9a-f]{64}$/);

    // 漂移防护：工作区当前文档字节与运行时加载的源 Hash 必须一致（未修改时）。
    const heroPath = path.join(repositoryRoot, "UnityProject", "VisualBridgeAuthoring", ...heroSource.sourcePath.split("/"));
    const currentBytes = await readFile(heroPath);
    const currentSha = createHash("sha256").update(currentBytes).digest("hex");
    assert.equal(currentSha, heroSource.sourceSha256, "Unmodified authoring document should not be reported as drifted.");

    // 修改 Authoring 文档后，源映射必须能暴露漂移（运行时仍持有旧 Hash）。
    const original = await readFile(heroPath, "utf8");
    try {
      await writeFile(heroPath, original.replace('"Ranger"', '"Drifted Ranger"'), "utf8");
      const driftedBytes = await readFile(heroPath);
      const driftedSha = createHash("sha256").update(driftedBytes).digest("hex");
      assert.notEqual(driftedSha, heroSource.sourceSha256, "Modified authoring document must differ from the runtime source hash.");
    } finally {
      await writeFile(heroPath, original, "utf8");
    }

    await vscode.commands.executeCommand("visualbridge.test.releaseRuntimeLease");
  });

  await test("receives the artifactsChanged event after a compiled artifact changes", async () => {
    const artifactPath = path.join(
      artifactsRoot,
      "documents",
      "visualbridge.unity-sample",
      "sample.unity.game.settings",
      "sample.unity.game.settings.default.vbcompiled.json",
    );
    const original = await readFile(artifactPath, "utf8");
    try {
      // 重排 JSON（内容不同但仍是合法产物）触发实例侧 digest 轮询。
      const modified = `${JSON.stringify(JSON.parse(original), undefined, 4)}\n`;
      await writeFile(artifactPath, modified, "utf8");
      const state = await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.getRuntimeBridgeState"),
        (value) => value?.lastEventCount >= 1,
        10_000,
        "The runtime instance did not push an artifactsChanged event.",
      );
      assert.equal(state.connected, true);
      console.log(`[runtime-e2e] received artifactsChanged (events=${state.lastEventCount})`);
    } finally {
      await writeFile(artifactPath, original, "utf8");
      await stat(artifactPath);
    }
  });

  // ---- E9 调试通道生产接线：Runtime 腿的 ch1 帧必须真的进 DebugIngress → 实例/事件 ----

  await test("receives live ch1 debug frames on the runtime bridge and ingests them as instances (E9)", async () => {
    // Unity 侧执行模拟器通过生产入口 `VisualBridgeDiagnostics.VisualBridgeDebug` 每 300ms 发一条事件帧。
    const state = await waitForAsync(
      () => vscode.commands.executeCommand("visualbridge.test.getRuntimeBridgeState"),
      (value) => value?.connected === true && (value?.debugFrames ?? 0) >= 2 && (value?.debugEnvelopes ?? 0) >= 2,
      60_000,
      "The runtime bridge did not deliver ch1 debug frames to DebugIngress.",
    );
    const snapshot = await waitForAsync(
      () => vscode.commands.executeCommand("visualbridge.test.debugPanel.state"),
      (value) => Array.isArray(value?.instances)
        && value.instances.some((row) => row.key === DEBUG_INSTANCE_KEY && row.recordCount >= 1),
      30_000,
      "The runtime debugCreate did not become a panel instance with events.",
    );
    const row = snapshot.instances.find((entry) => entry.key === DEBUG_INSTANCE_KEY);
    assert.equal(row.origin, "runtime", "The runtime-leg instance must be labeled with its origin.");
    assert.equal(row.originConflict, false, "No Editor-leg instance shares this identity.");
    // F8-§8-6：把"至少一条"换成**可解释的等式**。三个计数取自同一快照（`getRuntimeBridgeState`
    // 里的同一份 `DebugChannelSession.recordCounters`），所以这里的等式不受采样竞态影响：
    // 每个 ingress 收下的帧都恰好解出一条包络，且只属于一侧：数据类**只有** debug；
    // 控制类 = debugCreate/debugFinish/debugFrame/**debugResult**/**response**（结果与应答虽走
    // 数据通道，却不进事件流，交给查询客户端结算）。等式不成立 = 有帧被静默丢掉。
    assert.equal(
      state.debugFrames,
      state.debugControlFrames + state.debugDataFrames,
      `every received runtime ch1 frame must be accounted for exactly once `
        + `(frames=${state.debugFrames}, control=${state.debugControlFrames}, data=${state.debugDataFrames})`,
    );
    // 数据类包络里必须真有一条落进时间轴（`storedRecords <= dataEnvelopes`：记录先于 Create 会先暂存；
    // storedRecords 不含 queryResult，后者由查询客户端直接追加）。
    assert.ok(state.debugStoredRecords >= 1, `The runtime leg must store at least one record (stored=${state.debugStoredRecords}).`);
    assert.ok(state.debugStoredRecords <= state.debugDataFrames,
      `Stored records can never exceed the data envelopes that produced them (stored=${state.debugStoredRecords}, data=${state.debugDataFrames}).`);
    assert.ok(row.recordCount >= 1, `The runtime leg must ingest debug events (recordCount=${row.recordCount}).`);
    console.log(`[runtime-e2e] runtime ch1 debug: frames=${state.debugFrames} control=${state.debugControlFrames} `
      + `data=${state.debugDataFrames} stored=${state.debugStoredRecords} records=${row.recordCount} origin=${row.origin}`);
  });

  // ---- G1c：Graph 执行事实经**生成的调试契约**（category=graph）进面板 ----
  // 判据读的是 Unity 生成的真产物（debug-contracts.json），不是测试里的方法名副本：
  // 契约改了名字而发射端没跟上，这条用例就会红。
  await test("ingests real graph execution facts through the generated graph debug contract (G1c)", async () => {
    // 自足：不依赖前面任何用例。前置全部在本用例内建立，且**只用产品已有的用户动作**：
    // ① 显式激活扩展（命令注册发生在 activate 里；只开过一次工作区时才是懒激活）；
    // ② **先等** Unity 写出 `editor-play` 发现记录，**再**打开调试面板——顺序反过来（先开面板再等记录）
    //    会让首次 `ensureConnected` 注定落在"记录还不存在"的窗口里，那是测试自己造出来的失败，
    //    不能当成"面板首次连接成功率"的证据（对照数据见报告）；
    // ③ 等面板把共享 Runtime 桥连上（有界等待：60 s 上限，超时打印面板状态与已等时长）；
    // ④ 连接建立后，本用例只断言"graph 实例到达面板 + ack 内容"，不把"连上"算作它的产出。
    const candidate = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(candidate, `Extension '${EXTENSION_ID}' was not discovered.`);
    await candidate.activate();
    await waitForAsync(
      () => vscode.commands.executeCommand("visualbridge.test.enumerateRuntimeInstances"),
      (value) => Array.isArray(value) && value.some((instance) => instance.kind === "editor-play" && instance.staleReason === undefined),
      180_000,
      "No live editor-play runtime instance was discovered for the G1c case.",
    );
    await vscode.commands.executeCommand("visualbridge.openDebugPanel");
    const waitedMs = await waitForRuntimeBridgeConnected(60_000);
    console.log(`[runtime-e2e] G1c precondition: runtime bridge connected after ${waitedMs} ms`);
    const contractsPath = path.join(
      repositoryRoot, "UnityProject", "Assets", "VisualBridgeGenerated", "Debug", "debug-contracts.json");
    const contracts = JSON.parse(await readFile(contractsPath, "utf8"));
    const graphCategory = contracts.categories.find((category) => category.name === "graph");
    assert.ok(graphCategory, "The Unity project must declare the graph debug category.");
    const contractMethods = new Set(
      graphCategory.interfaces.flatMap((contractInterface) => contractInterface.methods.map((method) => method.name)),
    );
    assert.ok(contractMethods.has("NodeStarted"), "The graph contract must declare NodeStarted.");
    assert.ok(contractMethods.has("EdgeValueChanged"), "The graph contract must declare EdgeValueChanged.");

    // 实例由 Unity 侧执行模拟器真实产生（executionId 由采集门面分配），面板键是 category\u0000instanceId。
    const listed = await waitForAsync(
      () => vscode.commands.executeCommand("visualbridge.test.debugPanel.state"),
      (state) => Array.isArray(state?.instances)
        && state.instances.some((row) => row.key.startsWith("graph\u0000") && row.recordCount >= 2),
      60_000,
      "The graph debug instance produced by the Unity execution simulator never reached the panel.",
    );
    const row = listed.instances
      .filter((entry) => entry.key.startsWith("graph\u0000"))
      .sort((left, right) => right.recordCount - left.recordCount)[0];
    assert.equal(row.origin, "runtime", "The graph execution instance must come from the runtime leg.");
    const executionId = row.key.slice("graph\u0000".length);
    assert.ok(executionId.length > 0, "The panel key must carry the Unity execution id.");

    await vscode.commands.executeCommand("visualbridge.test.debugPanel.command", "select", { key: row.key });
    const timeline = await waitForAsync(
      () => vscode.commands.executeCommand("visualbridge.test.debugPanel.state"),
      (state) => {
        if (state?.timeline?.selected !== true) {
          return false;
        }

        const methods = new Set((state.timeline.records ?? []).map((record) => record.method));
        return methods.has("NodeStarted") && methods.has("EdgeValueChanged");
      },
      60_000,
      "The graph instance timeline never showed NodeStarted + EdgeValueChanged rows.",
    );

    const records = timeline.timeline.records;
    assert.ok(records.length >= 2, `Expected graph timeline rows, got ${records.length}.`);
    for (const record of records) {
      assert.ok(contractMethods.has(record.method),
        `Timeline method '${record.method}' is not declared by the graph debug contract.`);
      assert.equal(record.interfaceId, "IGraphDebuger", "Every graph record must come from IGraphDebuger.");
      assert.equal(record.instanceId, executionId, "Every graph record must belong to the same execution instance.");
    }

    // 载荷本身：同一批帧在 ingest 时已按生成契约解出参数名与值（面板详情用的是同一份
    // `contractState` + named args），这里直接证明"契约身份被识别、载荷是真值"。
    // 不用面板详情（快照字段、跟随光标时不主动推送，反复 select 还会切到回看模式），也不用
    // `debugStoredRecords >= rows`：时间轴窗口会随新事件前移，帧数在涨时那个比较是竞态。
    const ingested = await vscode.commands.executeCommand("visualbridge.test.getRuntimeBridgeState");
    assert.ok((ingested?.debugStoredRecords ?? 0) >= 1,
      `The graph records must come from ingested debug frames (stored=${ingested?.debugStoredRecords}).`);
    const ingestCount = new Set(records.map((record) => record.method)).size;
    console.log(`[runtime-e2e] graph contract ingest: instance=${row.key} records=${row.recordCount} `
      + `rows=${records.length} methods=${[...new Set(records.map((record) => record.method))].join(",")} `
      + `contractMethods=${contractMethods.size} distinctMethods=${ingestCount}`);
  });

  await test("completes a real debug query roundtrip on the runtime leg (E9)", async () => {
    const before = await vscode.commands.executeCommand("visualbridge.test.debugPanel.state");
    const beforeRow = before.instances.find((entry) => entry.key === DEBUG_INSTANCE_KEY);
    assert.ok(beforeRow, "The runtime debug instance disappeared before the query roundtrip.");

    // 可查询的前提（可判定，不是重试）：面板里选中该实例后 `query.available` 必须为 true ——
    // 它按"实例所属连接"计算（`EditorBridgeServer.debugQueryState`），等价于"有一条存活连接持有它的
    // 槽位绑定"。面板重开/换连接后，Unity 侧要等下一个探针节拍（300 ms）才重发 debugCreate；
    // 这段等待是收敛过程。若始终没有 owner 就明确失败，不靠反复查询把真问题藏进超时里。
    await vscode.commands.executeCommand("visualbridge.test.debugPanel.command", "select", { key: DEBUG_INSTANCE_KEY });
    await waitForAsync(
      () => vscode.commands.executeCommand("visualbridge.test.debugPanel.state"),
      (state) => state?.query?.available === true,
      30_000,
      "The panel lists the runtime instance but no live debug connection owns it "
      + `(query.available stayed false; instance=${DEBUG_INSTANCE_KEY}).`,
    );

    const result = await vscode.commands.executeCommand("visualbridge.test.debugPanel.queryDebug", {
      key: DEBUG_INSTANCE_KEY,
      interfaceId: "IE9SampleQuery",
      method: "Echo",
      // G1c 之后契约里有 graph 类别，但不含 E9 的查询接口：方法名无法解析成方法号，显式给号（C.1 的字段）。
      methodId: 10,
    });
    assert.equal(result.ok, true, `The debug query failed: ${result.error} (${result.code})`);
    assert.equal(result.kind, "queryResult", "The result must be appended to the timeline as a queryResult record.");
    assert.equal(result.value, "e9-query-ok", "The query result payload must come from the Unity handler.");

    const after = await vscode.commands.executeCommand("visualbridge.test.debugPanel.state");
    const afterRow = after.instances.find((entry) => entry.key === DEBUG_INSTANCE_KEY);
    assert.ok(afterRow.recordCount > beforeRow.recordCount,
      `The query result must extend the runtime instance timeline (${beforeRow.recordCount} -> ${afterRow.recordCount}).`);
    console.log(`[runtime-e2e] runtime query roundtrip: frame=${result.frame} kind=${result.kind} value=${result.value}`);
  });

  await test("records the runtime debug channel and replays it from the .vbdrec (E9)", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "visualbridge-e9-recording-"));
    const filePath = path.join(directory, "runtime-channel.vbdrec");
    try {
      const before = await vscode.commands.executeCommand("visualbridge.test.getRuntimeBridgeState");
      assert.equal(before.connected, true);
      // G1c 之后 runtime 腿上有两个生产者（E9 探针 + Graph 执行发射端），"总帧数"不再是 E9 实例记录数的代理：
      // 录制窗口必须真的夹住 E9 自己的事件，回看才可能重建它的时间轴。
      const panelBeforeRecording = await vscode.commands.executeCommand("visualbridge.test.debugPanel.state");
      const e9RecordsBefore = panelBeforeRecording.instances
        .find((row) => row.key === DEBUG_INSTANCE_KEY)?.recordCount ?? 0;
      const started = await vscode.commands.executeCommand("visualbridge.test.debugPanel.recordingStart", filePath);
      assert.equal(started.active, true);
      assert.equal(started.origin, "runtime", "Recording must bind to the runtime-leg connection that is producing frames.");

      // `records` 只在数据块落盘（64 KB 或停止）时增加：录制期间等的是"帧还在流"，不是 records>0。
      const streamed = await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.getRuntimeBridgeState"),
        (value) => (value?.debugFrames ?? 0) >= (before.debugFrames ?? 0) + 3,
        20_000,
        "The runtime leg stopped delivering debug frames while recording.",
      );
      // 录制是旁路（同一批帧也进在线面板）：等到 E9 实例自己多出两条记录，文件里才必然有它的 ≥2 条数据帧。
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.debugPanel.state"),
        (state) => ((state?.instances ?? []).find((row) => row.key === DEBUG_INSTANCE_KEY)?.recordCount ?? 0)
          >= e9RecordsBefore + 2,
        20_000,
        "The E9 instance gained fewer than two events while the channel recording was active.",
      );
      const stopped = await vscode.commands.executeCommand("visualbridge.test.debugPanel.recordingStop");
      assert.ok(stopped.footer, "Stopping the recording must produce a footer.");
      assert.ok(stopped.footer.records >= 3, `Expected recorded frames in the footer, got ${stopped.footer.records}.`);
      assert.equal(stopped.state.deliverable, true, "The recording must be finalized as deliverable.");
      const size = (await stat(filePath)).size;
      assert.ok(size > 0, "The .vbdrec file must not be empty.");

      // 回看：用真实 reader 打开刚录的文件，时间轴必须能出记录（不是"文件非空"就宣称可回看）。
      const opened = await vscode.commands.executeCommand("visualbridge.test.debugPanel.openRecording", filePath);
      assert.equal(opened.ok, true, `The recording could not be opened: ${opened.error}`);
      const replay = await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.debugPanel.state"),
        (value) => value?.replay !== undefined
          && (value?.replay?.records ?? 0) >= 3
          && Array.isArray(value?.instances)
          && value.instances.some((row) => row.key === DEBUG_INSTANCE_KEY && row.recordCount >= 1),
        20_000,
        "The .vbdrec could not be replayed into an instance timeline.",
      );
      const replayInstance = replay.instances.find((row) => row.key === DEBUG_INSTANCE_KEY);
      assert.ok(replayInstance, "The replayed recording must reconstruct the runtime debug instance.");
      assert.ok(replayInstance.recordCount >= 2,
        `The replayed instance must carry the recorded events (recordCount=${replayInstance.recordCount}).`);

      // 选中回放实例：时间轴必须能渲染出记录（"回看能出时间轴"的证据）。
      await vscode.commands.executeCommand("visualbridge.test.debugPanel.command", "select", { key: DEBUG_INSTANCE_KEY });
      const timeline = await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.debugPanel.state"),
        (value) => (value?.timeline?.records?.length ?? 0) >= 1 && value?.timeline?.selected === true,
        20_000,
        "The replayed recording produced no timeline rows.",
      );
      console.log(`[runtime-e2e] runtime recording: +frames=${streamed.debugFrames - (before.debugFrames ?? 0)} footer=${stopped.footer.records} bytes=${size} replayRecords=${replay.replay.records} replayRows=${timeline.timeline.records.length} replayInstanceRecords=${replayInstance.recordCount}`);

      // 关闭回看，后续 DAP 用例仍然操作在线面板。
      await vscode.commands.executeCommand("visualbridge.test.debugPanel.command", "closeRecording", {});
      const live = await vscode.commands.executeCommand("visualbridge.test.debugPanel.state");
      assert.equal(live.replay, undefined, "Closing the replay must return the panel to the live bridge.");
    } finally {
      await vscode.commands.executeCommand("visualbridge.test.debugPanel.recordingStop").catch(() => undefined);
      await vscode.commands.executeCommand("visualbridge.test.debugPanel.command", "live", {}).catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  await test("inspects the runtime snapshot through the DAP debug session", async () => {
    // 前置测试已释放租约且仅持有观察者连接：DAP attach 可重新连接并 acquire。
    const instances = await vscode.commands.executeCommand("visualbridge.test.enumerateRuntimeInstances");
    const instance = Array.isArray(instances)
      ? instances.find((entry) => entry.kind === "editor-play" && entry.staleReason === undefined)
      : undefined;
    assert.ok(instance, "No live editor-play runtime instance for the DAP inspection session.");
    const session = await vscode.commands.executeCommand("visualbridge.test.attachRuntimeInstance", instance);
    assert.equal(session.type, "visualbridge-runtime");
    const attached = await waitForAsync(
      () => vscode.commands.executeCommand("visualbridge.test.getRuntimeDebugSessionState"),
      (value) => value?.connected === true && value?.leaseHeld === true && value?.documents >= 4,
      30_000,
      "The DAP inspection session did not attach with the full runtime snapshot.",
    );
    // 未修改 Authoring 源（hero 漂移测试已还原）：hero 与全部文档 drifted=false。
    assert.equal(attached.driftedDocuments, 0, "Unmodified authoring documents must not be reported as drifted.");
    assert.equal(attached.driftedDocumentIds.includes("sample.unity.hero.default"), false,
      "The unmodified hero document must not be reported as drifted.");
    assert.equal(attached.topLevelVariables, attached.documents, "Top-level variables must mirror the runtime document list.");

    await vscode.debug.stopDebugging(session);
    const closed = await waitForAsync(
      () => vscode.commands.executeCommand("visualbridge.test.getRuntimeDebugSessionState"),
      (value) => value?.connected !== true && value?.leaseHeld !== true && value?.documents === 0,
      30_000,
      "The DAP inspection session did not release the lease and disconnect.",
    );
    assert.equal(closed.leaseHeld, false);
  });

  await test("drives graph execution debug through the Graph editor with live Unity events", async () => {
    // Unity 侧执行模拟器持续上报 Encounter 图的节点/边事件（VB-UX-16）。
    const encounterUri = vscode.Uri.file(path.join(
      repositoryRoot, "UnityProject", "VisualBridgeAuthoring", "Graphs", "Encounter.vbflow"));
    try {
      await vscode.commands.executeCommand("vscode.openWith", encounterUri, "visualbridge.documentEditor");
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.isEditorReady", encounterUri),
        (ready) => ready === true,
        30_000,
        "The Graph editor did not become ready for the execution debug E2E.",
      );

      await vscode.commands.executeCommand("visualbridge.test.sendGraphEditorDebugMessage", encounterUri, {
        type: "requestGraphExecutionInstances",
        requestId: "e2e-graph-debug-list",
      });
      const listed = await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.getGraphEditorDebugState", encounterUri),
        (state) => state?.runtimeConnected === true && state?.instanceCount >= 1,
        60_000,
        "The debug controller did not discover the Unity execution instance.",
      );
      const executionId = listed.instanceIds[0];
      assert.ok(executionId, "No execution instance id was listed for the Encounter graph.");

      await vscode.commands.executeCommand("visualbridge.test.sendGraphEditorDebugMessage", encounterUri, {
        type: "subscribeGraphExecution",
        requestId: "e2e-graph-debug-subscribe",
        executionId,
      });
      const live = await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.getGraphEditorDebugState", encounterUri),
        (state) => state?.subscribedExecutionId === executionId
          && state?.lastWebviewAck !== undefined
          && state.lastWebviewAck.eventCount >= 1
          && typeof state.lastWebviewAck.executingNodeId === "string"
          && state.lastWebviewAck.executingNodeId.length > 0
          && state.lastWebviewAck.mode === "follow",
        60_000,
        "The Webview did not acknowledge live Unity execution events.",
      );
      const liveNodeId = live.lastWebviewAck.executingNodeId;
      assert.equal(live.lastWebviewAck.cursor, live.lastWebviewAck.eventCount - 1,
        "The follow-mode cursor must track the latest Unity event.");
      console.log(`[runtime-e2e] execution debug live: execution=${executionId} node=${liveNodeId} events=${live.lastWebviewAck.eventCount}`);

      // 退订停采：断开连接后事件不再累计。
      await vscode.commands.executeCommand("visualbridge.test.sendGraphEditorDebugMessage", encounterUri, {
        type: "unsubscribeGraphExecution",
        requestId: "e2e-graph-debug-unsubscribe",
      });
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.getGraphEditorDebugState", encounterUri),
        (state) => state?.subscribedExecutionId === undefined && state?.runtimeConnected === false,
        30_000,
        "The debug controller did not unsubscribe and disconnect.",
      );
      await new Promise((resolve) => setTimeout(resolve, 1200));

      // 切换实例：模拟器保持实例存活，重新订阅后事件从低计数恢复增长。
      await vscode.commands.executeCommand("visualbridge.test.sendGraphEditorDebugMessage", encounterUri, {
        type: "requestGraphExecutionInstances",
        requestId: "e2e-graph-debug-relist",
      });
      const relisted = await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.getGraphEditorDebugState", encounterUri),
        (state) => state?.runtimeConnected === true && state?.instanceCount >= 1,
        60_000,
        "The debug controller did not re-discover the Unity execution instance.",
      );
      await vscode.commands.executeCommand("visualbridge.test.sendGraphEditorDebugMessage", encounterUri, {
        type: "subscribeGraphExecution",
        requestId: "e2e-graph-debug-resubscribe",
        executionId: relisted.instanceIds[0],
      });
      const resumed = await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.getGraphEditorDebugState", encounterUri),
        (state) => state?.subscribedExecutionId === relisted.instanceIds[0]
          && state?.lastWebviewAck !== undefined
          && state.lastWebviewAck.eventCount >= 1,
        60_000,
        "The Webview did not resume execution events after re-subscribing.",
      );
      assert.ok(resumed.lastWebviewAck.eventCount <= 5,
        `Re-subscription must start from a fresh recording (events=${resumed.lastWebviewAck.eventCount}); `
        + "a large count means events kept accumulating while unsubscribed.");
      await vscode.commands.executeCommand("visualbridge.test.sendGraphEditorDebugMessage", encounterUri, {
        type: "unsubscribeGraphExecution",
        requestId: "e2e-graph-debug-final-unsubscribe",
      });
      await waitForAsync(
        () => vscode.commands.executeCommand("visualbridge.test.getGraphEditorDebugState", encounterUri),
        (state) => state?.subscribedExecutionId === undefined && state?.runtimeConnected === false,
        30_000,
        "The debug controller did not release the final subscription.",
      );
    } finally {
      await vscode.commands.executeCommand("workbench.action.closeActiveEditor").catch(() => undefined);
    }
  });
};

/**
 * 建立"面板已连上 Runtime 桥"这个前置：只等待 `state.connected === true`（有界），返回已等待的毫秒数。
 *
 * 这里**故意不点「重试连接」**：面板自身的 `ensureConnected` 是单飞的（`pending` 在途时早退），
 * 在本用例的时序下首轮尝试总是成功（实测每次都是首读即已连接），重试分支从未被执行过——
 * 为一个不再发生的场景保留的分支就是死代码。产品侧重试入口的问题归 E11 §4.2。
 */
async function waitForRuntimeBridgeConnected(timeoutMilliseconds) {
  const readBridgeState = () => vscode.commands.executeCommand("visualbridge.test.getRuntimeBridgeState");
  const readPanelState = () => vscode.commands.executeCommand("visualbridge.test.debugPanel.state");
  const started = Date.now();
  const deadline = started + timeoutMilliseconds;
  let last = await readBridgeState();
  while (last?.connected !== true || typeof last?.instanceId !== "string") {
    if (Date.now() >= deadline) {
      const panel = await readPanelState().catch(() => undefined);
      throw new Error(
        `The debug panel runtime leg did not connect within ${timeoutMilliseconds} ms `
        + `(waited=${Date.now() - started} ms, last=${JSON.stringify(last)}, `
        + `panelState=${JSON.stringify(panel?.connection?.state)}).`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
    last = await readBridgeState();
  }

  return Date.now() - started;
}

async function test(name, action) {
  // 单用例过滤（排障/取证用，默认不启用）：`VISUALBRIDGE_RUNTIME_E2E_ONLY=<名字子串>` 时只执行名字
  // 匹配的用例，其余整体跳过（打印 SKIP）。用于不依赖前序用例的独立取证，例如 kill-switch 双向证据。
  if (onlyFilter.length > 0 && !name.includes(onlyFilter)) {
    console.log(`[runtime-e2e] SKIP ${name}`);
    return;
  }

  console.log(`[runtime-e2e] ${name}`);
  try {
    await action();
    console.log(`[runtime-e2e] PASS ${name}`);
  } catch (errorValue) {
    console.error(`[runtime-e2e] FAIL ${name}`);
    console.error(errorValue);
    throw errorValue;
  }
}

async function waitFor(read, accepts, timeoutMilliseconds, message) {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastValue;
  while (Date.now() < deadline) {
    const value = read();
    lastValue = value;
    if (accepts(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${message} Last observed value: ${JSON.stringify(lastValue)}`);
}

async function waitForAsync(read, accepts, timeoutMilliseconds, message) {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastValue;
  while (Date.now() < deadline) {
    const value = await read();
    lastValue = value;
    if (accepts(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${message} Last observed value: ${JSON.stringify(lastValue)}`);
}


function requiredEnvironmentPath(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Required environment variable '${name}' is not set.`);
  }
  return value;
}

/**
 * 拨一条**真实的**第二条 Runtime 连接并等 welcome（E10 P0）：等价于 MCP 的短命客户端。
 * 只做握手——宿主在 welcome 之后把这条连接绑定成临时栈顶，这正是要验证的场景。
 */
function dialTemporaryDebugLink(port, token, timeoutMilliseconds = 10_000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let buffered = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(() => {
      fail(new Error(`The temporary runtime link did not receive welcome within ${timeoutMilliseconds} ms.`));
    }, timeoutMilliseconds);

    function fail(errorValue) {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(errorValue);
    }

    socket.on("error", fail);
    socket.on("close", () => fail(new Error("The temporary runtime link closed before welcome.")));
    socket.on("connect", () => {
      socket.write(encodeControlJson({
        type: "hello",
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        role: "vscode",
        clientEndpointId: "e10-temporary-client",
        ...(token === undefined || token.length === 0 ? {} : { token }),
        contractHash: "",
        payloads: ["json"],
      }));
    });
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= FRAME_HEADER_BYTES) {
        const word = buffered.readUInt32BE(0);
        const payloadLength = word & 0x1fffffff;
        if (buffered.length < FRAME_HEADER_BYTES + payloadLength) {
          return;
        }

        const payloadKind = (word >>> FRAME_PAYLOAD_KIND_SHIFT) & 0x3;
        const payload = buffered.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + payloadLength);
        buffered = buffered.subarray(FRAME_HEADER_BYTES + payloadLength);
        if (payloadKind !== 1 || settled) {
          continue;
        }

        let message;
        try {
          message = JSON.parse(payload.toString("utf8"));
        } catch {
          continue;
        }

        if (message !== null && typeof message === "object" && message.type === "welcome" && !settled) {
          settled = true;
          clearTimeout(timer);
          resolve(socket);
        }
      }
    });
  });
}
/** 控制通道 JSON 帧（6 字节头 + 载荷，帧头布局与 `src/bridge/framing.ts` 一致）。 */
function encodeControlJson(message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  header.writeUInt32BE((((0 << 31) | (1 << FRAME_PAYLOAD_KIND_SHIFT) | payload.length) >>> 0), 0);
  header.writeUInt16BE(crc16CcittFalse(header.subarray(0, 4)), 4);
  return Buffer.concat([header, payload]);
}

/** CRC-16/CCITT-FALSE：poly 0x1021、init 0xFFFF、不反射、xorout 0。 */
function crc16CcittFalse(bytes) {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }

  return crc & 0xffff;
}
