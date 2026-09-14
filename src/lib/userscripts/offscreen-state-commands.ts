// 用户脚本项目状态库的 offscreen 侧命令面（docs/userscript-single-writer.md）。
//
// 本模块是本方案的落点：项目数据（源码 / 配置 / 构建产物 / enabled）与 git 仓都在 offscreen
// 本地，**写**收敛到这一处。原先一次保存是「SW 写 chrome.storage」+「IPC 让 offscreen commit」
// 两次分离操作、两个写方，任一步失败就产生「已保存但没 commit」的偏差；现在状态落盘与快照
// 提交在同一个函数、同一个上下文里完成（project-write.ts），没有跨上下文的缝隙。
//
// 只有**写**命令进协议：读由 SW 与扩展页直连 IndexedDB（project-store），不经容器——
// 「脚本生不生效」不能押在 offscreen 存活上。
import type { RuntimeRequest } from '@/shared/extension-ipc'
import { listProjects } from './project-store'
import {
  createProject,
  installProject,
  removeProjectAndRepo,
  setProjectEnabled,
  updateProjectFiles,
} from './project-write'
import type { ScriptProject } from './types'
import { pfs } from './us-fs'
import { deleteRepo, snapshotProject } from './us-git'

/** 收窄 state: 前缀的命令（供 onMessage 分发时类型化） */
export type StateRequest = Extract<RuntimeRequest, { kind: `state:${string}` }>

/** 处理一条 state: 命令，返回应作为 RuntimeResponse.data 回传的值 */
export async function handleStateCommand(msg: StateRequest): Promise<unknown> {
  switch (msg.kind) {
    case 'state:create':
      return createProject()
    case 'state:install':
      return installProject(msg.source, { name: msg.name, matches: msg.matches })
    case 'state:updateFiles':
      return updateProjectFiles(msg.uuid, msg.files, msg.entry, msg.bundle, {
        name: msg.name,
        config: msg.config,
        note: msg.note,
      })
    case 'state:remove':
      await removeProjectAndRepo(msg.uuid)
      return undefined
    case 'state:toggle':
      return setProjectEnabled(msg.uuid, msg.enabled)
  }
}

/**
 * 最终一致对账：状态库有、仓没有 → 补建仓（对当前内容做一次快照）；
 * 仓有、状态库没有 → 清理多余仓目录。幂等，失败不阻断。
 * 触发点：offscreen 启动一次（offscreen-main.ts）。
 *
 * 原先每次 ai:snapshot 前都要对账一次（那是双写方时代的补偿）；现在写与 commit 同处一地，
 * 启动对账一次即可——目录列举成本极低，但也没必要挂在每次保存上。
 */
export async function reconcileFs(): Promise<void> {
  try {
    const projects: ScriptProject[] = await listProjects()
    const uuidsInStore = new Set(projects.map((p) => p.uuid))
    let repos: string[] = []
    try {
      repos = (await pfs.readdir('/uscripts')) as string[]
    } catch {
      repos = []
    }

    for (const project of projects) {
      if (!repos.includes(project.uuid)) {
        await snapshotProject(project).catch(() => {})
      }
    }
    for (const uuid of repos) {
      if (!uuidsInStore.has(uuid)) {
        await deleteRepo(uuid).catch(() => {})
      }
    }
  } catch {
    // 对账失败不阻断主链路
  }
}
