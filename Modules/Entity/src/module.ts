/**
 * Entity 模块入口（附录 D.2）：只导出 `manifest` 与 `activate(host)`。
 *
 * 不要在这里导出 `webviews`：`buildModule()` 会用构建配置（`Modules/build.targets.json`）
 * 生成的那一份覆盖它，入口自己导出的既不生效也不报错 —— `Modules/scripts/build.mjs` 的
 * `assertEntryShape` 会在打包前直接失败。
 */
import {
  MODULE_API_VERSION,
  type EditorRegistration,
  type ModuleHost,
  type ModuleRegistration,
} from "@visualbridge/module-sdk";
import {
  createEntitySessionController,
  entityCatalogFacet,
  entityCreateFacet,
  entityDocumentFacet,
  entityMcpFacet,
  entityOperationSchema,
} from "../index";

export const manifest = {
  id: "visualbridge.entity",
  version: "0.1.0",
  apiVersion: MODULE_API_VERSION,
  editors: ["entity"],
} as const;

const editor: EditorRegistration = {
  editor: "entity",
  semantic: entityDocumentFacet,
  catalog: entityCatalogFacet,
  create: entityCreateFacet,
  mcp: entityMcpFacet,
  webview: "entity",
  webviewTitle: "Entity",
  operationSchema: entityOperationSchema,
  session: {
    // 工厂：宿主打开文档时调用，得到本次会话的控制器。
    createController: () => createEntitySessionController(),
  },
};

export function activate(_host: ModuleHost): ModuleRegistration {
  return { editors: [editor] };
}
