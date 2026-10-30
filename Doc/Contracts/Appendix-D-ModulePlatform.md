# 附录 D · 模块平台契约（固化自草案 M）

> 本附录是模块体系（Project 格式、bundle、注册契约、授权、构建）的**唯一依据**。

## D.1 Project File v2

```text
{
  "formatVersion": 2,
  "projectId": "visualbridge.entity-semantics",
  "documentRoots": ["Config", "Tables"],
  "modules": [
    { "id": "visualbridge.entity", "entry": "Modules/entity.vbmodule.js" },
    { "id": "visualbridge.table", "entry": "Modules/table.vbmodule.js",
      "options": { "tableLayout": { "nameKeyRow": 2, "dataStartRow": 3 } } }
  ],
  "documentTypes": [
    { "id": "hero-config", "editor": "entity",
      "include": ["Config/Entities/**/*.herojson"], "exclude": [],
      "catalogs": ["Catalog/Common.vbentitycatalog"] }
  ],
  "providers": []
}
```

- `formatVersion` 只接受 `2`；`1` 报 `project.formatVersionUnsupported`，**不自动升级**。
- `modules` 必填（可为空数组）；`id` 在 Project 内唯一且必须等于 bundle 的 `manifest.id`；内置 id 固定为 `visualbridge.graph|entity|structured|table`，editor id 仍是 `graph|entity|structured|table`。
- `entry`：Project 内规范化、`/` 分隔、无 `.`/`..`、真实路径不越界且非符号链接别名，后缀必须 `.vbmodule.js`。
- `options`：可选 JSON 对象；Core 只校验是对象，内容由模块 `validateOptions` 校验，诊断定位到 `modules[i].options`。
- `hash`：可选 `sha256:<hex>`；声明后加载时比对，不符报 `module.hashMismatch` 并停用；省略则只记录。
- 两段校验：Core 只校验结构；模块加载后宿主再检查每个 `documentTypes[].editor` 恰好由一个已加载模块提供。多个模块声明同一 editor/分类 → 按 `modules` 顺序保留第一个，其余 `module.editorConflict` 并停用。
- Project Operation：`addModule` / `upsertModule` / `removeModule` / `moveModule` / `setModuleOptions`；不提供 rename（id 必须与 manifest 一致）；`setTableLayout`/`clearTableLayout` 删除。
- `tableLayout` 语义不变（`nameKeyRow ≥ 1`、`dataStartRow > nameKeyRow`），位置移到 `visualbridge.table` 的 `options.tableLayout`，校验移到 Table 模块。

### D.1.1 装载/注册形状的过渡态（第三轮定稿）

loader 同时接受 A2 的 `adapter.parse/build` 与 Core `CatalogFacet`；`create` 同时接受 `choices/render` 与 `prepare(input)`：前者是进程内注册源（`BuiltInExtensions/*` 与 MCP 的 `BUILT_IN_MODULE_REGISTRATIONS`）仍在用的形状，后者是 bundle 的形状。两者语义等价、只差一层适配，因此允许共存；当 `BuiltInExtensions/*` 全部改为 bundle 装载后删掉 A2 一侧。

| facet | 进程内注册源（A2） | bundle（Core / SDK） |
| --- | --- | --- |
| `catalog` | `extensions` + `adapter.parse` / `adapter.build` | `CatalogFacet`：`extensions` + `parse` / `build` / `createRegistry` / `definitions` / `registryDefinitions` |
| `create` | `choices(context)` / `render(choice, context)` | `prepare(input)` |
| `session` | `state(document)` / `handle(message, document, host)` 的**实例** | `createController(input)` 的**工厂**（`ModuleSessionFactory`） |

- **session 实例分支的删除条件**：当 `Modules/scripts/check-dependencies.mjs` 的 bundler 清单里不再有任何模块（`Modules/*/src/module.ts`）以 `state`/`handle` 实例形式登记 session，且 `Modules/*/src/module.ts` 全部只出现 `createController` 时，删掉 loader 的实例分支。
- 两种形状都由 `ModuleLoader` 的 registration 校验逐项识别（`catalog` 认 `adapter.parse/build` 或 Core `CatalogFacet`，`create` 认 `choices/render` 或 `prepare(input)`，`session` 认 `createController` 或 `state`/`handle`）；缺任一侧即 `module.registrationInvalid`。
- `session` 与 `webview` 是**必填**且**必校验**：registration 完全没有 `session`、或 `webview` 的键不在 bundle 的 `webviews` 里（`webviews` 是空对象时同样不豁免），一律 `module.registrationInvalid`。这是 HEAD 的严格行为，过渡期不放开——四个 bundle 的 `webviews` 都已非空、`session` 都已登记，之前放宽的前提（UI 尚未搬进 `Modules/`）已经消失。
- 过渡期里"bundle 的注册面"与"进程内注册源"必须**语义等价**：`CatalogFacet.parse` 与 `adapter.parse` 都是"文本 + 来源路径 → 解析结果"，`create.prepare` 与 `choices` 都产出宿主可直接创建的文档。适配层只做形状转换，不得改变语义。

