// 启动对账：只清**孤儿仓**（仓有、状态库没有 → 删多余仓目录）。
//
// 反方向（状态库有、仓没有）不补建——源码唯一来源就是 duoling-fs，仓没了源码就没了，
// 没有可补建的材料（状态库只有搬运副本，不是权威）。幂等，失败不阻断。
// 触发点：offscreen 启动一次（宿主入口 offscreen-main.ts）。
import { listProjects } from '@duoling/userscript-core'
import { deleteRepo, listRepoDirs } from '../fs/git'

export async function reconcileFs(): Promise<void> {
  try {
    const projects = await listProjects()
    const uuidsInStore = new Set(projects.map((p) => p.uuid))
    for (const uuid of await listRepoDirs()) {
      if (!uuidsInStore.has(uuid)) {
        await deleteRepo(uuid).catch(() => {})
      }
    }
  } catch {
    // 对账失败不阻断主链路
  }
}
