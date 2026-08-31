# 发布质量

本文定义 Node.js monorepo 与私有 VS Code 包的可复现 PU-07 发布门槛。它不新增公共许可证，也不新增 Unity 发布门槛。

## 固定工具链与依赖

- `.nvmrc` 与根 `engines.node` 把 Node.js 固定为 `22.22.1`。
- 根 `packageManager` 把 npm 固定为 `10.9.4`，即该 Node.js 发行版自带的 npm 版本。
- `.npmrc` 启用 `engine-strict` 与 `save-exact`。运行任何安装之前先切换到 `.nvmrc` 声明的版本；本地 Node.js 版本不符时应被拒绝。
- 工作区 manifest 中的每个外部 npm 依赖都使用精确的 `major.minor.patch` 版本。内部 `@visualbridge/*` 工作区依赖保持 `*`，使 npm 解析到本地工作区而不是 registry 包。
- 根的传递依赖 override 也使用精确版本。`exceljs` 被约束到 `uuid` 11.1.1，因为它声明的 `^8.3.0` 范围否则会选中受 GHSA-w5hq-g745-h8pq 影响的版本；VisualBridge 通过 ExcelJS 使用 CommonJS `v4` API，并把该路径保持在 Table/XLSX 测试覆盖之下。
- `package-lock.json` lockfile 版本 3 由 npm 10.9.4 生成，是唯一被接受的安装输入。发布与 CI 安装使用 `npm ci`，绝不使用会更新 lockfile 的安装。
- VS Code 兼容性声明保持 `^1.105.1`，而 Extension Host 运行时单独固定为 `1.105.1`，`@types/vscode` 固定为 `1.105.0`，`@vscode/test-electron` 固定为 `3.1.0`。

`npm run check:dependencies` 对根和每个声明的 npm 工作区强制执行这些不变量。它还检查每个包都是 private 且 `UNLICENSED`，校验 lockfile importer 与 override 解析、VS Code 测试运行器默认值，以及 `virtualWorkspaces.supported=false`。新增工作区会自动纳入该策略。`npm run audit:dependencies` 是独立的联网门槛，遇到中等级及以上的安全通告即失败。

## 本地干净复现

使用 Node 版本管理器选择声明的运行时，然后在安装前确认两个可执行文件：

```powershell
nvm use 22.22.1
node --version  # v22.22.1
npm --version   # 10.9.4
npm ci
npm run check
npm run audit:dependencies
npm test
npm run build
npm run check:docs
npm run package:vscode
npm run test:cli --workspace visualbridge
git diff --check
git status --short --untracked-files=all
```

如需显式的空下载缓存复现，把 npm 指向一个新建的临时目录。`npm ci` 总是删除并重建 `node_modules`；独立的缓存只包含下载内容，无法恢复构建产物或旧的依赖树。

```powershell
$releaseCache = Join-Path ([System.IO.Path]::GetTempPath()) ("visualbridge-npm-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $releaseCache | Out-Null
npm ci --cache $releaseCache
```

门槛跑完后可以删除该临时缓存。不要为了让报错的环境显得兼容，而从更新的本地 Node/npm 运行时更新 lockfile。

## Windows CI 门槛

`.github/workflows/ci.yml` 在全新的 GitHub 托管 Windows worker 上运行，执行以下有序门槛：

1. 检出确切的 revision 并安装 `.nvmrc` 声明的 Node 版本；
2. 在安装依赖之前核对实际的 Node 与 npm 版本；
3. 用已提交的 lockfile 运行 `npm ci`；
4. 运行依赖策略检查、中等级及以上的依赖审计、monorepo 类型检查、全部测试和完整构建；
5. 在产品解析器与 MCP 运行时构建完成之后校验正式文档；
6. 创建 VSIX 并通过已安装的 VS Code CLI 试用它；
7. 拒绝空白错误、已跟踪文件改动，以及由生成/构建/测试/打包产生的意外未跟踪文件；
8. 只上传最终的 VSIX 产物。

工作流用完整 commit SHA 固定第三方 GitHub Actions。`setup-node` 可以按 `package-lock.json` 缓存 npm 下载，但绝不缓存 `node_modules`、构建产物、VS Code 用户数据或已安装的扩展。测试会创建隔离的 user-data、extension、workspace 和 Provider 进程状态。

## VSIX 证据与分发边界

常规 Extension Host 套件使用固定的官方 VS Code 运行时，基于复制的夹具覆盖受信任与 Restricted Mode 两种激活。打包测试随后把产出的 VSIX 安装到隔离的扩展目录，核对其确切的 `kyl.visualbridge` 身份与必需的打包文件，启动固定的 VS Code 运行时，等待 `workspaceContains` 激活，调用一个已注册命令，并通过已安装的自定义编辑器打开一个 Graph。仅 CLI 安装成功不视为激活证明。

扩展 manifest 为 `private: true` 与 `license: "UNLICENSED"`。`Tools/VSCodeExtension/LICENSE` 是随 VSIX 附带的显式专有声明；它不授予公共使用权。`virtualWorkspaces.supported` 显式为 `false`：Project 发现、本地 Catalog/源码访问、原子写入和 Project Provider 子进程都需要本地文件系统工作区。Restricted Mode 仍受支持，但 Provider 进程不会在那里启动。

## 维护中的示例项目

`Samples/PreUnityAuthoring` 是 Unity 接入前使用的正式、可文本审查的项目。它包含一个 Project 文件、自定义 Graph/Entity/Structured 文档扩展、全部四个内置 Catalog/文档家族、一个与分区兼容的 UTF-8 制表符分隔 CSV Table，以及一个可选的 Project Provider V2 示例。这个最小示例有意省略 XLSX；其二进制往返覆盖由 Table 测试套件负责。

运行 `npm run test:samples`，针对该示例运行生产版 Project 解析器与匹配器、Graph/Entity/Structured/Table 的 Catalog 注册表与校验器、类型化 CSV 解析器以及 Project Provider 宿主。运行 `npm run check:docs`，把其文档化的入口和绑定 schema/parser 的示例与正式手册一起校验。示例 README 说明了如何从已安装的 VSIX 打开它，以及如何移除可选的可信 Provider 声明。
