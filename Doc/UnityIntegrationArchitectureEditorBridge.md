# Unity Editor 接入架构：Editor Bridge 与冻结决策

本文是 [VisualBridge Unity Editor 接入架构](UnityIntegrationArchitecture.md) 的子文档，覆盖 Editor Bridge 的 sp/冻结设计，以及 Unity Adapter API 复核决策、命令与验证层级、已冻结与仍待关闭的决策。

## 12. Editor Bridge

Editor Bridge 不是 Structured offline slice 的前置，也不能成为 Export/Compile 的隐式依赖。2026-08-30 完成的 discovery/transport spike 与威胁模型在真实 Unity 6000.3.10f1 编辑器进程、隔离 VS Code 1.105.1 扩展宿主与本机进程间实测了候选传输，以下设计据此冻结。

### 12.1 Spike 证据

| 实验 | 结果 |
| --- | --- |
| 独立进程传输矩阵（Node ↔ C#） | named pipe connect 0–3ms、往返 6–7ms；loopback TCP connect 9–15ms、往返 9–15ms；无效 token 与非 JSON 均被拒绝；不存在的管道超时（慢失败），死端口立即拒绝（快速失败） |
| 服务器重启与崩溃 | 正常重启替换记录（新管道名/token/pid/generation）并支持重连；崩溃后记录残留，由心跳陈旧性（实测 10.7s 拒绝）兜底 |
| 真实 Unity 编辑器进程（batchmode） | pipe connect 1ms、往返 2ms；TCP 4ms/5ms；无效 token 被拒。C# `NamedPipeClientStream` 需要裸管道名（剥除 `\\.\pipe\` 前缀），JSON 转义必须严格——正式实现必须用生成契约解析记录 |
| Domain Reload（真实编辑器） | reload 时服务器观察到断开、静态连接状态清零、reload 后立即重连成功——Unity 侧连接不能跨 Domain Reload 存活 |
| 隔离 VS Code 1.105.1 扩展宿主 | 扩展宿主内 named pipe 服务器接受外部本机进程的 `open` 交换并正确响应 |
| 多窗口 discovery | 陈旧心跳与死 pid 记录被过滤，候选按 `windowId` 显式选择后正确路由 |
| Mono 进程内管道互锁（实施期发现） | Unity Mono 运行时中同进程 Mono↔Mono named pipe 的双端 `Write` 均永久阻塞（最小复现确认）；Mono 客户端对 Node 服务器的管道写入在真实编辑器内正常（见上表）。因此 Unity 客户端优先使用 TCP 端点，EditMode 协议测试使用 TCP 对端，管道路径由真实 Node 服务器的 E2E 覆盖 |

WebSocket 被拒绝：扩展宿主需新增 `ws` 依赖、HTTP upgrade 握手开销、无浏览器客户端场景；NDJSON over pipe/TCP 更简单且实测更快。

### 12.2 冻结设计

- **传输与分帧**：discovery 记录同时登记 named pipe 与 loopback TCP 端点。Unity 客户端优先连接 TCP 端点：`NetworkStream` 支持读写超时，真实编辑器内实测往返 4–5ms，且可避开 Unity Mono 运行时进程内 NamedPipe 流的互锁缺陷；named pipe 端点保留为 TCP 不可用时的回退，并供未来支持 overlapped IO 的客户端使用。消息为 NDJSON 行分帧，不复用 stdio MCP Tool envelope。
- **Discovery 记录**：文件型，位于 `os.tmpdir()` / `Path.GetTempPath()` 下的 `visualbridge-bridge/<windowId>.json`，每个 VS Code 窗口一份。字段：`formatVersion`、`protocolVersion`、`capabilities`、`windowId`、`projectRoots`（该窗口打开的 Authoring Project 根）、`pipePath`、`tcpPort`、`token`、`pid`、`generation`。心跳为服务器每秒更新 mtime；陈旧判定为心跳年龄超阈值（5s）或 pid 不再存活。
- **认证**：每窗口 ≥192-bit 随机 token，仅存于 discovery 记录（用户本地临时目录，默认用户级 ACL）；连接建立后首条消息验证 token，失败即断开。token 防偶发误连与跨用户访问，不防同用户恶意进程。
- **版本与 capability 协商**：记录声明 `protocolVersion` 与 capabilities；客户端不匹配即拒绝，不降级。
- **实例 generation**：服务器每次 listen 递增 generation 并重写记录；客户端重连时检测 generation 变化并丢弃旧会话状态。Unity 侧每次 Domain Reload/进程重启生成新的客户端实例标识；每个请求携带 `requestId` 供幂等去重。
- **重连退避**：客户端 1s 起指数递增至 30s 上限；每次尝试前重新枚举 discovery 记录。
- **多窗口路由**：Unity 按 Integration Profile 的 `authoringProject` 与记录 `projectRoots` 匹配过滤候选；唯一候选直接路由（与 Project Registry 唯一解析语义一致）；多候选必须在 Unity 侧弹出显式选择；禁止"最近连接"或全局 `currentUnity` 猜测。
- **清理与故障恢复**：服务器正常关闭时删除自身记录；崩溃残留由心跳/pid 检测兜底；连接状态不写回 Authoring Document、Project File 或 Integration Profile。
- **消息范围**：第一版只允许 Unity Editor 请求 VS Code 打开或定位 Project Registry 能唯一解析的 Authoring Document；不提供 Authoring Operation、Catalog 写入、Compile、Runtime Attach 或 Debug。消息结构进入正式 Protocol Schema，由同一 generator 产生 TypeScript/C# contract。

