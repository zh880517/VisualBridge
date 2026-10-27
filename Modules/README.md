# Modules/ — 领域模块工作区

这里放**可以整体拷出仓库**的四个领域模块（graph / entity / structured / table）。工作区的唯一
对外依赖是 `Sdk/visualbridge-module-sdk-<version>.tgz`：模块源码只 `import "@visualbridge/module-sdk"`，
不 import 仓库里任何其它包。契约见 `Doc/Temp/dev-tasks/Appendix-D-ModulePlatform.md` §D.2 / §D.3。

## 布局

```
Modules/
  package.json          私有工作区（6 个 workspace；不在根 package.json 的 workspaces 里）
  package-lock.json     pin Sdk/*.tgz 的 integrity —— 只在 tgz 重建后生成
  .npmrc .nvmrc         与根同一套引擎/精确版本纪律
  build.targets.json    4 个模块的打包配置 + 7 个分发目标
  scripts/build.mjs     打包 + 分发（--check 只校验）
  scripts/check-dependencies.mjs
  Sdk/*.tgz             唯一被跟踪的二进制产物
  Shared/Form/          @visualbridge/form-editor（webview 表单基件）
  Shared/Ui/            @visualbridge/editor-ui（webview 共享 UI）
  Graph/ Entity/ Structured/ Table/
    index.ts            领域 facet 的公开面（宿主/测试从这里取）
    src/module.ts       模块入口：manifest + activate(host)（见下「入口形状」）
    src/                语义 + 会话 + create + mcp facet
    src/webview/        Webview UI（React，打进 bundle 的 webviews 文本）
    test/               语义/会话测试（只依赖 SDK tgz）
```

`Shared/Ui` 与 `Shared/Form` 必须在包内：四个领域 webview 对 `@visualbridge/editor-ui` 有 8 处、
对 `@visualbridge/form-editor` 有 6 处依赖（含 Graph 入口保持样式顺序的副作用 import），且 webview 是
bundle 的一部分 —— 它们不进来，"拷走 `Modules/` 即可用"这条契约就不成立。包名保持
`@visualbridge/editor-ui` / `@visualbridge/form-editor` 不变：改名会把"搬移"混进"改名"，评审无法分辨。

## 入口形状（三条硬约定）

1. **入口只导出 `manifest` 与 `activate(host)`。**
2. **入口不要导出 `webviews`。** `buildModule()` 的 wrapper 会用构建配置生成的那一份覆盖它
   （`ModuleSdk/src/build/index.ts:96-102`），入口自己导出的既不生效、也不报错 —— 最容易误以为
   生效的坑。`scripts/build.mjs` 的 `assertEntryShape` 会在打包前直接失败。
3. **输出名固定 `<editor>.vbmodule.js`。** 7 个 Project File 的 `modules[].entry` 全是
   `Modules/<editor>.vbmodule.js`，因此打包后不需要改任何工程文件。

`manifest` 最少四个字段：`id` / `version` / `apiVersion`（必须等于 `MODULE_API_VERSION`）/
`editors`；`sdkVersion` 只作诊断用。`activate(host)` 返回 `ModuleRegistration`（`editors[]` +
可选 `validateOptions` / `dispose`）。

`buildModule()` 返回的 `hash` 就是 `sha256:<hex>`，与 Project File `modules[].hash` 同形，可直接写入。

## 分发

`build.targets.json` 的 `targets` 是 7 个工程根目录（`TestData/*` 5 个、`Samples/PreUnityAuthoring`、
`UnityProject/VisualBridgeAuthoring`）。**每个目标只收它自己 Project File 里 `modules[].entry` 声明的那几个
bundle**：声明了却没有 bundle 是错误，目录里多出未声明的也是错误（`npm run check:targets` 会报
drift）。目标目录必须位于 `Assets/` 之外，否则 Unity 会把 `.vbmodule.js` 当资产导入。

## 命令

| 命令 | 作用 |
| --- | --- |
| `npm install` | 只在 tgz 重建后跑（`engine-strict` 要求 Node 22.22.1） |
| `npm run check` | 6 个 workspace 的 `tsc --noEmit` |
| `npm test` | 6 个 workspace 的测试 |
| `npm run build` | 打 4 个 bundle 并分发到 7 个目标 |
| `node scripts/build.mjs --no-distribute` | 只打 4 个 bundle，不写 7 个目标工程（`TestData/**` 只读时用） |
| `npm run check:targets` | 只校验分发与最新产物一致 |
| `npm run check:dependencies` | 依赖策略 |
