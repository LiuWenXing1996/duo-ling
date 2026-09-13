import Store, { type Schema } from 'electron-store'
import type { ToolGroupMap } from '../shared/types'

// 工具分组是「用户独立配置」：不写入 meta.json，只在本 store 里维护 toolId → 分组名。
// 分组名存空串视为「未分组」，读取时统一清理为移除。
const schema: Schema<{ groups: ToolGroupMap }> = {
  groups: {
    type: 'object',
    additionalProperties: { type: 'string' }
  }
}

let store: Store<{ groups: ToolGroupMap }> | undefined

// 惰性创建：首次调用发生在 IPC 处理时（app 就绪且 userData 覆盖已生效之后）
function getStore(): Store<{ groups: ToolGroupMap }> {
  store ??= new Store<{ groups: ToolGroupMap }>({
    name: 'tool-groups',
    defaults: { groups: {} },
    schema
  })
  return store
}

/** 读取全部分组映射（toolId → 分组名）；返回副本，避免外部改动 store 内部态。 */
export function getToolGroupMap(): ToolGroupMap {
  return { ...getStore().get('groups') }
}

/** 设置某工具的分组名；空串视为移除分组，且该映射一并清理。返回更新后的全量映射。 */
export function setToolGroup(toolId: string, group: string): ToolGroupMap {
  const next = getToolGroupMap()
  const trimmed = group.trim()
  if (trimmed) {
    next[toolId] = trimmed
  } else {
    delete next[toolId]
  }
  getStore().set('groups', next)
  // 返回副本，避免调用方持有 store 内部对象引用被误改
  return { ...next }
}

/** 删除工具时清理其分组映射（幂等）。 */
export function clearToolGroup(toolId: string): void {
  const next = getToolGroupMap()
  if (toolId in next) {
    delete next[toolId]
    getStore().set('groups', next)
  }
}
