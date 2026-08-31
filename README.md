# VisualBridge

VisualBridge 是一个基于 VS Code 的游戏语义内容创作平台。当前版本提供 Graph、Entity、Structured Config、Table 四类 Authoring 文档的可视化编辑，共享 Catalog、Form、Reference、Project Transaction 和 MCP 语义，并以文本源文件或受约束的 CSV/XLSX 载体作为权威数据。

仓库现已落地首个 Unity Structured offline、Editor-only 垂直切片与第二个领域切片的 Entity Catalog Export：`Packages/com.kyle.visualbridge` 提供显式 C# metadata、固定 Profile、Structured 与 Entity Catalog Generate/Check，以及从 Authoring Project 到 `Library/VisualBridge/Compiled` 确定性派生产物的 Generate/Check（Entity 文档的 Unity 侧编译尚未实现）。它不依赖 VS Code 或 Bridge 在线运行。最小 Unity Editor Bridge V1 亦已落地：Unity Editor 可以通过本机 NDJSON 协议请求 VS Code 打开或定位 Authoring Document（open/reveal），协议契约见 `Protocol/Schema/visualbridge-editor-bridge.schema.json`，边界见 [Unity Editor 接入架构](Doc/UnityIntegrationArchitecture.md)。当前仍未实现 Runtime loader/行为、Debug、DAP、Player、设备发现或远程网络通信；Package 中名为 `VisualBridge.Runtime` 的程序集只是 player-visible、无 Unity API/无行为的纯 metadata marker surface，不是 Runtime 功能。

本项目是私有项目，所有 npm 包和 VSIX 均标记为 `UNLICENSED`。仓库内容不是公开分发许可证的授权。

## 当前能力

- 通过固定的 `VisualBridge.project.vbjson` 发现 Authoring Project，并按 Project 中的 `include` / `exclude` 和 `editor` 路由任意扩展名。
- 编辑 Graph V3、Entity V1、Structured Config V1，以及 UTF-8 CSV-compatible / XLSX Table V1。
- 使用共享 Form Field、Reference Picker、Document Browser、Project Settings 和只读 Catalog Browser。
- 预览并执行 Document Copy、Path Rename、Move、Safe Delete，以及项目级稳定引用重构。
- 通过 Project 锁、SHA-256 前置条件、阶段化写入、journal 和条件回滚保护 VS Code 与 MCP 的并发修改。
- 通过七个稳定的 stdio MCP V2 工具读取、校验和修改同一套 Authoring 数据。
- 在 Unity `6000.3.10f1` 中按 `ProjectSettings/VisualBridgeIntegration.json` 显式登记普通 C# Structured 类型，确定性导出 Catalog，并离线编译 Structured Document；首期 Profile V1 只关联 Unity Project 内的一个 Authoring Project。

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

Unity 开发宿主固定为 `UnityProject/ProjectSettings/ProjectVersion.txt` 记录的 `6000.3.10f1`。以下 PowerShell 命令分别执行刷新/编译、Structured/Entity Catalog Generate/Check、Structured Compile Generate/Check 与 EditMode tests；日志和结果写入临时目录，不进入产品 diff：

```powershell
$unityEditor = 'C:\Program Files\Unity 6000.3.10f1\Editor\Unity.exe'
$unityProject = (Resolve-Path .\UnityProject).Path

& $unityEditor -batchmode -nographics -quit -projectPath $unityProject -logFile "$env:TEMP\visualbridge-refresh.log"
& $unityEditor -batchmode -nographics -quit -projectPath $unityProject -executeMethod VisualBridge.Editor.VisualBridgeStructuredCatalogBatch.Generate -logFile "$env:TEMP\visualbridge-catalog-generate.log"
& $unityEditor -batchmode -nographics -quit -projectPath $unityProject -executeMethod VisualBridge.Editor.VisualBridgeStructuredCatalogBatch.Check -logFile "$env:TEMP\visualbridge-catalog-check.log"
& $unityEditor -batchmode -nographics -quit -projectPath $unityProject -executeMethod VisualBridge.Editor.VisualBridgeEntityCatalogBatch.Generate -logFile "$env:TEMP\visualbridge-entity-catalog-generate.log"
& $unityEditor -batchmode -nographics -quit -projectPath $unityProject -executeMethod VisualBridge.Editor.VisualBridgeEntityCatalogBatch.Check -logFile "$env:TEMP\visualbridge-entity-catalog-check.log"
& $unityEditor -batchmode -nographics -quit -projectPath $unityProject -executeMethod VisualBridge.Editor.VisualBridgeStructuredCompilerBatch.Generate -logFile "$env:TEMP\visualbridge-compile-generate.log"
& $unityEditor -batchmode -nographics -quit -projectPath $unityProject -executeMethod VisualBridge.Editor.VisualBridgeStructuredCompilerBatch.Check -logFile "$env:TEMP\visualbridge-compile-check.log"
& $unityEditor -batchmode -nographics -runTests -testPlatform EditMode -projectPath $unityProject -testResults "$env:TEMP\visualbridge-editmode.xml" -logFile "$env:TEMP\visualbridge-editmode.log"
```

Catalog 与 Compiler batch 统一返回 `0` 表示成功、`1` 表示执行失败、`2` 表示 Check 发现 drift。退出码之外还必须检查日志与 EditMode XML。Unity 生成的 `.csproj` 可再用 `dotnet build` 做快速编译检查，但不能替代 batchmode import 或 EditMode tests。

Editor Bridge 的端到端验证在真实 Unity Editor（非 batchmode）与隔离 VS Code Extension Host 之间执行 open/reveal 往返：

```powershell
npm run test:bridge-e2e
```

该命令同时启动两个进程（Unity 编辑器需已安装在本机，可用 `VISUALBRIDGE_UNITY_EDITOR` 覆盖路径），完成后双方各自退出并校验结果。完整边界见 [Unity Editor 接入架构](Doc/UnityIntegrationArchitecture.md)、[Unity Editor 接入任务清单](Doc/UnityIntegrationRoadmap.md) 与 [Release Quality](Doc/ReleaseQuality.md)。
