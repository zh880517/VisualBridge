/**
 * Structured Config 的 Operation Schema（供 `visualbridge_project` 的按 editors 暴露）。
 */
export const structuredOperationSchema = {
  type: "object",
  required: ["type"],
  properties: {
    type: { enum: ["structured.setField"] },
  },
  additionalProperties: true,
} as const;
