// 用户脚本项目数据的**写侧**（⚠️ offscreen 专属，见 state-db.ts 文件头的单写方约定）。
//
// 这里是本方案（docs/userscript-single-writer.md）的落点：
// 原先一次保存是「SW 写 chrome.storage」+「IPC 让 offscreen commit git 仓」两次分离操作、
// 两个写方，任一步失败就产生「已保存但没 commit」的偏差。
// 现在状态库与 git 仓都在 offscreen 本地，写状态与 commit 收进同一个函数、同一个上下文里：
// 先落状态、紧接着快照提交，**不再有跨上下文的缝隙**。
//
// 失败策略不变：commit 失败只丢历史不丢脚本（仓损坏可重建，状态库是权威），故快照异常只 warn。
import { getProject, nextScriptName, validateFiles } from './project-store'
import { removeProject, writeProject } from './state-db'
import { deleteRepo, snapshotProject } from './us-git'
import { ENTRY_DEFAULT, defaultConfig, defaultSource } from './types'
import type { ScriptConfig, ScriptProject } from './types'

function nowProject(name: string, files: Record<string, string>, config: ScriptConfig): ScriptProject {
  const ts = Date.now()
  return {
    v: 1,
    uuid: crypto.randomUUID(),
    name,
    // 新建即启用（2026-09-14 老大拍板）；初始源码无害，注入也安全
    enabled: true,
    config,
    files,
    entry: ENTRY_DEFAULT,
    createdAt: ts,
    updatedAt: ts,
  }
}

/** 落状态 + 快照提交（首次即建仓）；快照失败只 warn，不阻断写入 */
async function writeAndSnapshot(project: ScriptProject, note?: string): Promise<void> {
  await writeProject(project)
  try {
    await snapshotProject(project, note)
  } catch (e) {
    console.warn('[duoling:userscript] 历史快照失败（不影响保存）', project.uuid, e)
  }
}

/** 新建（零输入）：自动命名 + 初始模板 */
export async function createProject(): Promise<ScriptProject> {
  const name = await nextScriptName()
  const project = nowProject(name, { [ENTRY_DEFAULT]: defaultSource(name) }, defaultConfig(['*://*/*']))
  await writeAndSnapshot(project)
  return project
}

/** 安装：单文件源码 + 名称/匹配规则（缺省给开发用默认值） */
export async function installProject(
  source: string,
  opts?: { name?: string; matches?: string[] },
): Promise<ScriptProject> {
  const project = nowProject(
    opts?.name?.trim() || '未命名脚本',
    { [ENTRY_DEFAULT]: source },
    defaultConfig(opts?.matches?.length ? opts.matches : ['*://*/*']),
  )
  await writeAndSnapshot(project)
  return project
}

/** 更新文件树 + 入口 + 名称/配置 + 构建产物（读改写在同一处，不跨上下文） */
export async function updateProjectFiles(
  uuid: string,
  files: Record<string, string>,
  entry: string,
  bundle?: { code: string; builtAt: number },
  opts?: { name?: string; config?: ScriptConfig; note?: string },
): Promise<ScriptProject> {
  const project = await getProject(uuid)
  if (!project) throw new Error('脚本不存在')
  validateFiles(files, entry)
  project.files = files
  project.entry = entry
  if (bundle) project.bundle = bundle
  if (opts?.name !== undefined) {
    const name = opts.name.trim()
    if (!name) throw new Error('脚本名称不能为空')
    project.name = name
  }
  if (opts?.config) {
    if (!opts.config.matches?.length) throw new Error('匹配规则（matches）至少一条')
    project.config = opts.config
  }
  project.updatedAt = Date.now()
  await writeAndSnapshot(project, opts?.note)
  return project
}

/**
 * 删除：状态库记录 + git 仓一起清。
 * 仓的删除原先要靠 offscreen 启动对账（reconcileFs）兜，删完脚本仓会滞留一段时间；
 * 现在写侧同在 offscreen，直接一步清干净。
 */
export async function removeProjectAndRepo(uuid: string): Promise<void> {
  await removeProject(uuid)
  await deleteRepo(uuid).catch((e: unknown) => {
    console.warn('[duoling:userscript] 删除 git 仓失败（脚本记录已删）', uuid, e)
  })
}

/**
 * 启停：只改 enabled。
 * **不产生提交**——enabled 不入仓（buildContents 刻意排除它，否则每次启停都是一次「假变更」）。
 */
export async function setProjectEnabled(uuid: string, enabled: boolean): Promise<ScriptProject> {
  const project = await getProject(uuid)
  if (!project) throw new Error('脚本不存在')
  project.enabled = enabled
  project.updatedAt = Date.now()
  await writeProject(project)
  return project
}
