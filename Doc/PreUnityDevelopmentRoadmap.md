# VisualBridge Unity 接入前开发任务清单

## 1. 目标与边界

本清单定义 VisualBridge 在正式编写 Unity Catalog Exporter、Importer、Compiler 或 Editor Bridge 之前必须完成的产品、工程与文档底座。任务按依赖顺序持续推进；每个任务完成后都必须更新本清单、执行对应验证、形成范围清晰的提交并推送到 `main`。

当前阶段不实现 Unity Exporter、Importer、Runtime、Debug、DAP、Player、Project Discovery File 或 WebSocket 通信，也不增加 Unity 测试。正式项目中的普通 C# class / struct 仍是未来 Catalog 的定义来源，Authoring 源文件继续是唯一权威数据。

状态含义：

- `pending`：尚未开始。
- `in_progress`：当前正在开发或验证。
- `complete`：实现、文档、自动化验证、提交和推送全部完成。
- `blocked`：只有不可恢复的外部环境或必须由项目方决定的协议歧义才能使用。

## 2. 已完成基线

- Graph Document V3 / Catalog V4、Graph Canvas、typed subgraph、动态端口、安全替换及语义测试。
- Entity / Component、Structured Config、CSV/XLSX Table 编辑器及共享 Form Field。
- Project 自定义 Document Type、任意扩展名识别、Catalog Registry 和确定性序列化。
- `document`、`entity.component`、`graph.element`、`table.row` Reference Provider、精确跳转及项目级重构。
- Document Browser、全工程诊断、引用与反向引用入口。
- Graph、Entity、Structured、Table MCP 读取、校验和原子 Operation；真实 stdio MCP 自动化测试。
- VSIX 构建与打包。

## 3. 执行顺序

### VB-PU-01 VS Code 自动化测试基线 — `complete`

范围：

- 使用官方 `@vscode/test-electron` 建立 Extension Host 集成测试。
- 固定测试插件激活、Project 发现、命令注册和项目自定义扩展名的编辑器路由。
- 使用本机 VS Code CLI 在隔离的 User Data 与 Extensions 目录中安装打包后的 VSIX，并验证扩展身份与版本。
- 测试过程不得污染用户现有 VS Code 配置或扩展目录。
- 将测试命令接入根级脚本和正式验证流程。

验收：

- `npm run test:vscode:host` 可重复运行并使用固定 VS Code 测试版本。
- `npm run test:vscode:cli` 对刚打包的 VSIX 完成隔离安装验证。
- 临时目录可安全清理；失败时保留足够的结构化日志。

### VB-PU-02 内置 Document 能力对齐与 MCP V2 — `complete`

范围：

- 补齐 Entity Catalog 查询、文档读取、校验、搜索和 EntityOperation 批量修改。
- 不继续复制每种 Document Type 的工具组；建立共享 Document Adapter Registry。
- 将 MCP 收敛为少量稳定的 Project、Catalog、只读 Document、Apply Operations、Reference 和 Refactor 工具，使用结构化 action / editor 判别。
- Graph、Entity、Structured、Table Adapter 只调用各领域既有 Parser、Catalog Registry、Validator、Operation 和 Serializer。
- 所有修改继续使用 `baseHash`、锁、原子替换和冲突拒绝。

验收：

- 四种内置 Document 均通过同一 MCP selector 与 Adapter 契约读取、搜索和校验；修改统一通过独立 Apply Operations 工具。
- 旧的重复工具在开发阶段直接移除，不保留不合理兼容层。
- 真实 stdio 测试覆盖四类文档、并发冲突、原子性和确定性结果。

### VB-PU-03 文档生命周期与安全删除 — `complete`

范围：

