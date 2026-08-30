export { encodeTableCell } from "./src/cellCodec";
export { formatTableRowDisplayName, resolveTableColumn, resolveTableSheet } from "./src/tableCatalog";
export { buildTableRowSearchText, normalizeTableSearchQuery } from "./src/tableSearch";
export type {
  TableColumnDefinition,
  TableSheetDefinition,
  TableTypeDefinition,
} from "./src/tableCatalog";
export type {
  TableDocument,
  TableOperation,
  TableRow,
  TableSheet,
} from "./src/tableDocument";
