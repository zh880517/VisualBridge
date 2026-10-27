/**
 * Table 的 Operation Schema（供 `visualbridge_project` 的按 editors 暴露）。
 */
export const tableOperationSchema = {
  type: "object",
  required: ["type"],
  properties: {
    type: {
      enum: [
        "table.setCell",
        "table.insertRow",
        "table.removeRow",
        "table.moveRow",
        "table.duplicateRow",
      ],
    },
  },
  additionalProperties: true,
} as const;
