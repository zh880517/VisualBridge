# 仓库协作规范

## 项目结构与模块组织

VisualBridge 是平台实现的 monorepo。`Core/` 存放与宿主无关的 TypeScript 领域逻辑，不得引用 VS Code、Webview DOM 或 Unity API。`Protocol/` 负责 Schema、消息与生成的跨语言契约。可复用的宿主侧 Webview UI 放在 `Editors/Ui`，Project 文件编辑逻辑在 `Editors/Project`；领域文档类型与编辑器实现放在 `Modules/<领域>`，由 `ModuleSdk/` 构建成 `Modules/*.vbmodule.js` bundle 分发（`Modules/Shared/{Ui,Form}` 是模块侧的共享层副本）。宿主集成位于 `Tools/VSCodeExtension/` 与 `Tools/VisualBridgeMcp/`，两者共用的 Project Transaction 实现在 `Tools/NodeHost/`。其余工具 workspace 各司一门门禁：`Tools/ProtocolContract/`（契约生成与一致性检查）、`Tools/Documentation/`（`check:docs` 文档门禁）、`Tools/SampleValidation/`（样例语义验证）、`Tools/LargeCorpus/`（确定性大工程语料与基准）；`Tools/DependencyPolicy/` 不是 workspace，只承载 `check:dependencies` 的策略脚本。固定 fixtures 在 `TestData/`，维护样例工程在 `Samples/PreUnityAuthoring/`。Unity Package 源码在 `Packages/com.kyle.visualbridge/`，分 `Runtime/`（`Metadata/` 的 attribute 与 `Bridge/` 的 Runtime Bridge、编译产物只读加载、Graph 执行采集门面，`noEngineReferences`、可进 Player 构建）与 `Editor/`（Profile、三域 Catalog Exporter、四域 Compiler、Editor Bridge 客户端、Runtime Bridge 的 Play 模式宿主与 batch 入口）；`UnityProject/` 只是它的开发宿主，Unity 资产在 `UnityProject/Assets/`。

正式文档统一保存在 `Doc/`。任务计划与临时设计笔记放在 `Doc/Temp/`，任务完成后删除。修改模块边界前先阅读 `Doc/VisualBridgeArchitecture.md`（索引）及其核心领域、Authoring/扩展、宿主集成三份子文档。

## 语言规范

- 仓库内全部文档使用中文撰写（含 README 与正式设计文档）；代码标识符、命令、Schema 字段名等机器契约保持英文。
- 源码中的关键注释同样使用中文；注释保持精简，只保留解释约束、意图或非显然行为的部分，不写复述代码的流水账注释。
- 生成产物（如 Protocol 契约文件）中的注释由生成器模板输出，模板修改后必须重新生成并保证一致性。

## 构建、测试与开发命令

使用 `.nvmrc`、`engines.node` 与 `packageManager` 声明的 Node.js 22.22.1 和 npm 10.9.4。安装前先切换 Node 版本；`.npmrc` 会在运行时不匹配时直接报错，这是刻意设计。

- `npm ci` — 按根 lockfile 安装确定的 monorepo 依赖。
- `npm run check` — 依赖策略检查、Protocol 生成一致性检查，以及全部 workspace 的 TypeScript 类型检查。
- `npm run build` — 先准备 `Modules/*.vbmodule.js`（`prepare:modules`），再编译 Core、ModuleSdk、NodeHost、`Modules/` 的四个领域包、`Editors/Ui` 与 `Editors/Project`、LargeCorpus、SampleValidation、VS Code 扩展与 MCP，并把扩展 bundle 到 `Tools/VSCodeExtension/dist/`。
- `npm run build:modules` / `npm run build:bundles` — 按 `Modules/` 的独立 lockfile 安装依赖并构建/分发四个领域 bundle 到各工程 `Modules/` / 只重新生成 `Modules/*.vbmodule.js`。
- `npm run build:sdk` / `npm run check:sdk` — 重新生成 / 校验 `Modules/Sdk/` 下的确定性 SDK tgz（字节基线；打包器不依赖 npm/tar）。
- `npm run prepare:modules` — 确保 `Modules/` 依赖与 `Modules/*.vbmodule.js` 就位（存在即跳过；`check`、`test`、`check:docs` 都隐式依赖这些产物）。
- `npm test` — 运行全部 workspace 测试：Core 与四个领域的语义套件、各编辑器包、NodeHost、MCP、Protocol 契约、扩展单元测试，以及两次隔离 Extension Host 自动化（trusted 与 Restricted Mode，会启动真实 VS Code）。
- `npm run package:vscode` — 在 `Tools/VSCodeExtension/artifacts/` 下生成 VSIX。
- `npm run install:vscode` — 打包 VSIX 并安装到本地 VS Code（需要 code CLI 在 PATH；可用 `CODE_CLI` 环境变量指定其它路径）。
- `npm run test:vscode:host` — 单独运行扩展的隔离 Extension Host 集成测试。它内部会先 `clean`（递归删除 `dist/` **和 `artifacts/`**）再重建，因此绝不能排在 `package:vscode` 与 `test:vscode:cli` 之间，否则刚生成的 VSIX 会被删掉。
- `npm run test:vscode:cli` — 打包 VSIX、安装进隔离的 VS Code 用户/扩展目录并验证打包后的运行时资产。
- `npm run test:bridge-e2e` — Editor Bridge 端到端门槛：真实 Unity Editor（非 batchmode）与隔离 Extension Host 之间跑 open/reveal 往返。
- `npm run test:runtime-e2e` — Runtime Bridge 端到端门槛：batchmode 托管 Play 模式与隔离 Extension Host 之间跑发现/快照/事件往返。两者都要求本机存在 `UnityProject/` 与 Unity `6000.3.10f1` 可执行文件，默认路径可用 `VISUALBRIDGE_UNITY_EDITOR` 覆盖。
- `npm run generate:protocol` / `npm run check:protocol` — 重新生成 / 校验 Protocol 的 TypeScript 与 C# 产物（两份 C# 输出必须字节一致）。
- `npm run check:docs` — 校验正式文档覆盖、链接、锚点、Mermaid 图、命令/编辑器 manifest 与绑定 Schema 的 JSON 示例。
- `dotnet build .\UnityProject\Assembly-CSharp.csproj` — 不打开 Unity Editor 快速编译检查运行时 C#（传递引用 `VisualBridge.Runtime.csproj`）。
- `dotnet build .\UnityProject\Assembly-CSharp-Editor.csproj` — 快速编译检查 Editor-only C#（传递引用 `VisualBridge.Editor.csproj`）。两者都不覆盖 `VisualBridge.Editor.Tests.csproj`，EditMode 测试只能用 Unity batchmode `-runTests -testPlatform EditMode` 验证。
- `git diff --check` — 审查前检查空白符错误。

