// 用户脚本项目数据的底层存储：独立 IndexedDB 库（**与 lightning-fs 的 'duoling-fs' 库分开**）。
// 为什么另起库（lfs 内存索引不可跨实例）、单写方约定（写只许 offscreen）
import type { ScriptGroup, ScriptProject } from './script-project'
import { getStateDexie } from './db'

/** 读一个项目；不存在或形态不对（非 v:2）返回 undefined */
export async function readProject(uuid: string): Promise<ScriptProject | undefined> {
  const value = await getStateDexie().projects.get(uuid)
  return value?.v === 2 ? value : undefined
}

/** 读全部项目（v:2 形态；顺序由调用方决定） */
export async function readAllProjects(): Promise<ScriptProject[]> {
  const all = await getStateDexie().projects.toArray()
  return all.filter((p) => p?.v === 2)
}

/** 列出全部项目：启用在前，组内按源码保存时间倒序（最近保存的排在最上面） */
export async function listProjects(): Promise<ScriptProject[]> {
  const all = await readAllProjects()
  return all.sort(
    (a, b) => Number(b.enabled) - Number(a.enabled) || b.source.savedAt - a.source.savedAt,
  )
}

/** 生成不与现有项目重名的默认名称：「新建的脚本 1」→「2」→「3」…（序号从 1 起，跳过已占用号） */
export async function nextScriptName(base = '新建的脚本'): Promise<string> {
  const names = new Set((await listProjects()).map((p) => p.name))
  let n = 1
  while (names.has(`${base} ${n}`)) n += 1
  return `${base} ${n}`
}

// —— 以下为写 API：只许 offscreen 调用（见文件头「单写方约定」）——

/** 写入 / 覆盖一个项目 */
export async function writeProject(project: ScriptProject): Promise<void> {
  await getStateDexie().projects.put(project)
}

/** 删除一个项目 */
export async function removeProject(uuid: string): Promise<void> {
  await getStateDexie().projects.delete(uuid)
}

/** 批量删除（同一事务，要么全成功要么全失败） */
export async function removeProjects(uuids: string[]): Promise<void> {
  if (!uuids.length) return
  await getStateDexie().transaction('rw', 'projects', (tx) =>
    tx.table('projects').bulkDelete(uuids),
  )
}

// —— 分组对象库（脚本列表分组功能；与 projects 同单写方约束，只许 offscreen 调用） ——

/** 读全部分组（按 order 升序；顺序由 UI 决定展示） */
export async function readAllGroups(): Promise<ScriptGroup[]> {
  const all = await getStateDexie().groups.toArray()
  return all.sort((a, b) => a.order - b.order)
}

/** 读单个分组；不存在返回 undefined */
export async function readGroup(id: string): Promise<ScriptGroup | undefined> {
  return getStateDexie().groups.get(id)
}

/** 写入 / 覆盖一个分组 */
export async function writeGroup(group: ScriptGroup): Promise<void> {
  await getStateDexie().groups.put(group)
}

/** 删除一个分组（不影响项目：归未分组由调用方负责改写各项目的 group 字段） */
export async function removeGroup(id: string): Promise<void> {
  await getStateDexie().groups.delete(id)
}
