import type {
  VisualBridgeEntityCatalog,
  VisualBridgeTableCatalog,
} from "../../../Protocol/Generated/contracts";

const entityFieldWithoutOptionalProperties: VisualBridgeEntityCatalog.Field = {
  id: "health",
  title: "Health",
  valueType: "number",
  defaultValue: 0,
};

const entityObjectField: VisualBridgeEntityCatalog.Field = {
  id: "stats",
  title: "Stats",
  valueType: "object",
  defaultValue: {},
  fields: [],
};

const entityArrayField: VisualBridgeEntityCatalog.Field = {
  id: "tags",
  title: "Tags",
  valueType: "array",
  defaultValue: [],
  item: { valueType: "string", defaultValue: "" },
};

// @ts-expect-error object fields require fields.
const entityObjectWithoutFields: VisualBridgeEntityCatalog.Field = { id: "stats", title: "Stats", valueType: "object", defaultValue: {} };

// @ts-expect-error object fields forbid item.
const entityObjectWithItem: VisualBridgeEntityCatalog.Field = { id: "stats", title: "Stats", valueType: "object", defaultValue: {}, fields: [], item: { valueType: "string", defaultValue: "" } };

// @ts-expect-error array fields require item.
const entityArrayWithoutItem: VisualBridgeEntityCatalog.Field = { id: "tags", title: "Tags", valueType: "array", defaultValue: [] };

// @ts-expect-error array fields forbid fields.
const entityArrayWithFields: VisualBridgeEntityCatalog.Field = { id: "tags", title: "Tags", valueType: "array", defaultValue: [], item: { valueType: "string", defaultValue: "" }, fields: [] };

// @ts-expect-error scalar fields forbid fields and item.
const entityScalarWithShape: VisualBridgeEntityCatalog.Field = { id: "health", title: "Health", valueType: "number", defaultValue: 0, fields: [] };

// @ts-expect-error valueType is required by the Entity Field schema.
const entityFieldWithoutRequiredProperty: VisualBridgeEntityCatalog.Field = {
  id: "health",
  title: "Health",
  defaultValue: 0,
};

const tableColumnWithoutOptionalProperties: VisualBridgeTableCatalog.Column = {
  id: "power",
  title: "Power",
  valueType: "number",
  defaultValue: 0,
  nameKey: "power",
  cellEncoding: { kind: "scalar" },
};

const tableObjectColumn: VisualBridgeTableCatalog.Column = {
  id: "stats",
  title: "Stats",
  valueType: "object",
  defaultValue: {},
  fields: [],
  nameKey: "stats",
  cellEncoding: { kind: "json" },
};

const tableArrayColumn: VisualBridgeTableCatalog.Column = {
  id: "tags",
  title: "Tags",
  valueType: "array",
  defaultValue: [],
  item: { valueType: "string", defaultValue: "" },
  nameKey: "tags",
  cellEncoding: { kind: "json" },
};

// @ts-expect-error object columns require fields.
const tableObjectWithoutFields: VisualBridgeTableCatalog.Column = { id: "stats", title: "Stats", valueType: "object", defaultValue: {}, nameKey: "stats", cellEncoding: { kind: "json" } };

// @ts-expect-error object columns forbid item.
const tableObjectWithItem: VisualBridgeTableCatalog.Column = { id: "stats", title: "Stats", valueType: "object", defaultValue: {}, fields: [], item: { valueType: "string", defaultValue: "" }, nameKey: "stats", cellEncoding: { kind: "json" } };

// @ts-expect-error array columns require item.
const tableArrayWithoutItem: VisualBridgeTableCatalog.Column = { id: "tags", title: "Tags", valueType: "array", defaultValue: [], nameKey: "tags", cellEncoding: { kind: "json" } };

// @ts-expect-error array columns forbid fields.
const tableArrayWithFields: VisualBridgeTableCatalog.Column = { id: "tags", title: "Tags", valueType: "array", defaultValue: [], item: { valueType: "string", defaultValue: "" }, fields: [], nameKey: "tags", cellEncoding: { kind: "json" } };

// @ts-expect-error scalar columns forbid fields and item.
const tableScalarWithShape: VisualBridgeTableCatalog.Column = { id: "power", title: "Power", valueType: "number", defaultValue: 0, fields: [], nameKey: "power", cellEncoding: { kind: "scalar" } };

// @ts-expect-error cellEncoding is required by the Table Column schema.
const tableColumnWithoutRequiredProperty: VisualBridgeTableCatalog.Column = {
  id: "power",
  title: "Power",
  valueType: "number",
  defaultValue: 0,
  nameKey: "power",
};

void entityFieldWithoutOptionalProperties;
void entityObjectField;
void entityArrayField;
void entityFieldWithoutRequiredProperty;
void tableColumnWithoutOptionalProperties;
void tableObjectColumn;
void tableArrayColumn;
void tableColumnWithoutRequiredProperty;
