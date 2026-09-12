// 能力注册表（从桌面版 capability-registry 平移的起点）。
// 一期示例：注册 markdown.render。后续将桌面版全部 offline/online 能力平移进来，
// 并由 background 的 cap:run 改为从注册表取能力（替代当前内联的 miniRender 调用）。
import type { CapabilityDefinition } from '../shared/types'
import { miniRender } from '../fs-store' // 复用存储层里的极简渲染器（spike 验证过）

const registry = new Map<string, CapabilityDefinition>()

export function registerCapability(def: CapabilityDefinition): void {
  registry.set(def.id, def)
}

export function getCapability(id: string): CapabilityDefinition | undefined {
  return registry.get(id)
}

// 示例：markdown.render（一期离线能力）
registerCapability({
  id: 'markdown.render',
  title: 'Markdown 渲染',
  inputSchema: { type: 'object', properties: { markdown: { type: 'string' } } },
  run: (input) => ({ html: miniRender(String(input.markdown ?? '')) }),
})
