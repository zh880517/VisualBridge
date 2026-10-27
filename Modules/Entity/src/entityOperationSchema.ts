/**
 * Entity 的 Operation Schema（供 `visualbridge_project` 的按 editors 暴露）。
 *
 * 字段级 Schema 见 F4 的 `$defs/documentOperation` 接线；B4 只声明支持的 Operation type。
 */
export const entityOperationSchema = {
  type: "object",
  required: ["type"],
  properties: {
    type: {
      enum: [
        "entity.setTitle",
        "entity.setProperty",
        "entity.addComponent",
        "entity.removeComponent",
        "entity.renameComponent",
        "entity.moveComponent",
        "entity.setComponentEnabled",
        "entity.setComponentProperty",
        "entity.duplicateComponent",
      ],
    },
  },
  additionalProperties: true,
} as const;