- 在 Document Browser 提供复制、路径重命名、移动和删除。
- 明确区分物理路径变化与稳定语义 ID 重命名。
- 复制时按 Document Adapter 声明的 remap 规则，为 Document 及需要全局唯一的内部元素生成新稳定 ID，只重写副本内部引用；对副本外目标的引用保持不变，未知引用类型拒绝复制。
- 删除 Document、Entity Component、Graph Element 或 Table Row 前预览入站引用和受影响物理来源。
- V1 只提供安全删除：存在入站引用时拒绝，不提供未定义的通用级联删除。
- 建立 VS Code 与 MCP 共用的 Lifecycle Service。预览返回 `previewHash`、完整目标 `baseHashes`、Project/Catalog 依赖 Hash 和确定性修改计划；执行阶段持有 Project 锁并重新构建计划，任何 Hash 或计划变化都拒绝提交。
- 多文件修改使用阶段化写入、原子替换和逆序回滚；CSV 分表与 XLSX 物理来源必须纳入同一项目事务。

验收：

- 文档创建、复制、移动、语义重命名和删除形成完整闭环。
- 跨 CSV 分表、XLSX 和文本 Document 的冲突与回滚有自动化覆盖。
- 同一生命周期请求从 VS Code 与 MCP 得到相同预览、冲突结果和确定性输出。
- 不通过字符串替换、文件后缀猜测或直接修改未知 JSON 实现。

### VB-PU-04 Project Provider V2 — `complete`

范围：

- 重新设计 Project File 的显式 Provider 声明；当前开发阶段不承担旧格式兼容。
- Provider 作为独立 stdio JSON-RPC 进程运行，不加载到 Extension Host。
- V2 只开放自定义 Reference Provider 和 Validator，返回候选、解析结果、稳定分页和诊断；不暴露 Operation 能力。只有出现第二个真实修改用例并证明共享边界后才设计 Provider Operation。
- 实现初始化、能力协商、Project 变化、关闭、超时、崩溃隔离、退避重启和结构化日志。
- 仅在 Workspace Trust 允许时启动，入口和参数按数组传递，不拼接 Shell 命令。
- VS Code 与 MCP 使用相同 Provider 契约和相同 Reference / Validation 结果。
- Provider 是具有当前用户文件权限的受信任工程代码，协议本身不构成操作系统沙箱；宿主必须监测 Authoring 源文件 Hash 变化并将越权写入报告为外部修改。
- MCP 默认禁用 Provider；启用必须同时满足显式宿主授权、Project 声明与规范化入口允许列表，工具调用不得临时提升权限。

验收：

- 固定样例 Provider 可提供自定义引用和诊断，并被共享 Field、Document Browser 与 MCP 使用。
- 未信任、超时、崩溃、非法响应和重启均有实际进程测试。
- 测试覆盖 MCP 默认禁用、显式授权启用、非法入口拒绝，以及 Provider 直接改写源文件时的外部变更检测与冲突拒绝。
- VS Code Workspace Trust 与独立 MCP 的 Provider 授权分别验证；MCP 请求参数不能绕过宿主授权。

### VB-PU-05 Project Settings 与 Catalog Browser — `complete`

范围：

- 提供 Project Settings 编辑器，管理 Document Root、Document Type、编辑器大类、include / exclude、Catalog、Table Layout 和 Provider。
- 检测 glob 重叠、文件归属歧义、路径越界、重复 ID 和无效 Catalog 绑定。
- 提供只读 Catalog Browser，查看 Registry、类型、alias、来源、冲突和诊断。Catalog 是外部定义导出的描述文件，当前阶段不提供通用 Catalog 编辑。
- 建立 Catalog `sourceHash` / 内容 Hash / 过期状态契约；在 Unity 尚未接入时允许 Catalog 明确标记来源未知。
- Project Settings 的修改经过结构化 Operation、校验、确定性序列化和外部变更检测；未来若引入明确标记的 `handAuthored` Catalog，再为其单独设计可写契约。

验收：

- 常用工程配置无需直接手写 JSON。
- Project 自定义扩展名、Table 行布局和 Provider 配置能从同一入口验证和修改。
- Catalog 冲突与过期状态能在 Browser 和 Problems 中定位。
- Catalog Browser 不会改写生成或外部维护的 Catalog 文件。

