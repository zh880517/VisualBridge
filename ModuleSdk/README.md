# @visualbridge/module-sdk

VisualBridge 模块作者使用的只读 SDK。仓库把它打包成 `.tgz` 放进 `Modules/Sdk/`，模块工程不反向依赖主仓库源码。

## 子路径

| 子路径 | 用途 |
| --- | --- |
| `@visualbridge/module-sdk` | 模块契约类型（`ModuleBundle` / `ModuleRegistration` / facet）、Core 公开类型与 Protocol 领域类型再导出、`MODULE_API_VERSION` |
| `@visualbridge/module-sdk/webview` | Webview 骨架：ready proposal、token 回显、`postMessage` 封装、`--vb-*` 主题 Token |
| `@visualbridge/module-sdk/build` | `buildModule()` 与 `ModuleBuildError` |
| `@visualbridge/module-sdk/tsconfig/*.json` | 模块 / Webview 的 TypeScript 基础配置 |

## 最小模块

`buildModule` 从入口读取命名导出 `manifest` 与 `activate`，并注入 `webviews`。

```ts
import { MODULE_API_VERSION, type ModuleHost, type ModuleRegistration } from "@visualbridge/module-sdk";

export const manifest = {
  id: "visualbridge.example",
  version: "0.1.0",
  apiVersion: MODULE_API_VERSION,
  sdkVersion: "0.1.0",
  editors: ["example"],
};

export function activate(host: ModuleHost): ModuleRegistration {
  host.log("info", "example activated");
  return createRegistration(); // 至少返回一个 EditorRegistration
}
```

入口中的 `webviews` 导出不会被读取：`buildModule` 按配置中的 `webviews` 打包并注入虚拟模块。

`activate` 返回 `ModuleRegistration`（`editors`、可选 `validateOptions`/`dispose`）；
`editors` 至少一项，且每个 `EditorRegistration.webview` 必须命中 bundle `webviews` 的 key。

## 打包

构建配置是 CLI 自己的 JSON 输入，不属于 Protocol 文档或 Schema 示例（因此用普通文本围栏，不做 Schema 校验）：

```text
{
  "entry": "src/module.ts",
  "outfile": "dist/example.vbmodule.js",
  "webviews": {
    "example": "src/webview/index.ts"
  }
}
```

```powershell
visualbridge-build-module module.build.json
```

`buildModule()` 先用 esbuild 把每个 Webview 打成 IIFE + CSS，再打宿主入口
（CJS / node22）并把 Webview 文本注入虚拟模块。发布构建默认不写 source map；
产物必须可求值、manifest 合法，且只允许 `require` Node 内置模块。

## Webview 骨架

```ts
import {
  connectWebviewBridge,
  WEBVIEW_THEME_STYLE,
  type WebviewMessageTarget,
} from "@visualbridge/module-sdk/webview";

const bridge = connectWebviewBridge();
await bridge.ready;
bridge.postMessage({ type: "example.hello" });
```

- 模块脚本向宿主发送 `visualbridge.ready` proposal（含 `apiVersion` 与 token）；
- 宿主回显 `visualbridge.readyAck` 的 token 后 `ready` resolve；
- 握手消息不会转发给 `onMessage` 订阅者；
- 主题只消费 `--vb-*` 变量，`WEBVIEW_THEME_STYLE` 提供 VS Code 变量回落。

`referenceBridge` 的迁移不在本骨架范围；宿主负责生命周期握手、reference bridge
与调试窗口消息的路由。

## 仓库内维护

- `npm run build:sdk`：打包到 `Modules/Sdk/`；
- `npm run check:sdk`：重新打包后与已提交 tgz 比字节；
- tgz 由仓库内确定性 ustar + gzip(stored) packer 生成，不依赖 `npm pack`/zlib 版本；
- SDK 的声明会内嵌 Core 公开 `.d.ts` 与 Protocol `contracts.d.ts`，因此 Core
  公开 API 变化但未重打包也会被 `check:sdk` 检出。
