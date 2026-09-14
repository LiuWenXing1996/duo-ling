// 用户脚本 git 历史的 offscreen 侧命令面（docs/offscreen-fs-migration.md）。
//
// 执行宿主从 SW 迁到 offscreen：UI / SW 经 chrome.runtime.sendMessage 共享总线发 `ai:*` 命令，
// 本模块在 offscreen 上下文里处理，结果按 { ok, data | error } 信封回传。
//
// 数据来源：脚本记录权威在 chrome.storage（仅 SW 可访问），故读取 project 经 offscreenBridge
// 向 SW 取；文件系统（lfs）在 offscreen 本地，可直连。
import type { RuntimeRequest } from '@/shared/extension-ipc'
import { offscreenBridge } from '@/lib/offscreen-bridge'
import { pfs } from './us-fs'
import {
  snapshotProject,
  listHistory,
  readTreeAt,
  restoreToCommit,
  deleteRepo,
} from './us-git'

/** 收窄 ai: 前缀的命令（供 onMessage 分发时类型化） */
export type AiFsRequest = Extract<RuntimeRequest, { kind: `ai:${string}` }>

/** 处理一条 ai: 命令，返回应作为 RuntimeResponse.data 回传的值 */
export async function handleAiFsCommand(msg: AiFsRequest): Promise<unknown> {
  switch (msg.kind) {
    // 就绪探测（不触碰文件系统）：SW 用它确认本容器的 onMessage 已注册完毕
    case 'ai:ping':
      return { ready: true }
    case 'ai:snapshot': {
      // 每次快照前先对账（目录列举成本极低）：补齐缺失仓、清理多余仓
      await reconcileFs()
      // 保存成功后调用：offscreen 无 chrome.storage，project 经 bridge 向 SW 取
      const project = await offscreenBridge.getProject(msg.uuid)
      if (!project) return { committed: false }
      return snapshotProject(project, msg.note)
    }
    case 'ai:history':
      return listHistory(msg.uuid)
    case 'ai:historyTree':
      return readTreeAt(msg.uuid, msg.oid)
    case 'ai:restoreToCommit': {
      const current = await offscreenBridge.getProject(msg.uuid)
      if (!current) throw new Error('脚本不存在或为已弃用旧记录')
      const { committed, restored } = await restoreToCommit(current, msg.oid)
      return { committed, project: restored }
    }
    case 'ai:deleteRepo':
      await deleteRepo(msg.uuid)
      return undefined
  }
}

/**
 * 最终一致对账：记录有、仓没有 → 补建仓（对当前内容做一次快照）；
 * 仓有、记录没有 → 清理多余仓目录。幂等，失败不阻断。
 * 触发点：offscreen 启动一次 + 每次 ai:snapshot 之前（见 handleAiFsCommand）。
 */
export async function reconcileFs(): Promise<void> {
  try {
    const summaries = await offscreenBridge.listSummaries()
    const uuidsInStore = new Set(summaries.map((s) => s.uuid))
    let repos: string[] = []
    try {
      repos = (await pfs.readdir('/uscripts')) as string[]
    } catch {
      repos = []
    }
    const uuidsInFs = new Set(repos)

    for (const uuid of uuidsInStore) {
      if (!uuidsInFs.has(uuid)) {
        const project = await offscreenBridge.getProject(uuid)
        if (project) await snapshotProject(project).catch(() => {})
      }
    }
    for (const uuid of uuidsInFs) {
      if (!uuidsInStore.has(uuid)) {
        await deleteRepo(uuid).catch(() => {})
      }
    }
  } catch {
    // 对账失败不阻断主链路
  }
}