### VB-PU-06 大工程性能与编辑体验 — `complete`

范围：

- Workspace Document Index 改为按 Project、Document Type、Catalog 依赖和物理来源增量失效。
- 刷新支持取消、进度、合并重复事件和陈旧结果丢弃。
- Table Record 列表使用维护良好的虚拟化方案，不一次渲染全部记录。
- Table 与 Reference 搜索支持稳定分页或游标，保持严格类型、分表去重和显示名规则。
- 使用确定性生成器建立大文档、多 Catalog、数千 Document 和数万 Table Row 的性能输入，不向仓库提交巨型静态样例。
- Reference Service 与 Workspace Index 共享不可变语义快照；Provider 结果具备依赖键、缓存、失效和取消边界。

验收：

- 增量索引与完整扫描产生相同排序、诊断、Reference 和反向引用结果。
- 自动化断言单文件变化只调用受影响 Parser/Validator，且无关文件变化不重建全部 Project 语义状态。
- 大表滚动、搜索、选择和字段编辑具有稳定 DOM 节点上限，不随总记录数线性创建节点。
- Provider 缓存失效与取消有确定性断言；耗时和内存只生成基准报告，不作为跨机器固定阈值的 CI 失败条件。

### VB-PU-07 协议冻结、可靠性与发布门槛 — `complete`

范围：

- 在 `Protocol` 固化 Project、Catalog、Document、Operation、Diagnostic、Reference、Refactor、Document Lifecycle、Project Transaction、Provider RPC 和 MCP Tool Schema。
- 固定 `baseHash`、`sourceHash`、`catalogHash`、`previewHash`、依赖 Hash、稳定 ID、alias、版本和错误码规则。
- 固定搜索分页/游标、修改目标全集、锁和冲突响应，确保 VS Code、MCP 与 Provider 使用同一协议语义。
- 建立生成或一致性检查，避免 TypeScript、JSON Schema 与未来 C# 契约手工漂移。
- 增加真实 Extension Host 场景：保存、Undo / Redo、外部修改冲突、诊断发布、Reference 跳转和重构刷新。
- 增加 Provider/MCP 故障注入、多文件事务回滚、CSV/XLSX 往返和无关内容保留验证。
- 固定 Node、VS Code、MCP SDK 和依赖版本策略，完善 VSIX 元数据、CI 与示例工程。项目保持私有 `UNLICENSED`，除非所有者以后明确选择开源或商业许可证，不猜测许可证文本。

验收：

- `npm run check`、`npm test`、`npm run build`、`npm run package:vscode`、VS Code Host 测试、VSIX CLI 冒烟测试和 `git diff --check` 全部通过。
- 从空缓存安装依赖、构建、测试和打包可重复执行。
- Authoring 源文档与 Catalog 的交接契约不存在仍待决定的结构性字段；Project Discovery、WebSocket、Unity Import/Compile、Runtime 和 Debug 协议留到后续 Unity 路线图，不在本阶段伪冻结。

### VB-PU-08 最终文档审计与使用手册 — `complete`

范围：

