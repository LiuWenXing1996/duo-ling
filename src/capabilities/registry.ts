// 能力注册表（从桌面版 capability-registry 平移的起点）。
// 一期示例：注册 markdown.render。后续将桌面版全部 offline/online 能力平移进来，
// 并由 background 的 cap:run 改为从注册表取能力（替代当前内联的 miniRender 调用）。
import type { Capability } from '../shared/types'
import type { CapabilityDefinition } from '../shared/extension-ipc'
import { miniRender } from '../fs-store' // 复用存储层里的极简渲染器（spike 验证过）

const registry = new Map<string, CapabilityDefinition>()

export function registerCapability(def: CapabilityDefinition): void {
  registry.set(def.id, def)
}

export function getCapability(id: string): CapabilityDefinition | undefined {
  return registry.get(id)
}

/**
 * 面向「开发者」界面的能力清单（对应桌面版 capability:list）。
 * 桌面版的 Capability 是完整元数据（含 sideEffect / runtime / cost / scenario 等检索元信息），
 * 扩展一期注册表只维护 id/title/description/inputSchema，故此处按「本地离线、只读」补默认值：
 * 待能力全量平移（并接入 schema 校验）后，这些字段应由注册表逐项声明，不在此处兜底猜。
 */
export function listCapabilities(): Capability[] {
  return [...registry.values()].map((def) => ({
    id: def.id,
    name: def.title,
    description: def.description ?? '',
    inputSchema: def.inputSchema,
    outputSchema: {},
    sideEffect: 'read',
    runtime: 'frontend',
    cost: 'offline',
    scenario: { keywords: [], object: '' },
  }))
}

// 示例：markdown.render（一期离线能力）
registerCapability({
  id: 'markdown.render',
  title: 'Markdown 渲染',
  inputSchema: { type: 'object', properties: { markdown: { type: 'string' } } },
  run: (input) => ({ html: miniRender(String(input.markdown ?? '')) }),
})