### D.1.2 为什么 `Shared/Ui` 必须进包

- "把 `Modules/` 整个拷出仓库仍然可用"是本工作区的契约，而 **Webview 是 bundle 的一部分**：`buildModule()` 用 esbuild 把 `src/webview/index.tsx` 连同它 import 的一切打成 IIFE 字符串，再注入 `.vbmodule.js` 的 `webviews[key].script`。任何留在包外的运行时依赖都会让产物指向仓库内源码，拷贝后直接失效。
- 四个领域 webview 对 `@visualbridge/editor-ui` 有 8 处、对 `@visualbridge/form-editor` 有 6 处依赖（含 Graph 入口的副作用 import，用于保持样式层叠顺序）。它们不是"宿主侧可选增强"，而是 Webview 首屏就执行的代码，因此必须随 `Modules/` 一起被解析：目录移到 `Modules/Shared/Ui` 与 `Modules/Shared/Form`，包名保持不变（`@visualbridge/editor-ui` / `@visualbridge/form-editor`），import 改写成包内相对路径。
- 包名不变是为了让"搬移"与"改名"在 diff 里可分辨；依赖策略仍要求 `Modules/` 内一切包 `private` + `UNLICENSED`、版本精确，且除 `@visualbridge/module-sdk` 的 tgz 外不得依赖仓库内部包。

## D.2 Bundle

```js
module.exports = {
  manifest: { id: "visualbridge.graph", version: "0.1.0", apiVersion: 1,
              sdkVersion: "0.1.0", editors: ["graph"] },
  activate(host) { /* 返回 ModuleRegistration */ },
  webviews: { graph: { script: "<IIFE 文本>", style: "<CSS 文本>" } },
};
```

- 只允许 `require` Node 内置（`module.isBuiltin`）；其余依赖全部打进文件；发布构建不带 source map。
- 构建：先用 esbuild 打 Webview（`iife` + CSS，`platform: browser`、`target: es2022`、`minify`），再打宿主入口（`platform: node`、`format: cjs`、`target: node22`、`bundle: true`），把前者作为字符串注入虚拟模块；最后校验可求值、manifest 合法、无非内置 require。
- 装载：读字节 → SHA-256 → `vm.compileFunction(code, ["module","exports","require"], { filename })`，`require` 只放行内置；**这不是沙箱**，模块与宿主同权限、同进程。
- 状态：`loaded` / `failed` / `untrusted` / `disabled` / `stale`。失败只影响该模块提供的 editor（回退只读 Shell）。
- 错误码：`module.invalidPath` / `module.entryAlias` / `module.notFound` / `module.hashMismatch` / `module.loadFailed` / `module.manifestInvalid` / `module.idMismatch` / `module.apiVersionMismatch` / `module.activateFailed` / `module.registrationInvalid` / `module.editorConflict` / `module.referenceKindConflict` / `module.optionsInvalid` / `module.untrusted` / `module.disabled` / `module.callFailed`。
- `apiVersion` 为整数，第一阶段宿主只接受等于 `MODULE_API_VERSION` 的值；`sdkVersion` 只诊断、不门禁。

## D.3 注册契约