- 本里程碑产出的正式文档是 Unity 接入前的最终交付基线；路线图、提交说明和 `Doc/Temp` 临时记录不能替代正式设计或使用手册。
- 在全部功能任务完成后逐项核对实现、Schema、测试、命令和正式文档，删除已经失效的未来式描述与重复约束。
- 确保总体架构、Project / Document / Catalog / Form / Reference / Refactor / Lifecycle / Transaction / Provider / MCP / VS Code Host / Index 与性能边界各自有完整且相互一致的正式设计，并明确安全与发布边界。
- 为 Project 发现、VSIX 安装与激活、文件路由、编辑事务、Document Lifecycle、CSV/XLSX 保存冲突与回滚、Reference 解析与重构、Provider Trust 与 MCP 授权、MCP 修改、索引刷新等关键多阶段流程补充必要的 Mermaid 流程图或时序图。
- 编写面向使用者的安装与快速开始、Project 配置、Graph、Entity、Structured、Table、Document Browser、文档生命周期、引用与重构、Project Settings 和 Catalog Browser 使用手册，并说明表格能力限制。
- 编写面向项目接入者的 Catalog、任意扩展名、Provider、MCP、锁与 Hash、冲突恢复、日志位置、Provider 授权和故障处理手册。
- 所有示例必须来自当前固定样例或经过验证的最小片段；命令、路径、字段名和截图不得引用已删除功能。
- 建立文档链接与锚点检查；示例必须通过对应正式 Parser 与 JSON Schema，而不只是 `JSON.parse`；Mermaid 必须实际解析或渲染；npm 命令和 VS Code Command ID 必须与 Manifest 自动核对。
- 创建完整的根 `README.md` 文档入口，验证根 README、VS Code Extension README 和所有正式文档之间的链接。
- 审计若发现文档与代码或 Schema 冲突，重新打开对应功能任务并修复实现、测试和文档，不以文字说明掩盖冲突。
- 建立“功能 / 设计 / 流程图 / 使用手册 / Schema / 自动化验证”完整性矩阵；任何已实现能力存在空项时，VB-PU-08 不得标记完成。
- 建立根级 `npm run check:docs`，自动执行上述链接/锚点、Parser/Schema 示例、Mermaid、npm Script、VS Code Command ID 和文档入口检查，并接入 CI 与完整发布验证。

验收：

- 新使用者能够只依据正式文档安装 VSIX、创建或打开 Project，并完成四类文档的核心编辑流程。
- 项目开发者能够只依据正式文档配置 Catalog、Document Type、Provider 和 MCP，并理解并发、原子性与安全边界。
- 设计、Schema、实际代码和自动化测试不存在已知冲突；`Doc/Temp` 不保留完成任务的临时文件。
- `npm run check:docs` 可重复通过，必要流程图能够由 Mermaid 工具解析，全部示例由产品 Parser/Schema 验证。

## 4. 每个任务的强制工作流

1. 在 `main` 上检查 `git status`、最新提交、相关正式文档和 CodeGraph 状态，保留所有既有用户修改。
2. 使用 CodeGraph 查找入口和影响范围，再用源码确认；涉及模块边界时先更新正式设计。
3. 先建立或更新固定样例与自动化断言，再实现共享 Core 和 Host Adapter，不复制领域规则。
4. 运行受影响包的快速检查；失败立即修复，不把已知错误留给下一任务。
5. 完成后运行完整 `npm run check`、`npm test`、`npm run build`、`npm run package:vscode`、适用的 VS Code Host/CLI 测试、已在 VB-PU-08 建立的 `npm run check:docs` 和 `git diff --check`。
6. 源码变化后执行 `codegraph sync .`，复核状态和影响测试。
7. 删除 `Doc/Temp` 中该任务的临时计划，只保留正式契约与本清单状态。
8. 查看最终 diff，确认没有 Unity 实现、生成缓存、用户文件或无关改动。
9. 在清单中将当前任务标记为 `complete`；只有当前路线图仍有下一项时，才把该项标记为 `in_progress`，并将状态变化包含在本任务最终 diff 中。
10. 使用单一关注点的祈使句提交，推送 `main`，确认本地 HEAD 与 `origin/main` 一致；只有当前路线图仍有下一项时才直接继续。VB-PU-08 完成后本路线图结束，Unity 工作必须先另立路线图，不在此处自动续接。

## 5. Unity 正式接入门槛

只有 VB-PU-01 至 VB-PU-08 全部为 `complete` 时，才开始 Unity Catalog Exporter、Importer 或 Editor Bridge。届时应单独形成 Unity 接入设计与任务清单，不把 Runtime、Debug 或 Player 默认包含在首个 Unity 垂直切片中。
