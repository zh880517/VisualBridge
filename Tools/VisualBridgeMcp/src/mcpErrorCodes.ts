/**
 * facet 返回的稳定错误码到 MCP 公开错误的唯一映射。
 *
 * 模块 facet 不 import 宿主错误类型，只回码字符串；这里的 `VisualBridgeMcpError` 构造调用
 * 字面量同时是 `npm run check:protocol` 的公开错误清单来源，因此新增 facet 错误码必须在这里登记。
 *
 * 未登记的码**不得**静默回落 `internal`：那会把"facet 违反模块契约"伪装成宿主内部错误，
 * 与 B4 第 1 轮 P1-1（facet 回对了码、宿主吞掉）是同一失败类。这里显式抛出契约违例并带上原码。
 */
import { VisualBridgeMcpError } from "./projectWorkspace.js";

export type FacetRequestErrorCode =
  | "request.invalidSelector"
  | "document.searchKindUnsupported"
  | "document.editorUnsupported"
  | "catalog.kindUnsupported"
  | "table.sheetNotFound"
  | "table.sheetDefinitionNotFound";

export function facetRequestError(code: string, message: string): VisualBridgeMcpError {
  switch (code as FacetRequestErrorCode) {
    case "request.invalidSelector":
      return new VisualBridgeMcpError("request.invalidSelector", message);
    case "document.searchKindUnsupported":
      return new VisualBridgeMcpError("document.searchKindUnsupported", message);
    case "document.editorUnsupported":
      return new VisualBridgeMcpError("document.editorUnsupported", message);
    case "catalog.kindUnsupported":
      return new VisualBridgeMcpError("catalog.kindUnsupported", message);
    case "table.sheetNotFound":
      return new VisualBridgeMcpError("table.sheetNotFound", message);
    case "table.sheetDefinitionNotFound":
      return new VisualBridgeMcpError("table.sheetDefinitionNotFound", message);
    default:
      throw new Error(
        `Facet returned unregistered request error code '${code}': ${message}. `
        + "Register it in mcpErrorCodes.ts (and in Protocol/contract-manifest.json errors.mcpPublic) or fix the facet.",
      );
  }
}
