/**
 * Table 模块的 `create` facet（附录 D.3）。
 *
 * 只产出"问什么 / 默认文件名 / Lifecycle parameters"和新源文件字节；Quick Pick、保存对话框与
 * preview/apply 都在宿主。宿主因此没有按 editor 分支的创建逻辑与 Table Type 列表。
 */
import type {
  CreateCatalogView as SharedCreateCatalogView,
  CreateFacet,
  CreateFacetInput as SharedCreateFacetInput,
  JsonValue,
  VisualBridgeProjectDefinition,
} from "@visualbridge/module-sdk";
import { resolveProjectTableLayout } from "./projectTableLayout";
import {
  createEmptyCsvTableSource,
  createEmptyXlsxTableSource,
} from "./tableSourceFactory";
import { resolveTableType, type TableCatalogRegistry, type TableTypeDefinition } from "./tableCatalog";

type CreateCatalogView = SharedCreateCatalogView;
type CreateFacetInput = SharedCreateFacetInput;

export const tableCreateFacet = {
  prepare(input: CreateFacetInput) {
    const layout = resolveProjectTableLayout(input.projectDefinition as VisualBridgeProjectDefinition);
    if (layout === undefined) {
      return {
        kind: "unavailable" as const,
        message: `Project '${input.projectId}' must configure tableLayout before a Table can be created.`,
      };
    }
    if (!input.catalog.ready) {
      return {
        kind: "unavailable" as const,
        message: `无法创建 Table，Catalog Registry 无效：${firstCatalogError(input.catalog)}`,
      };
    }
    const tableType = resolveTableType(input.catalog.registry as TableCatalogRegistry, input.documentType.id);
    if (tableType === undefined) {
      return {
        kind: "unavailable" as const,
        message: `Document Type '${input.documentType.id}' 必须与一个 Table Type ID 或 alias 对应。`,
      };
    }
    return {
      kind: "ready" as const,
      questions: tableType.csv === undefined ? [] : [{
        id: "format",
        title: "Select Table Source Format",
        placeholder: "The format is explicit and independent of the Project-defined file extension.",
        options: [
          { id: "csv", label: "CSV", description: "UTF-8 CSV-compatible source" },
          { id: "xlsx", label: "XLSX", description: "Excel workbook" },
        ],
      }],
      fallbackExtension: tableType.csv === undefined ? "xlsx" : "csv",
      defaultFileName: () => initialPhysicalName(tableType),
      parameters: (
        answers: Readonly<Record<string, string>>,
        target: { readonly name: string },
      ): Readonly<Record<string, JsonValue>> => {
        const format = tableType.csv === undefined ? "xlsx" : answers.format ?? "csv";
        return format === "csv"
          ? { format, physicalName: target.name }
          : { format };
      },
    };
  },

  async createDocument(input: CreateFacetInput & {
    readonly parameters: Readonly<Record<string, JsonValue>>;
    readonly targetPath: string;
  }) {
    try {
      assertParameterKeys(input.parameters, ["format", "physicalName"]);
      const layout = resolveProjectTableLayout(input.projectDefinition as VisualBridgeProjectDefinition);
      if (layout === undefined) throw new Error("The Project does not configure tableLayout.");
      if (!input.catalog.ready) throw new Error(`Table Catalog Registry 无效：${firstCatalogError(input.catalog)}`);
      const tableType = resolveTableType(input.catalog.registry as TableCatalogRegistry, input.documentType.id);
      if (tableType === undefined) {
        throw new Error(`Document Type '${input.documentType.id}' does not resolve to a Table Type.`);
      }
      const format = input.parameters.format;
      if (format !== "csv" && format !== "xlsx") {
        throw new Error("parameters.format must be 'csv' or 'xlsx'.");
      }
      if (format === "xlsx" && input.parameters.physicalName !== undefined) {
        throw new Error("parameters.physicalName is only valid when parameters.format is 'csv'.");
      }
      const physicalName = optionalString(input.parameters.physicalName, "parameters.physicalName")
        ?? baseNameWithoutExtension(input.targetPath);
      const created = format === "xlsx"
        ? await createEmptyXlsxTableSource(tableType, layout)
        : createEmptyCsvTableSource(tableType, layout, physicalName);
      if (!created.success) throw new Error(formatSourceDiagnostics(created.diagnostics));
      return {
        success: true as const,
        sources: [{ path: input.targetPath, bytes: created.bytes }],
        ownedIdentities: [],
      };
    } catch (errorValue) {
      return { success: false as const, message: formatError(errorValue) };
    }
  },
} satisfies CreateFacet<CreateFacetInput>;

/** 用纯字符串切分替代 `node:path`，保持 facet 无 Node 内建依赖。 */
function baseNameWithoutExtension(targetPath: string): string {
  const separator = Math.max(targetPath.lastIndexOf("/"), targetPath.lastIndexOf("\\"));
  const base = targetPath.slice(separator + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? base : base.slice(0, dot);
}

function initialPhysicalName(tableType: TableTypeDefinition): string {
  const sheet = tableType.sheets[0];
  if (sheet === undefined) {
    return "NewTable";
  }
  return sheet.partition === undefined
    ? sheet.name
    : sheet.partition.namePattern.replace("{part}", "Main");
}

function firstCatalogError(catalog: CreateCatalogView): string {
  return catalog.diagnostics.find((diagnostic) => diagnostic.severity === "error")?.message
    ?? "未配置可用 Catalog";
}

function formatSourceDiagnostics(
  diagnostics: readonly { readonly path: string; readonly message: string }[],
): string {
  const first = diagnostics[0];
  return first === undefined ? "Table is invalid." : `Table: ${first.path}: ${first.message}`;
}

function assertParameterKeys(parameters: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
  const unexpected = Object.keys(parameters).find((key) => !allowed.includes(key));
  if (unexpected !== undefined) throw new Error(`Unexpected create parameter '${unexpected}'.`);
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${path} must be a string.`);
  return value;
}

function formatError(errorValue: unknown): string {
  return errorValue instanceof Error ? errorValue.message : String(errorValue);
}