### 12.3 威胁模型边界

Unity Editor 与 VS Code 扩展宿主都以当前用户权限运行且非沙箱；Bridge 的安全目标是防误路由与最小暴露，不是防御同用户恶意进程。named pipe / loopback TCP 仅限本机；伪造 discovery 记录的后果上限是获知请求中的文档路径并假冒接受（VS Code 端只执行 open/reveal，无写入面）；请求/响应只含稳定 ID 与路径，不含 Authoring 文档内容。无效 token、版本/capability 不匹配、陈旧 generation、死 pid/陈旧心跳记录与 Domain Reload 后的旧请求必须有自动化拒绝覆盖；本地同用户 DoS（占用管道名/端口）不在防御目标内。

Runtime、Debug 和 Player 仍需各自独立架构、身份模型、权限与真实垂直切片。Editor Bridge 的传输即使验证成功，也不自动成为 Player 或远程调试协议。

### 12.4 实施与验证（2026-08-31）

- **Unity 侧**：`Packages/com.kyle.visualbridge/Editor/Bridge/` 提供严格校验器、discovery 枚举器、同步请求/响应客户端与服务门面；`Tools/VisualBridge/Editor Bridge/Open in VS Code…` 菜单提供显式窗口选择的最小 UI；`VisualBridge.Editor.VisualBridgeBridgeBatch.RunE2E` 供真实编辑器 E2E 使用。
- **VS Code 侧**：扩展激活并完成项目/文档索引后启动 `EditorBridgeServer`（named pipe + loopback TCP 双端点、per-window discovery 记录与心跳、token 握手）；open 经 Project Registry 唯一解析，reveal 经文档索引唯一解析后复用 `revealReference` 命令；多候选一律显式拒绝（`bridge.documentAmbiguous`），不做最近连接猜测。
- **验证**：24 例三方 parity fixture（AJV / Unity strict validator / 扩展宿主解析）一致；Unity EditMode 覆盖握手、generation、能力、非法 JSON、断开、discovery 过滤与多窗口显式选择；扩展宿主集成测试覆盖无效 token、非 JSON、非 hello 首消息、unresolved/ambiguous open 与 reveal 全链路；真实 Unity Editor 6000.3.10f1 与隔离 VS Code 1.105.1 Extension Host 完成 open/reveal E2E（`npm run test:bridge-e2e`）；Bridge 关闭时 Catalog Check 与 Structured Compile Generate/Check 独立通过。

### 13.3 Unity Adapter API 复核决策（VB-UX-03，2026-08-31）

本节是第 13 节复核条件的正式决策记录。触发条件已满足：仓库拥有 Structured 与 Entity 两套真实 Exporter/Compiler，且它们经历了完整实现与验证周期。

**两切片对比证据**：

| 维度 | Structured | Entity | 结论 |
| --- | --- | --- | --- |
| 生命周期 | Load Profile → 扩展名过滤 → BuildPlan → 绑定校验 → 输出比对 → 原子写；Compiler 另有输入快照/事务/stale 清算 | 完全同构（镜像实现） | 生命周期高度一致，可共享 |
| 诊断 | `VisualBridgeIntegrationException` + `catalog.*`/`profile.*`/`compile.*` 错误码 | 同一异常与工具函数，新增 `compile.entityType*`/`compile.component*` 系列 | 已共享 |
| artifact plan | `manifest.json` + `documents/` + `mappings/` | `manifest.entity.json` + 相同子树 | 布局同构，manifest 按域分文件 |
| 注册方式 | Profile `catalogExports` 扩展名路由 + per-domain metadata attribute + per-domain batch/菜单 | 同 | 已是统一模式 |
| 字段/序列化/事务 | 实现所有者 | 经 internal 成员复用（Exporter 约 15 个成员、Compiler 24 个成员），无逻辑复制 | 复用已发生且成本可控 |
| 领域差异点 | 文档校验经反射物化 C# 实例 | 文档校验为纯 JSON 级对照 Catalog（无反射物化） | 有意分化，抽象收益低 |