```ts
export const MODULE_API_VERSION = 1;

export interface ModuleBundle {
  readonly manifest: ModuleManifest;
  activate(host: ModuleHost): ModuleRegistration | Promise<ModuleRegistration>;
  readonly webviews: Readonly<Record<string, { readonly script: string; readonly style: string }>>;
}

export interface ModuleRegistration {
  readonly editors: readonly EditorRegistration[];
  validateOptions?(options: JsonObject | undefined): readonly DocumentDiagnostic[];
  dispose?(): void;
}

export interface EditorRegistration<TDocument = unknown, TRegistry = unknown> {
  readonly editor: string;
  readonly storage: TextStorage<TDocument, TRegistry> | SourcesStorage<TDocument, TRegistry>;
  readonly catalog?: { readonly extensions: readonly string[];
                       readonly adapter: CatalogAdapter<unknown, TRegistry>;
                       /** 宿主 Catalog 视图与工程绑定校验用的定义枚举（B3 回填）。 */
                       readonly definitions(catalog: unknown): readonly CatalogDefinitionEntry[];
                       readonly registryDefinitions(registry: TRegistry): readonly CatalogDefinitionEntry[] };
  readonly semantic: SemanticDocumentAdapter<TDocument, EditorContext<TRegistry>>;
  readonly referenceData?: (document: TDocument, context: EditorContext<TRegistry>) => unknown;
  readonly references?: readonly ReferenceKindRegistration[];
  readonly create?: CreateFacet<TRegistry>;
  readonly session: SessionFacet<TDocument, TRegistry>;
  readonly webview: string;
  readonly webviewTitle: string;
  readonly reveal?: { readonly messageType: string; readonly resultMessageType: string;
                      readTarget(location: ReferenceLocation): JsonValue | undefined;
                      createMailbox(): RevealMailbox };
  readonly mcp?: McpFacet<TDocument, TRegistry>;
  readonly operationSchema?: JsonObject;
  readonly debug?: DebugFacet;
}
```

facet 职责：

| facet | 职责 |
| --- | --- |
| `storage` | `text`：`DocumentCodec`（parse/render）；`sources`：`planSources(paths)` / `parse(sources)` / `render(document, previous)` 返回各源新字节 |
| `catalog` | Catalog 扩展名 + `CatalogAdapter`；宿主负责读取与缓存；`definitions` / `registryDefinitions` 让 Catalog 视图与工程绑定校验不按 editor 分支（B3 回填，`CatalogDefinitionEntry = { kind, id, title, aliases }`） |
| `semantic` | `describe` / `validate` / `applyOperations` / `references` / `lifecycle`；另有两个**可选**钩子 `guardOperations` / `validateTransition`（见 D.3.1） |
| `referenceData` | 提取本模块 Reference kind 所需的索引数据；宿主当不透明值存进语义快照 |
| `references` | `{ kind, createProvider(view), rename?, deleteTarget? }`；内置只保留 `document` 这个 kind |
| `create` | `choices(context)` 与 `render(choice, context)`；Quick Pick 与保存对话框由宿主负责 |
| `session` | `createController(input)` 返回会话控制器 |
| `reveal` | `ReferenceLocation` → Webview 内定位目标；`messageType` / `resultMessageType` 是 Webview 自己监听的类型（宿主零领域知识，必须由模块登记），`createMailbox()` 负责"就绪前先攒、就绪后投递" |
| `mcp` | `queryCatalog(registry, request)`、`queryDocument("read"|"search", document, request)` |
| `operationSchema` | 该 editor 的 Operation JSON Schema，由 `visualbridge_project` 返回 |
| `debug` | 分类展示（见 D.4） |

- `TDocument` 必须是纯 JSON；宿主会把它作为 Provider Validator 的 `content` 发送。
- HostApi 只提供：`log`、Project 视图（`projectId`/Document Type/已验证 options）、`catalogs.get`、`references.search|resolve`、`debug`（仅声明了 `debug.categories` 时）。**不提供文件访问、`vscode`、写入接口**；写回一律经 `WorkspaceEdit` 或 NodeHost Project Transaction。

### D.3.1 `semantic` facet 的两个可选钩子（B4 扩展，§8-400 已裁决接受）

```ts
guardOperations?(
  document: TDocument,
  operations: unknown,
  context: DocumentFacetContext<TRegistry>,
): readonly DocumentDiagnostic[];

validateTransition?(
  before: TDocument,
  after: TDocument,
  context: DocumentFacetContext<TRegistry>,
): readonly DocumentDiagnostic[];
```

- **定位**：二者是 `semantic`（Core `DocumentFacet`）上的**可选**成员，不引入新 facet；未实现与"恒放行"等价。`DocumentFacetContext` 与同 facet 其它方法同源（只读宿主视图，无文件访问、无写入）。
- **调用时机**：唯一消费点是宿主应用 Operations 的编排，顺序固定为
  `解析文档 → guardOperations（整批预检）→ applyOperations → validateTransition(before, after) → Reference 变更校验 → 渲染 → Provider 校验`。
  任一钩子返回**非空**诊断数组即整批拒绝，不渲染、不写盘；只有空数组才继续下一段。
