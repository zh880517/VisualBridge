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

（随实施填写）
