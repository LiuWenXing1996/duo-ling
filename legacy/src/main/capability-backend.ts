// backend 运行域能力的真实实现（PRD §8.3，跑在 capability-worker / utilityProcess 内）
//
// 约定：每个实现是一个 (args: unknown) => Promise<unknown> 的纯函数，接收经
// IPC 净化（JSON 序列化）后的参数，返回可被结构化克隆的字面量结果。

import { readFile } from 'node:fs/promises'

/** local.file.read：读指定路径的本地文本文件 */
export async function readLocalFile(args: { path?: string }): Promise<{ content: string }> {
  const path = args?.path
  if (typeof path !== 'string' || !path.trim()) {
    throw new Error('缺少文件路径参数：path')
  }
  const content = await readFile(path, 'utf-8')
  return { content }
}

/** backend 能力注册表：id → 实现（与 backendCapabilities 元数据一一对应） */
export const backendImpls: Record<string, (args: unknown) => Promise<unknown>> = {
  'local.file.read': (args) => readLocalFile(args as { path?: string })
}
