// 用户脚本 git 历史的 offscreen 侧命令面（docs/offscreen-fs-migration.md）。
//
// 执行宿主从 SW 迁到 offscreen：UI / SW 经 chrome.runtime.sendMessage 共享总线发 `ai:*` 命令，
// 本模块在 offscreen 上下文里处理，结果按 { ok, data | error } 信封回传。
//
// 数据来源：项目状态库与 git 仓都在 offscreen 本地，故 project 直读 project-store，
// 不再经 offscreenBridge 向 SW 取（2026-09-15 单写方落地，见 docs/userscript-single-writer.md）。
import type { RuntimeRequest } from '@/shared/extension-ipc'
import { getProject } from './project-store'
import { listHistory, readTreeAt, restoreToCommit } from './us-git'
import { readLfsFile, readLfsTree } from './us-fs'

/** 收窄 ai: 前缀的命令（供 onMessage 分发时类型化） */
export type AiFsRequest = Extract<RuntimeRequest, { kind: `ai:${string}` }>

/** 处理一条 ai: 命令，返回应作为 RuntimeResponse.data 回传的值 */
export async function handleAiFsCommand(msg: AiFsRequest): Promise<unknown> {
  switch (msg.kind) {
    // 就绪探测（不触碰文件系统）：SW 用它确认本容器的 onMessage 已注册完毕
    case 'ai:ping':
      return { ready: true }
    case 'ai:history':
      return listHistory(msg.uuid)
    case 'ai:historyTree':
      return readTreeAt(msg.uuid, msg.oid)
    case 'ai:restoreToCommit': {
      const current = await getProject(msg.uuid)
      if (!current) throw new Error('脚本不存在')
      return restoreToCommit(current, msg.oid)
    }
    // 整库浏览（只读调试视图）：lfs 库的完整文件树，含 .git 内部
    case 'ai:lfsTree':
      return readLfsTree('/')
    // 单文件预览：按完整路径读文件内容（含 .git 内部）
    case 'ai:lfsReadFile':
      return readLfsFile(msg.path)
  }
}