- **为什么是两个钩子而不是一个**：`guardOperations` 只看当前文档 + 操作本身，用来拒绝"这类操作必须走别的工具"（例如稳定 id 改名必须走 `visualbridge_refactor_reference`），不需要 `after`；`validateTransition` 比较前后文档，用来兜住"同一次 apply 内目标消失"这类**只能由前后比较得出**的同文档不变量。Reference Provider 解析目标时读的是**写入前**的字节，拦不住这一类。
- **失败如何映射到错误码**：钩子返回的是 `DocumentDiagnostic[]`（`severity: "error"` + 领域诊断码 + 可定位的 `path`）。宿主把它变成 Operation 批次结果 `status: "invalid"` 并**原样**回传 `diagnostics[]`（MCP `visualbridge_apply_operations` 的结构化输出）；**不映射成 `module.*` 错误码**——那是文档语义错误，而 `module.*` 只描述 bundle 的发现/装载/授权。`path` 约定：整批策略用 `operations[i].type`，不变量用领域元素路径。钩子**抛错**属**模块缺陷**（附录 D.2 的 `module.callFailed`）：宿主不吞错，也不落 `internal`——`internal` 只留给宿主自身的 bug，否则"第三方模块有 bug"会被误报成"VisualBridge 有 bug"。因此宿主对**每一处模块代码调用**（`parseText`/`parseSources`/`validate`/`collectReferences`/`planSources`/`guardOperations`/`applyOperations`/`validateTransition`/`renderSources`，以及 `mcp.queryCatalog`/`mcp.queryDocument`）统一包裹：抛错 → `module.callFailed`，message 带模块 id、钩子名与原始 message（`details = { moduleId, operation, message }`）；宿主已给出的稳定错误码（如 `request.invalidSelector`）原样透传。`module.callFailed` 因此进入 MCP 公开错误清单（`Protocol/contract-manifest.json` 的 `errors.mcpPublic`），与其它 `module.*` 码不同——后者只出现在 `modules[].diagnostics[]`。
- **四个领域 facet 的实现语义**：

| editor | `guardOperations` | `validateTransition` |
| --- | --- | --- |
| graph | 对 `graph.renameElement` 报 `lifecycle.required`（稳定元素 id 改名必须走 Refactor）；元素删除不设守卫 | 用前后文档 + Catalog Registry 找仍指向已删元素的悬空引用 |
| entity | 对 `entity.renameComponent` 报 `lifecycle.required`；组件删除不设守卫（组件没有跨文件引用语义） | 用前后文档 + Catalog Registry 找悬空的组件引用 |
| table | 仅当 `table.setCell` 命中该分表定义里的 **key 列**时报 `lifecycle.required`；行删除不设守卫；无 Registry 或未配置 `tableLayout` 时恒放行（不误伤） | 未实现：key 列变更已被 guard 挡到 Refactor 路径，行删除不产生同文档不变量 |
| structured | 未实现 | 未实现（配置文档没有稳定身份，也没有跨文档引用） |

### D.3.2 SDK 是模块唯一的类型与运行时来源

- 模块源码只允许 import 一个包：`@visualbridge/module-sdk`。Core 的公开类型经 `export type *` 全部可见；领域实现需要的**纯函数**由 SDK 显式导出（白名单）：`canonicalJsonStringify`、`cloneJsonValue`、`compareUtf16CodeUnits`、`createDefaultProperties`、`createUnknownCatalogSource`、`findMatchingDocumentTypes`、`parseCatalogSourceDefinition`、`parseFieldDefinitions`、`parseProjectFile`、`ReferenceService`、`referenceValuesEqual`、`validateFieldValue`。后三个（`parseProjectFile` / `ReferenceService` / `findMatchingDocumentTypes`）供模块测试搭夹具，因为模块工程同样只允许依赖 SDK tgz。
- 打包链路：`ModuleSdk/scripts/assemble.mjs` 把 Core 的 dist JS 与声明一起装进 `Modules/Sdk/*.tgz`，并把产物里的 `@visualbridge/core` 改写成包内相对路径。于是模块工程只需安装 SDK tgz：esbuild 把这些纯函数内联进 `.vbmodule.js`，产物的 `require` 仍只有 Node 内置（满足 D.2 的自包含要求）。
- 版本策略：白名单**只增不减**。新增导出属**增量**变化，不改变 `MODULE_API_VERSION`（后者约束 bundle 与宿主的结构契约）；删除导出或改签名必须同时跳 `MODULE_API_VERSION`。

