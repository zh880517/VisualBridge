# Pre-Unity Authoring 样例

这是在 Unity 集成存在之前覆盖全部四类内置 Authoring 文档家族的最小维护样例项目。它的源文件与 Catalog 刻意保持为可直接审阅的普通文件。

样例包含：

- 一个 `VisualBridge.project.vbjson` 项目；
- 自定义 `.encounter`、`.character`、`.settingsdata` 文档扩展名；
- Graph V3、Entity V1、Structured V1 与 Table CSV 文档；
- 配套的 Graph V4、Entity V1、Structured V1 与 Table V1 Catalog；
- 一个可选的 Project Provider V2 进程，提供 `sample.asset` 引用与一条告警诊断。

安装 VisualBridge VSIX 后在 VS Code 中打开本目录。项目自定义扩展名使用 **VisualBridge: Open Document** 或 VisualBridge Documents 视图打开；CSV 文件可用 **VisualBridge Table Editor** 打开。

先阅读仓库的[安装与快速开始](../../Doc/GettingStarted.md)，再用 [Authoring 使用手册](../../Doc/AuthoringUserGuide.md)了解四类编辑器、Document Browser、Lifecycle、引用、诊断与恢复。宿主与自动化接入方应阅读[项目接入与运维手册](../../Doc/IntegrationGuide.md)。

Project Provider 是受信任的项目代码。样例自带的 Provider 只在宿主允许其声明的入口、且 VS Code 工作区受信任时启动；若不需要 Provider 行为，从 `VisualBridge.project.vbjson` 中删除 `providers` 数组即可。

在仓库根目录用 VisualBridge 生产环境使用的同一套 Parser、Catalog Registry、Validator、Project 匹配器与 Provider 宿主验证整个样例：

```powershell
npm run test:samples
npm run check:docs
```

样例刻意只使用文本载体。XLSX 使用相同的 Table 语义模型，但为保持变更可直接审阅而未纳入本样例；确定性的 XLSX 往返覆盖由自动化 Table 测试套件负责。
