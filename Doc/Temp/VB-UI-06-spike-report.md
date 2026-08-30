# VB-UI-06 discovery/transport spike 报告（临时）

实施日期：2026-08-30。环境：Windows 10 19044、Unity 6000.3.10f1（真实编辑器进程）、VS Code 1.105.1（`@vscode/test-electron` 隔离扩展宿主）、Node 25.6.0、dotnet SDK 10.0.400。结论已提升进 `Doc/UnityIntegrationArchitecture.md` §12；本文件在任务结束时删除。

## 实验与证据

所有实验脚本位于 `%TEMP%\visualbridge-bridge-spike\`（任务结束前已随实验完成清理，不在仓库内）。

### 1. 独立进程传输矩阵（Node 服务器 ↔ C# 客户端）

模拟 VS Code 扩展宿主服务器的 Node 进程同时监听 named pipe 与 127.0.0.1 TCP，模拟 Unity 客户端的 C# 控制台程序完成同一交换：

| 场景 | named pipe | loopback TCP |
|---|---|---|
| connect | 0–3ms | 9–15ms |
| 请求往返（NDJSON 单行） | 6–7ms | 9–15ms |
| 无效 token | 拒绝（`invalidToken`，连接关闭） | 同左 |
| 非 JSON 行 | 拒绝（`invalidJson`） | 同左 |
| 目标不存在 | 超时（慢失败，受客户端超时控制） | 立即 `SocketException`（快速失败） |

### 2. 服务器重启与崩溃恢复

- 正常重启（generation 1→2）：discovery 记录被替换（新管道名、新 token、新 pid、generation 递增），客户端重读记录并以新 token 重连成功（响应 `serverGeneration:2`）。
- 强杀进程模拟崩溃：记录文件残留，心跳停止；客户端在心跳年龄 10.7s 时以 `stale discovery record` 拒绝——心跳陈旧性检测有效。

### 3. 真实 Unity 编辑器进程内传输（batchmode `-executeMethod`）

Unity 6000.3.10f1 编辑器进程（Mono，CLR 4.0.30319.42000）内直连 Node 服务器：

- named pipe：connect 1ms，往返 2ms；
- loopback TCP：connect 4ms，往返 5ms；
- 无效 token 被拒绝。

发现的实现陷阱（已记入设计约束）：

- C# `NamedPipeClientStream` 的 `pipeName` 必须是裸管道名（剥除 `\\.\pipe\` 前缀），传完整路径表现为超时而非快速失败；
- 管道路径在 JSON 中的反斜杠转义必须严格处理——正式实现必须使用生成的协议契约解析 discovery 记录，不允许手写简易解析器。

### 4. Domain Reload（真实 Unity batchmode，不带 `-quit`）

在编辑器进程内建立连接并保持，写入新脚本资产触发重编译 + Domain Reload：

- reload 前交换成功（`pong`）；
- reload 时服务器侧观察到连接断开（日志时间戳与重编译吻合）；
- reload 后 `static` 连接字段为 null（静态状态不存活）；
- reload 后约 0.8 秒内以同一 discovery 记录重连成功。

结论：Unity 侧连接与静态状态不能跨 Domain Reload 存活，重连与实例标识是必需机制。

### 5. 真实 VS Code 扩展宿主承载服务器（隔离 1.105.1）

用 `@vscode/test-electron` 启动隔离 VS Code 1.105.1，临时扩展在扩展宿主进程内启动 named pipe 服务器并写 discovery 记录，外部 Node 进程按记录连接并完成 `open` 交换：

- 客户端收到 `{"ok":true,"type":"open","handled":true}`；
- 服务器侧记录 `accepted open in extension host <pid>`。

结论：扩展宿主可以完整承载 Bridge 服务器，外部本机进程可发现并连接。

### 6. 多窗口 discovery

三个"窗口"记录（2 个存活、1 个心跳陈旧 61s、1 个 pid 已死但 mtime 新鲜）放入同一 discovery 目录：

- 陈旧心跳与死 pid 记录均被正确过滤；
- 候选枚举返回 2 个存活窗口；
- 按 `windowId` 显式选择后路由到正确窗口（响应携带该窗口标识）。

## 威胁模型（结论）

- **信任边界**：Unity Editor 与 VS Code 扩展宿主都以当前用户权限运行且非沙箱。Bridge 的安全目标是**防误路由与最小暴露**，不是防御同用户恶意进程——同用户进程本可直接读写任何文件。
- **攻击面**：named pipe / loopback TCP 仅限本机；discovery 记录位于用户本地临时目录，同用户进程可读写。
- **伪造 discovery 记录**：同用户攻击者可将 Unity 引导向恶意"服务器"。后果上限：恶意方获知 open/reveal 请求中的文档路径（稳定 ID），并可假冒接受；VS Code 端只执行 open/reveal，无写入面，不泄露 Authoring 内容。token 防的是偶发误连与跨用户（默认 ACL 下其他用户无法读取用户临时目录），不防同用户。
- **拒绝面（必须自动化覆盖）**：无效 token、协议版本/capability 不匹配、陈旧 generation、死 pid/陈旧心跳记录、Domain Reload 后的旧连接请求。
- **DoS**：本地同用户可占用管道名或端口——不在防御目标内（与既有"非沙箱"边界一致）。
- **泄露**：请求/响应只含稳定 ID 与路径，不含 Authoring 文档内容。

## 选型结论（进入架构文档 §12 冻结）

1. **传输**：Windows named pipe 为主端点（实测最快、无端口分配与防火墙面）；discovery 记录同时登记 loopback TCP 端点作为非 Windows 平台回退。消息为 NDJSON 行分帧，不复用 MCP envelope。
2. **Discovery**：文件型记录，`os.tmpdir()/Path.GetTempPath()` 下的 `visualbridge-bridge/<windowId>.json`，每 VS Code 窗口一份；心跳为每秒 touch mtime；陈旧判定 = 心跳年龄超阈值或 pid 已死。记录含 formatVersion、protocolVersion、capabilities、windowId、projectRoots、pipePath、tcpPort、token、pid、generation。
3. **认证**：每窗口 ≥192-bit 随机 token，仅存于记录；连接后首条消息验证，失败即断。
4. **版本/capability 协商**：记录声明 protocolVersion 与 capabilities；客户端不匹配即拒绝，不降级。
5. **实例 generation**：服务器每次 listen 递增并重写记录；客户端重连时检测 generation 变化并丢弃旧会话状态。Unity 侧每次 Domain Reload/重启生成新客户端实例 id；请求携带 requestId 供幂等。
6. **重连退避**：1s 起指数递增至 30s 上限；每次尝试前重新枚举 discovery。
7. **多窗口路由**：Unity 按 Integration Profile 的 authoringProject 与记录 projectRoots 匹配过滤；唯一候选直接路由（Project Registry 唯一解析语义）；多候选必须弹出显式选择；禁止"最近连接"。
8. **清理**：正常关闭删除自身记录；崩溃残留由心跳/pid 兜底；连接状态不写 Authoring/Project File/Integration Profile。
9. **WebSocket 拒绝理由**：扩展宿主需新增 `ws` 依赖、HTTP upgrade 握手开销、本场景无浏览器客户端；NDJSON over pipe/TCP 实测更简单且更快。
