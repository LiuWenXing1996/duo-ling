import { z } from 'zod'

/**
 * 将工具输入 schema 转成 JSON Schema（供渲染层表单生成）。
 * zod v4 原生提供 schema.toJSONSchema()，输出 draft 2020-12 格式；
 * 第三方 zod-to-json-schema 与 zod v4 运行时不兼容（字段丢失），故直接使用原生 API。
 */
export function toJsonSchema(schema: z.ZodObject): Record<string, unknown> {
  return schema.toJSONSchema() as unknown as Record<string, unknown>
}
