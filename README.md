# VisualBridge

VisualBridge 是一个基于 VS Code 的游戏语义内容创作平台。当前 Unity 接入前版本提供 Graph、Entity、Structured Config、Table 四类 Authoring 文档的可视化编辑，共享 Catalog、Form、Reference、Project Transaction 和 MCP 语义，并以文本源文件或受约束的 CSV/XLSX 载体作为权威数据。

当前仓库尚未实现 Unity Catalog Exporter、Importer、Compiler、Editor Bridge、Runtime、Debug、DAP、Player Discovery 或 WebSocket 通信。`Packages/com.kyl.visualbridge` 仍是未来 Unity Package 的占位目录；不要把现有 VSIX 或 MCP 能力理解为已经能够导入 Unity 或连接运行时。

本项目是私有项目，所有 npm 包和 VSIX 均标记为 `UNLICENSED`。仓库内容不是公开分发许可证的授权。

## 当前能力

- 通过固定的 `VisualBridge.project.vbjson` 发现 Authoring Project，并按 Project 中的 `include` / `exclude` 和 `editor` 路由任意扩展名。
- 编辑 Graph V3、Entity V1、Structured Config V1，以及 UTF-8 CSV-compatible / XLSX Table V1。
- 使用共享 Form Field、Reference Picker、Document Browser、Project Settings 和只读 Catalog Browser。
- 预览并执行 Document Copy、Path Rename、Move、Safe Delete，以及项目级稳定引用重构。
- 通过 Project 锁、SHA-256 前置条件、阶段化写入、journal 和条件回滚保护 VS Code 与 MCP 的并发修改。
- 通过七个稳定的 stdio MCP V2 工具读取、校验和修改同一套 Authoring 数据。

## 快速开始

仓库固定使用 Node.js `22.22.1` 和 npm `10.9.4`。在 PowerShell 中从仓库根目录执行：

```powershell
nvm use 22.22.1
node --version
npm --version
npm ci
npm run package:vscode
```

生成的私有 VSIX 位于 `Tools/VSCodeExtension/artifacts/visualbridge.vsix`。可以先运行隔离安装与激活冒烟测试；它使用临时 User Data 和 Extensions 目录，不会安装到当前 VS Code 配置：

```powershell
npm run test:vscode:cli
```

随后在 VS Code 中运行 **Extensions: Install from VSIX...**，或安装到当前用户配置：

```powershell
code --install-extension .\Tools\VSCodeExtension\artifacts\visualbridge.vsix --force
```

打开维护中的完整样例：

```powershell
code .\Samples\PreUnityAuthoring
```

VS Code 在工作区发现名为 `VisualBridge.project.vbjson` 的文件时自动激活扩展；只有样例 Project File 成功解析和校验后才建立 Project 功能。使用 Activity Bar 的 **VisualBridge / Documents** 打开四类文档；项目自定义后缀也可以通过 Explorer 的 **VisualBridge: Open Document** 进入相同路由。首次使用的完整步骤见 [安装与快速开始](Doc/GettingStarted.md)。

## 文档入口

- [安装与快速开始](Doc/GettingStarted.md)：构建、VSIX 安装、隔离验证、样例、Project 发现和任意扩展名路由。
- [Authoring 使用手册](Doc/AuthoringUserGuide.md)：四类编辑器、Document Browser、Lifecycle、Reference/Refactor、Project Settings、Catalog Browser 和冲突恢复。
- [正式文档目录](Doc/README.md)：架构、协议、MCP、Provider、事务、性能和发布设计。
- [VS Code Extension](Tools/VSCodeExtension/README.md)：扩展清单、公开命令、View ID、Custom Editor viewType 和开发验证。
- [Pre-Unity Authoring Sample](Samples/PreUnityAuthoring/README.md)：覆盖四类文档和可选 Project Provider V2 的维护样例。

## 开发与验证

常用根级门禁：

```powershell
npm run check
npm run audit:dependencies
npm test
npm run build
npm run check:docs
npm run package:vscode
npm run test:vscode:host
npm run test:vscode:cli
git diff --check
```

Unity 代码尚未进入当前实现范围；不要为了验证当前 TypeScript/VSIX 变更打开 Unity Editor。完整的工具链、CI 和发布边界见 [Release Quality](Doc/ReleaseQuality.md)。