## D.4 调试 facet

```ts
export interface DebugFacet {
  readonly categories: readonly string[];
  onRecord(record: DebugRecord, context: EditorContext<unknown>): DebugRenderUpdate | undefined;
  readonly windowTitle?: string;
}

export interface DebugRecord {
  readonly seq: number;
  readonly sessionId: string;
  readonly instanceId: string;
  readonly category: string;
  readonly frame: number;
  readonly method: string;
  readonly params: Readonly<Record<string, JsonValue>>;
  readonly wireBytes: number;
  readonly at: number;
}
```

- 宿主拥有数据面（接收、按契约解码、实例存储、回放、录制）；模块只消费 `DebugRecord`、返回渲染增量，**拿不到原始字节**。
- 同一分类被多个模块认领 → 按 `modules` 顺序保留第一个，其余 `module.editorConflict`。
- `onRecord` 抛错 → 捕获、计数、日志，该分类回退 `GenericDebugConsumer`，不影响其他分类。
- `DebugRecord` / `DebugRenderUpdate` 属于公开契约，发布后形状不可随意改（跨 `apiVersion` 兼容不在本次范围）。

## D.5 会话控制器与 effect

```ts
export interface SessionController<TDocument> {
  state(document: SessionDocument<TDocument>): JsonValue;
  handle(message: JsonObject, document: SessionDocument<TDocument>,
         host: SessionHost): Promise<readonly SessionEffect[]>;
  dispose?(): void;
}

export type SessionEffect =
  | { readonly kind: "apply"; readonly operations: unknown; readonly label?: string }
  | { readonly kind: "post"; readonly message: JsonValue }
  | { readonly kind: "reveal"; readonly location: ReferenceLocation }
  | { readonly kind: "openDocument"; readonly path: string; readonly documentTypeId?: string }
  | { readonly kind: "clipboard.write"; readonly text: string }
  | { readonly kind: "notify"; readonly severity: "info" | "warning" | "error"; readonly message: string };
```

- **查询走 `SessionHost`；改变状态的动作一律以 effect 返回**，由宿主按序执行。
- `apply` 由宿主做 revision 校验后调 `semantic.applyOperations`，再生成 `WorkspaceEdit` 或 Custom Document 更新；陈旧 revision 整批拒绝。
- 控制器不得 import `vscode`，必须能在假宿主下测试。
- 宿主先处理三类消息、不转发给控制器：生命周期握手、reference bridge、调试窗口消息。

## D.6 授权与工程布局

| 宿主 | 条件 | 未授权 |
| --- | --- | --- |
| VS Code | Workspace 已信任且 Project Root 是本地 `file` scheme | 不加载模块，文档走只读 Shell 并说明；`onDidGrantWorkspaceTrust` 后自动加载 |
| MCP | `VISUALBRIDGE_MODULES_ENABLED=1`（只接受 `0`/未设置/`1`）且 entry 真实路径在 `VISUALBRIDGE_WORKSPACE` 内 | 领域请求返回 `document.editorUnsupported` + `reason: modulesDisabled`；`visualbridge_project` 正常返回并标注状态 |

- 授权只在宿主启动或 Trust 变化时读取；Tool 参数不能提权；模块授权与 Provider 授权相互独立。

`Modules/`：独立 npm 工程（**不在根 workspaces**），workspaces = `Shared/Form`、`Graph`、`Entity`、`Structured`、`Table`；含 `build.targets.json`、`scripts/build.mjs`、`Sdk/`（只读 tgz）。根脚本：`build:sdk`（打包到 `Modules/Sdk/`）、`check:sdk`（与已提交 tgz 比字节）、`build:modules`（`npm ci --prefix Modules && npm run build --prefix Modules`）；`VB_SKIP_MODULES=1` 仅本地跳过。

Webview 资源：解到 `context.globalStorageUri/modules/<sha256>/<key>.js|.css`，设为 `localResourceRoots`；HTML 由宿主统一生成（`<div id="root" data-project-id data-document-type data-relative-path>` + nonce + 样式链接），CSP 固定为四个领域编辑器并集：

```text
default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-…'
```

模块只能提供脚本、样式与标题，不能改 CSP；激活时清理无人引用的旧 hash 目录。