## 代码智能

- 项目索引可用时，优先用 CodeGraph 查符号关系、入口、调用方/被调用方与变更影响分析。
- 源码变更后先执行 `codegraph sync .`，再依赖影响面或受影响测试结果。
- CodeGraph 只作为导航证据；报告结论前必须在源码与对应构建或自动化验证中确认行为。

在 VS Code 中打开仓库根目录并按 `F5` 启动 Extension Development Host。Unity 生成的 `.csproj` 文件不得手工编辑。

## Unity Editor 控制（Unity CLI）

本机装有 Unity CLI（beta），配合 UnityProject 的 `com.unity.pipeline` 包（Unity 6000.3.10f1）驱动运行中的 Editor，用于 Unity 侧开发与桥接通信调试。

- CLI 位于 `%LOCALAPPDATA%\Unity\bin\unity.exe`，不在 shell PATH 上，用全路径调用。
- `unity.exe open <UnityProject 路径>` 启动 Editor；执行命令前设置 `UNITY_PROJECT_PATH`。`unity command` 列出并调用 Editor 暴露的全部命令。
- `unity status` 在 Editor 已连接时也报无实例，属已知怪癖；实例发现用 `unity pipeline list`。
- `unity command eval --code 'return <表达式>;'` 在活的 Editor 里执行任意 C#（必须是语句形式，取值用 `return`），可直接访问 `VisualBridge.Runtime` / `VisualBridge.Editor` 程序集。有活的 Editor 时优先用它驱动场景、GameObject、资产与运行时状态检查，不要手改 `.unity` / `.prefab` / `.asset` YAML。
- 触发 domain reload：无脚本变更时 `unity command recompile` 返回 up_to_date、不会重载；强制全量重编译用 eval 执行 `UnityEditor.Compilation.CompilationPipeline.RequestScriptCompilation(UnityEditor.Compilation.RequestScriptCompilationOptions.CleanBuildCache)`，再轮询 `recompile_status` 至 completed。
- domain reload 期间 pipeline 连接会短暂中断，CLI 调用失败时等待后重试即可，不要据此重启 Editor；编译结果用 `recompile_status` 与 Editor 日志（`%LOCALAPPDATA%\Unity\Editor\Editor.log`）确认。
- 同机运行着项目方自己的 Unity 实例（如 Unity 2019 的 mltrunk）。严禁终止任何 Unity 进程，除非已核对其命令行参数确认属于本仓库 UnityProject。

## 编码风格与命名约定

使用 UTF-8 与文件末尾换行。C# 缩进四空格，TypeScript/JSON 缩进两空格。C# 类型与公开成员用 `PascalCase`，局部变量与参数用 `camelCase`，既有仓库目录名保持 `PascalCase`。保持文件聚焦，C# 尽量一个公开类型一个文件。依赖方向不可破坏：Protocol → Core → VS Code/MCP 适配器；Unity 只消费生成的协议契约，不引用 TypeScript Core 代码。

Webview UI 优先使用维护中的开源 React 组件而非自研浏览器控件：无障碍交互基元用 Base UI，共享功能图标用 Lucide React，颜色编辑用 `react-colorful`；仓库 CSS 使用 Visual Studio Code 主题变量。新增 UI 依赖前评估许可证、维护状态、React 兼容性、包体积与 CSP 行为。不得使用已归档的 `@vscode/webview-ui-toolkit`。

## 测试指南

`npm test` 运行固定的 Core、Graph、Entity、Structured、Table 与 MCP 语义套件，外加 NodeHost 事务、各编辑器包、Protocol 契约、扩展单元与两次隔离 Extension Host 自动化。宿主无关的测试放在 `Core/` 或对应领域模块（`Modules/<领域>`）旁，可复用 fixtures 统一放在 `TestData/`。未设定覆盖率门槛。除非明确要求，不新增 Unity 测试。Unity 变更的门槛不止 `dotnet build`：`dotnet build` 只是快速编译证据，真实门槛是 Unity batchmode 的三域 Catalog Generate/Check、四域 Compile Generate/Check（退出码 `0`/`1`/`2`，`2` 表示 Check 发现 drift）与 EditMode `-runTests`，改动 Editor Bridge / Runtime Bridge 时还要跑 `npm run test:bridge-e2e` / `npm run test:runtime-e2e`；完整命令块见 `Doc/UnityIntegrationManual.md` 第 10 节。当生成工程文件或 Unity 程序集不可用导致验证受限时，如实报告。

## 提交与 Pull Request 指南

使用简短祈使句主题（如 `Add document operation registry`），每次提交只关注一件事。Pull Request 应说明受影响模块、架构影响、已执行的验证与已知限制。Webview 变更附截图；协议或生成契约变更必须显式指出。
