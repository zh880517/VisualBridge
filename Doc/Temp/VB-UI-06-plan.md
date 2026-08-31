# VB-UI-06 最小 Unity Editor Bridge 任务计划（临时）

本文件是 `Doc/UnityIntegrationRoadmap.md` VB-UI-06 的实施期任务计划，任务完成后删除。

## 决策记录

- 2026-08-30 暂停检查点（提交 `4b6b66d`）之后，项目方于同日授权恢复 VB-UI-06 实施。
- 项目方同步授权在 `Packages/com.kyle.visualbridge/Tests/Editor/` 新增 Bridge contract/状态机的 Unity EditMode 测试，满足现有 Exit criteria，不修改验收门槛。

## 阶段

1. **阶段 0 启动登记**：本计划、路线图与架构文档暂停状态更新、CodeGraph 同步。
2. **阶段 1 spike + 威胁模型**：候选本机传输（named pipe / loopback TCP / WebSocket / Unix domain socket）× discovery 机制实测矩阵；真实 Unity 6000.3.10f1 + 隔离 VS Code Extension Host 下验证 Domain Reload、进程重启、陈旧记录、重连退避、多窗口显式选择；威胁模型覆盖 token 生命周期与伪造 discovery；结论冻结进 `UnityIntegrationArchitecture.md` §12。选型证据完成前不写正式 Bridge 实现，不预选传输方案。
3. **阶段 2 设计冻结 + Schema**：Bridge 消息 Schema（envelope、open/reveal 请求/响应、错误码、版本/capability 协商、实例 generation）进入 `Protocol/Schema` 与 `contract-manifest.json`（含 C# 生成闭包登记）；重新生成四个产物；TS/Schema/C# parity 正反例先行。
4. **阶段 3 Unity 侧实现**：`VisualBridge.Editor` Bridge 模块（连接状态机、token、Domain Reload 存活与 generation 递增、仅 open/reveal）。
5. **阶段 4 VS Code Host 实现**：discovery 监听、Project Registry 唯一解析、多窗口显式选择、拒绝与资源释放；复用 `openDocument`/`revealReference`。
6. **阶段 5 自动化测试**：Unity EditMode（contract + 状态机）与 VS Code Host 集成测试。
7. **阶段 6 E2E 与收尾**：真实 Editor + 隔离 Extension Host 的 open/reveal E2E；Bridge 关闭时 VB-UI-04/05 回归；全套 Node/VSIX/dotnet/Unity/docs 门槛；删除本文件并更新路线图状态。

## 边界（全程有效）

- 只做 open/reveal；不写 Authoring/Catalog/Profile，不触发 Export/Compile，不启动 Provider，无 Runtime/Debug/Player 消息。
- 连接状态不写回 Authoring Document、Project File 或 Integration Profile。
- 多窗口显式路由，不建全局 `currentUnity` 或“最近连接”猜测。
- Bridge Schema 由同一 generator 生成 TS/C# contract，不复用 stdio MCP Tool envelope。

## 验证记录

### 阶段 1（2026-08-30，已完成）

spike 与威胁模型全部完成，证据与结论见 [VB-UI-06-spike-report.md](VB-UI-06-spike-report.md)，冻结设计已写入 `UnityIntegrationArchitecture.md` §12：

- 独立进程传输矩阵：pipe 往返 6–7ms、TCP 9–15ms，无效 token/非 JSON 拒绝，死端口快速失败、不存在的管道超时。
- 服务器重启/崩溃：记录替换与重连成功；崩溃残留由心跳陈旧性检测兜底。
- 真实 Unity 6000.3.10f1 编辑器进程：pipe 往返 2ms、TCP 5ms；发现 C# 裸管道名与 JSON 转义两个实现陷阱。
- Domain Reload：连接与静态状态不存活、reload 后立即重连成功。
- 隔离 VS Code 1.105.1 扩展宿主：宿主内管道服务器接受外部进程 open 交换。
- 多窗口：陈旧心跳/死 pid 过滤正确，显式 windowId 选择路由正确。
- 选型：named pipe 为主 + TCP 回退、NDJSON 分帧、文件型 discovery + 心跳/pid 陈旧判定、每窗口随机 token、generation 递增、指数退避重连、多候选显式选择；WebSocket 拒绝。
- 威胁模型：防误路由与最小暴露为目标，不防同用户恶意进程；攻击面/伪造记录/拒绝面/DoS/泄露逐项分析。

