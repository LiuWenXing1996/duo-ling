// 工具只读锁：Phase 1 只读能力（capability: tool.lock.status）。
//
// 设计目标（解耦后的中间阶段）：
//   - 暴露一个统一的查询接口，向渲染层/代理回答「某个工具当前是否被锁」。
//   - Phase 1 只读不写：恒返回「未被持有」。真正的加锁/释放（并发编辑控制）属于后续阶段。
// 这样即使在后续才真正引入持锁者，上层调用只依赖 status() 的形状，无需改动契约。

import type { ToolLockStatus } from '../shared/types'

/** 持锁者（Phase 1 恒为空）。后续并发锁阶段：holderId 对应某个会话/用户。 */
const holders = new Map<string, string>()

/** 查询某个工具的只读锁状态。Phase 1 恒为「未被持有」。 */
export function getToolLockStatus(toolId: string): ToolLockStatus {
  const holderId = holders.get(toolId)
  return { toolId, locked: holderId !== undefined, holderId }
}
