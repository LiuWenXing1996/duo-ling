import { z } from 'zod'
import type { Tool } from './types'

/** 示例工具：echo —— 原样返回输入文本，用于跑通「标准 → IPC → 表单 → 执行」链路 */
export const echoTool: Tool<{ text: string }, { reply: string }> = {
  name: 'echo',
  description: '原样返回输入的文本',
  inputSchema: z.object({
    text: z.string().describe('要回显的文本')
  }),
  outputSchema: z.object({
    reply: z.string()
  }),
  run: (input) => ({ reply: input.text })
}