### 阶段 2（2026-08-30，已完成）

- 新增 `Protocol/Schema/visualbridge-editor-bridge.schema.json`（Editor Bridge V1：hello/welcome、open/reveal、response/error 消息与 discovery 记录），登记进 `contract-manifest.json`（`versions.editorBridge: 1`、C# 生成闭包）。
- `npm run generate`：15 个 Schema、4 个产物确定性生成；`--check` drift gate 通过；两份 C# 输出 byte-identical；`dotnet build VisualBridge.Editor.csproj` 通过。
- parity 正反例：`visualbridge-editor-bridge-cases.json`（23 例，覆盖消息与 discovery 记录）接入 `generate.mjs` 的 `verifyEditorBridgeExamples`（AJV 侧）；Unity EditMode 侧 parity 在阶段 5 补齐。
- `npm test --workspace @visualbridge/protocol-contract` 通过（含 7 个 MCP 工具 live check）；`check:docs` 仅余 Doc/Temp 任务文件提示（任务收尾时消除）。
- `ProtocolContracts.md`、`Doc/README.md`、`VisualBridgeArchitecture.md` 已同步 15 份 Schema 与 Bridge 契约范围。

### 阶段 3（2026-08-30，已完成）

- `Packages/com.kyle.visualbridge/Editor/Bridge/`：严格校验器（消息 + discovery 记录，错误码与 parity fixture 一致）、discovery 枚举器（心跳/pid 陈旧过滤）、客户端（hello/welcome 握手、generation 校验、请求/响应关联、能力检查）、服务门面（Profile 匹配、多窗口显式选择、指数退避重试）、`Tools/VisualBridge/Editor Bridge` 菜单 + EditorWindow。
- 实施期关键发现：Unity Mono 运行时进程内 Mono↔Mono named pipe 双端 `Write` 死锁（最小复现确认）；客户端改为 TCP 优先 + 管道回退的单线程同步请求/响应模型，架构文档 §12 已同步修正。
- EditMode 测试 `VisualBridgeEditorBridgeTests`（20 例）：parity fixture（AJV/C# 双端一致）、序列化往返、握手/open 请求、无效 token、版本不匹配、陈旧 generation、能力缺失、非法 JSON、未知 requestId、服务器断开、discovery 过滤、服务匹配与多窗口显式选择——全部通过。
- Unity batchmode 编译与 `dotnet build VisualBridge.Editor.csproj` 通过。

### 阶段 4 + 5（2026-08-31，已完成）

- `Tools/VSCodeExtension/src/bridge/`：`bridgeProtocol.ts`（严格 TS 校验器，与 Schema/C# 三方 parity）、`editorBridgeServer.ts`（named pipe + loopback TCP 双端点监听、per-window discovery 记录 + 每秒心跳、token 握手、open 经 Project Registry 唯一解析、reveal 经文档索引唯一解析并复用 `revealReference` 命令）。
- 激活接线：`projects/documents.initialize()` 后启动；启动失败不阻断扩展激活；projects 变更重写记录。
- wire 错误码补 `bridge.invalidMessage`（结构非法消息的连接级错误），Schema/manifest/C#/TS/fixture 同步并重新生成契约。
- 测试命令：`visualbridge.test.getBridgeServerState`、`parseBridgeMessage`、`parseBridgeDiscoveryRecord`。
- 宿主集成测试（隔离 VS Code 1.105.1）：parity fixture（24 例 TS 侧一致）、discovery 记录内容与 projectRoots、无效 token/非 JSON/非 hello 首消息拒绝、握手 welcome（generation/windowId）、unresolved open、open 打开 Structured 编辑器、reveal 101 → documentAmbiguous（跨工程歧义正确拒绝）、reveal "health" → Entity 组件定位并经 Webview 确认——全部通过；受限模式回归通过（exit 0）。

### 阶段 6（进行中）

待办：真实 Unity Editor + 隔离 Extension Host 的 open/reveal E2E、Bridge 关闭时离线切片回归、全套 Node/VSIX/dotnet/Unity/docs 门槛、清理 Doc/Temp、更新路线图状态。