**备选方案**：

- A. 现在建立公开 Unity Adapter API（Catalog Generator / Importer / Compiler / Debug Mapping 注册点）。
- B. 维持 per-domain batch 服务模式 + internal 共享层，公开 API 延后。
- C. 把 internal 共享层重构为显式 internal 模块（不公开，但结构化共享边界）。

**决策：B**（现有 internal 成员共享即 C 的轻量形态，暂不单独重构）。

拒绝 A 的理由：

1. 仅 2/4 领域落地。Graph（Catalog V4、端口/子图/连接规则，导出形态与字段模型差异最大）与 Table（纯消费方、无 Exporter、CSV/XLSX 载体与 table layout）恰是最能检验抽象是否成立的两类反例；此时冻结注册点 API 有较高概率在 VB-UX-05/06 被迫破坏性修订。
2. 公开 API 是永久 Package 契约：一旦公开，任何调整都需要版本协商；而编译产物格式本身还要经 VB-UX-07 Runtime 产物形态 spike 重估——先冻结产物消费方的注册契约，等于用最不确定的输入做最持久的承诺。
3. 当前不存在第三方消费者（私有 `UNLICENSED` 包），公开 API 没有现实需求方，只有假想需求方。
4. 复用价值已经通过 internal 共享兑现：字段构建、序列化、Hash、原子事务、路径校验零复制；per-domain 剩余重复仅 batch 包装（约 70 行/域）与领域绑定的注册表构建，属低频稳定代码。

重开条件（满足其一即重开决策，届时按本节格式追加新记录）：

- Graph 切片（VB-UX-05/06）完成后按其 exit criteria 做第三次轻量复核，若两域差异击穿 internal 共享层则升级为 C 或 A；
- 出现真实第三方集成需求（非假想消费者）；
- VB-UX-07 Runtime 产物形态冻结后，若产物消费方需要统一注册面。

**边界声明**：Table（VB-UX-04）与 Graph（VB-UX-05/06）继续按 per-domain batch 服务模式实施——各自实现 Exporter/Compiler/Batch/菜单，经 internal 成员复用共享字段构建、序列化、Hash 与事务实现，不新增公开注册点，也不把 internal 共享层当作公开契约对待。

第三次轻量复核（VB-UX-06 验收项，2026-08-31）：Graph Compiler（第三个、也是契约面最大的切片）实现时**零新增 private→internal 改动**——Entity/Table 建立的共享层（字段构建、序列化、Hash、事务、路径校验，约 20 个 internal 成员）原样承载了 Graph 的全部生命周期需求。VB-UX-03 的方案 B 决策成立，无需修订；internal 共享层在四个领域全部落地后结构稳定，若未来重开决策（见重开条件）可整体提取而不破坏既有切片。

## 14. 命令与验证层级

当前仓库没有独立发布的 VisualBridge CLI。命令行入口是 Protocol npm script 与 Unity batchmode `-executeMethod`，菜单和 batch wrapper 调用相同的 Exporter/Compiler 服务，不建立第二套业务规则：

- `npm run generate:protocol` / `npm run check:protocol`：生成或检查四个 Protocol 产物；
- `VisualBridge.Editor.VisualBridgeStructuredCatalogBatch.Generate` / `.Check`：Catalog Generate/Check；Catalog batch 以 `0` 表示成功、`2` 表示 drift、`1` 表示失败；
- `VisualBridge.Editor.VisualBridgeStructuredCompilerBatch.Generate` / `.Check`：Compiled artifact Generate/Check；Compiler batch 以 `0` 表示成功、`1` 表示 drift、`2` 表示失败；
- Unity Test Framework `-runTests -testPlatform EditMode`：运行 Package Editor tests。

所有 Unity 调用都必须显式提供 `-projectPath`、独立 `-logFile`，测试还需 `-testResults`；仅检查进程退出码不够，还要审计日志与 XML。根 README 给出固定 Unity `6000.3.10f1` 的可直接运行 PowerShell 命令。

验证分为五层：

1. **Protocol/Node gate**：生成漂移、Schema/manifest、现有 Parser/Registry、共享 Field parity 和文档检查。
2. **dotnet 快速编译**：对 Unity 生成的 C# project 执行 `dotnet build`，用于快速发现类型和程序集错误；它不等价于 Unity 导入成功。
3. **Unity batchmode refresh/import**：使用固定 Unity Editor 版本真实打开 `UnityProject`、解析本地 Package、刷新 AssetDatabase 并完成脚本编译。
4. **Unity EditMode 与 batch command**：运行 EditMode tests，并以 batch entry point 实际执行 Catalog Export 和 Structured Compile，检查 test results、日志、退出码和输出 Hash。
5. **Bridge E2E**：已于 2026-08-31 在真实 Unity Editor 与隔离 VS Code Extension Host 之间完成 open/reveal 验证，命令为 `npm run test:bridge-e2e`（见 [`ReleaseQuality.md`](ReleaseQuality.md)）；仅有协议单元测试或 batchmode 不能替代此证明。

