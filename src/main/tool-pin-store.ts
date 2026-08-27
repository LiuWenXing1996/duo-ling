import Store, { type Schema } from 'electron-store'

// 工具置顶是「用户独立配置」：不写入 meta.json（避免随 AI 改动/回滚漂移），
// 只在本 store 里维护置顶工具 id 列表，数组顺序即置顶顺序。
const schema: Schema<{ pinned: string[] }> = {
  pinned: {
    type: 'array',
    items: { type: 'string' },
    uniqueItems: true,
    default: []
  }
}

let store: Store<{ pinned: string[] }> | undefined

// 惰性创建：首次调用发生在 IPC 处理时（app 就绪且 userData 覆盖已生效之后）
function getStore(): Store<{ pinned: string[] }> {
  store ??= new Store<{ pinned: string[] }>({
    name: 'tool-pins',
    defaults: { pinned: [] },
    schema
  })
  return store
}

/** 读取全部置顶工具 id（按置顶顺序）；返回副本，避免外部改动 store 内部态。 */
export function listPinnedToolIds(): string[] {
  return [...getStore().get('pinned')]
}

/** 设置某工具的置顶状态：置顶时追加到末尾（幂等），取消时移除。返回更新后的置顶 id 列表（副本）。 */
export function setToolPinned(toolId: string, pinned: boolean): string[] {
  const next = listPinnedToolIds()
  const idx = next.indexOf(toolId)
  if (pinned) {
    if (idx === -1) next.push(toolId)
  } else if (idx !== -1) {
    next.splice(idx, 1)
  }
  getStore().set('pinned', next)
  // 返回副本，避免调用方持有 store 内部对象引用被误改
  return [...next]
}

/** 删除工具时清理其置顶记录（幂等）。 */
export function clearToolPin(toolId: string): void {
  const next = listPinnedToolIds()
  const idx = next.indexOf(toolId)
  if (idx !== -1) {
    next.splice(idx, 1)
    getStore().set('pinned', next)
  }
}
