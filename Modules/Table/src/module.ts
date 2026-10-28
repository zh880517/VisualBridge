/**
 * Table 模块入口（附录 D.2）：只导出 `manifest` 与 `activate(host)`。
 *
 * 不要在这里导出 `webviews`：`buildModule()` 会用构建配置（`Modules/build.targets.json`）
 * 生成的那一份覆盖它，入口自己导出的既不生效也不报错 —— `Modules/scripts/build.mjs` 的
 * `assertEntryShape` 会在打包前直接失败。
 */
import {
  MODULE_API_VERSION,
  type EditorRegistration,
  type JsonValue,
  type ModuleHost,
  type ModuleRegistration,
} from "@visualbridge/module-sdk";
import {
  createTableSessionController,
  tableCatalogFacet,
  tableCreateFacet,
  tableDocumentFacet,
  tableMcpFacet,
  tableOperationSchema,
} from "../index";
import {
  TABLE_REVEAL_MESSAGE_TYPE,
  TABLE_REVEAL_RESULT_MESSAGE_TYPE,
  TableRevealMailbox,
} from "./tableReveal";

export const manifest = {
  id: "visualbridge.table",
  version: "0.1.0",
  apiVersion: MODULE_API_VERSION,
  editors: ["table"],
} as const;

const editor: EditorRegistration = {
  editor: "table",
  semantic: tableDocumentFacet,
  catalog: tableCatalogFacet,
  create: tableCreateFacet,
  mcp: tableMcpFacet,
  webview: "table",
  webviewTitle: "Table",
  operationSchema: tableOperationSchema,
  reveal: {
    messageType: TABLE_REVEAL_MESSAGE_TYPE,
    resultMessageType: TABLE_REVEAL_RESULT_MESSAGE_TYPE,
    // Table 的行定位只需要分表 id 与行 id；平台在 ReferenceLocation 里就带这两项。
    readTarget: (location) => (
      location.sheetId === undefined || location.rowId === undefined
        ? undefined
        : { sheetId: location.sheetId, rowId: location.rowId } as JsonValue
    ),
    createMailbox: () => new TableRevealMailbox(),
  },
  session: {
    // 工厂：宿主打开文档时调用，得到本次会话的控制器。
    createController: () => createTableSessionController(),
  },
};

export function activate(_host: ModuleHost): ModuleRegistration {
  return { editors: [editor] };
}