当前开发宿主固定记录为 Unity `6000.3.10f1`。改变验证版本或声明更低最低版本前，必须重新执行 Package import、编译、EditMode 和垂直切片验证。完整版本兼容矩阵与使用者操作手册见 [`UnityIntegrationManual.md`](UnityIntegrationManual.md)。

完整 Unity 历史任务顺序、每项 exit criteria 和发布门槛见已归档的 [`Archive/UnityIntegrationRoadmap.md`](Archive/UnityIntegrationRoadmap.md)；当前未实现能力见 [`Backlog.md`](Backlog.md)。

## 15. 已冻结决策

- 首个 Unity 垂直切片是 Structured、offline、Editor-only。
- Editor Bridge 不是首切片前置，在离线 Export/Compile 完成后单独进入。
- Runtime、Debug、DAP 和 Player 不在本路线图（Editor 集成首路线图）范围内；后续阶段记录见已归档的 [`Archive/UnityDomainAndRuntimeRoadmap.md`](Archive/UnityDomainAndRuntimeRoadmap.md)，本机 Runtime 检查能力已落地（第 17、18 章），Player 与远程仍推迟（见 [`Backlog.md`](Backlog.md)）。
- Authoring Document 权威；Catalog 和 Unity artifact 是派生数据。
- Structured Compile 必须读取 Project File 并按 Document Type 解析 Config Type。
- C# contract 只从现有 Schema/manifest 生成，不建立手写第二来源。
- 普通 C# `class` / `struct` 与显式 metadata 是 Catalog 来源；C# 全名不是稳定身份。
- Exporter 不执行业务初始化方法获取默认值。
- Compiler 不修改 Authoring Project/File/Document，失败不破坏上次有效派生物。
- `VisualBridge.Runtime` 是 player-visible、无 Unity API 的程序集；它最初只允许无行为的 metadata marker，后按 §13.7 决策 B 升级为可进 Player 构建的运行时加载库并承载 Runtime Bridge（见 §5）。始终不建立的是 Unity Adapter public API（§13.3 决策 B）与 `ScriptableObject` Authoring 工作流。
- dotnet 只是快速编译；真实 Unity batchmode import、EditMode 和垂直切片执行是独立发布门槛。
- Runtime 实例发现采用「实例自写临时目录注册记录 + 心跳/pid 双信号陈旧判定 + 磁盘持久 generation + 显式选择」模型（第 17 章，VB-UX-08 实测冻结）；mid-play domain reload 的监听失效窗口由编辑器侧兜底处理。

## 16. 已关闭与仍待关闭的决策

Structured offline slice 已关闭：

- JSON 使用 `com.unity.nuget.newtonsoft-json` `3.2.2`；生成 C# DTO 是 wire/data bags，严格语义由 `JObject` validators 执行；
- manifest 以 `csharpGeneration.schemas` / `outputs` 登记 C# closure 与两份 byte-identical 输出；
- Profile 固定为 `ProjectSettings/VisualBridgeIntegration.json`，V1 只关联一个 Unity Project 内 Authoring Project，并拒绝外部/别名路径；
- metadata API 固定为 assembly `VisualBridgeStructuredCatalog`、type `VisualBridgeStructuredConfig` 和 field-only `VisualBridgeField`；
- Exporter canonical source snapshot、`sourceHash`、Generate/Check 与原子提交由确定性测试锁定；
- Compiler artifact、source mapping 与 managed manifest 当前固定为 `Library/VisualBridge/Compiled` 内部 Editor 格式，由 Compiler 测试锁定，尚未升级为公开跨语言 Schema。

已随 VB-UI-06/07 关闭（2026-08-31）：

- Editor Bridge 的 discovery、transport、authentication、message Schema 与真实 open/reveal E2E（见第 12 章）；
- Protocol、Package、VSIX、generator、compiler 与 Bridge 的完整发布兼容矩阵、空缓存 clean-checkout 复现和分发基线（兼容矩阵见 [`UnityIntegrationManual.md`](UnityIntegrationManual.md)，复现与基线记录见已归档的 [`Archive/UnityIntegrationRoadmap.md`](Archive/UnityIntegrationRoadmap.md) VB-UI-07）。

仍待条目必须在对应路线图任务中通过正式 contract、实现和自动验证关闭，不能由实现私有约定长期替代；offline artifact 若将来跨越 Editor 内部边界，也必须先进入正式 Schema。
