// 用户脚本项目状态库的 offscreen 侧命令面。
//
// 本模块是本方案的落点：注册态数据（源码搬运副本 / 元数据 / enabled）与源码库（duoling-fs，带 git）
// 都在 offscreen 本地，**写**收敛到这一处。原先一次保存是「SW 写 chrome.storage」+「IPC 让 offscreen commit」
// 两次分离操作、两个写方，任一步失败就产生「已保存但没 commit」的偏差；现在落盘与提交
// 在同一个函数、同一个上下文里完成（project-write.ts），没有跨上下文的缝隙。
//
// 只有**写**命令进协议：读由 SW 与扩展页直连 IndexedDB（project-store），不经容器——
// 「脚本生不生效」不能押在 offscreen 存活上（源码读取例外：走 fs:* 命令，见 offscreen-fs-commands.ts）。
import type { RuntimeRequest } from '@/shared/extension-ipc'
import { broadcastDataChange } from '@/lib/data-broadcast'
import { listProjects } from './project-store'
import {
  createGeneratedProject,
  createGroup,
  createProject,
  importScriptsZip,
  removeAllProjects,
  removeGroupAndReassign,
  removeProjectAndRepo,
  renameGroup,
  reorderGroups,
  saveExisting,
  setProjectEnabled,
  setProjectGroup,
} from './project-write'
import type { ScriptProject } from './types'
import { pfs } from './us-fs'
import { deleteRepo } from './us-git'

/** 收窄 state: 前缀的命令（供 onMessage 分发时类型化） */
export type StateRequest = Extract<RuntimeRequest, { kind: `state:${string}` }>

/**
 * 处理一条 state: 命令，返回应作为 RuntimeResponse.data 回传的值。
 *
 * 落盘成功即广播一次 `script` 域变更：别的标签页 / 别的窗口 / 对话界面据此回拉，
 * 不必等用户手动刷新（IndexedDB 没有变更通知，这条线由 data-broadcast 补上）。
 * 广播放在**写成功之后**——写失败不通知，避免前端拿着旧数据重拉后还以为是最新的。
 */
export async function handleStateCommand(msg: StateRequest): Promise<unknown> {
  const result = await runStateCommand(msg)
  broadcastDataChange('script', 'uuid' in msg ? msg.uuid : undefined)
  return result
}

/** 命令本体（广播前的纯执行部分） */
async function runStateCommand(msg: StateRequest): Promise<unknown> {
  switch (msg.kind) {
    case 'state:create':
      return createProject()
    case 'state:save':
      // 统一保存：写 duoling-fs + git 提交 + 写状态库（保存即注入），见 project-write.saveSource
      return saveExisting(msg.uuid, msg.code, {
        name: msg.name,
        config: msg.config,
        note: msg.note,
      })
    case 'state:remove':
      await removeProjectAndRepo(msg.uuid)
      return undefined
    case 'state:removeAll':
      // 删除全部用户脚本（返删除条数）：记录与仓都在本上下文，不留无主仓
      return removeAllProjects()
    case 'state:toggle':
      return setProjectEnabled(msg.uuid, msg.enabled)
    case 'state:createProject': {
      // AI 生成脚本落盘：写状态库 + git 快照（note = AI summary），不在此注册（enabled:false 默认）
      const { kind: _kind, ...payload } = msg
      return createGeneratedProject(payload)
    }
    case 'state:import':
      // zip 导入：解码 + 落盘全在本上下文（单写方）
      return importScriptsZip(msg.zipBase64)
    case 'state:group-create': {
      // 新建分组：建好即广播 group 域，列表端回拉分组定义
      const { kind: _kind, ...payload } = msg
      const group = await createGroup(payload.name)
      broadcastDataChange('group')
      return group
    }
    case 'state:group-rename': {
      const { kind: _kind, ...payload } = msg
      const group = await renameGroup(payload.id, payload.name)
      broadcastDataChange('group')
      return group
    }
    case 'state:group-remove': {
      // 删除分组：先将其成员退回未分组，再删定义；列表端经 'group' + 'script' 双域回拉
      await removeGroupAndReassign(msg.id)
      broadcastDataChange('group')
      return undefined
    }
    case 'state:group-reorder': {
      await reorderGroups(msg.orderedIds)
      broadcastDataChange('group')
      return undefined
    }
    case 'state:set-group': {
      // 把脚本归入分组：只改脚本的 group 字段，外层 handleStateCommand 已广播 'script'
      const { kind: _kind, ...payload } = msg
      return setProjectGroup(payload.uuid, payload.group)
    }
  }
}

/**
 * 最终一致对账：只清**孤儿仓**（仓有、状态库没有 → 删多余仓目录）。
 * 反方向（状态库有、仓没有）不补建——源码唯一来源就是 duoling-fs，仓没了源码就没了，
 * 没有可补建的材料（2026-09-19 源码迁入 duoling-fs 后不再有「状态库权威副本」可回种）。
 * 幂等，失败不阻断。触发点：offscreen 启动一次（offscreen-main.ts）。
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
    for (const uuid of repos) {
      if (!uuidsInStore.has(uuid)) {
        await deleteRepo(uuid).catch(() => {})
      }
    }
  } catch {
    // 对账失败不阻断主链路
  }
}
