// 用户脚本项目的**读侧**（SW / offscreen / 扩展页共用）。
//
// 与 store.ts 的分工：
//   store.ts        —— GM 值（duoling-usdata 库）+ 观测数据（duoling-runtime 库），只许 SW import；
//   project-store.ts —— 只读项目状态库（IndexedDB，见 state-db.ts），不碰任何 chrome API，
//                       所以 SW 与 offscreen 都能直接用，offscreen 不必再经 SW 桥接取项目。
//
// 这里**没有写 API**：写全在 project-write.ts（offscreen 专属），见 state-db.ts 文件头的单写方约定。
import { readAllGroups, readAllProjects, readProject } from '@duoling/userscript-core'
import type { ScriptProject, ScriptGroup } from './types'

/** 列出全部项目：启用在前，组内按源码保存时间倒序（最近保存的排在最上面） */
export async function listProjects(): Promise<ScriptProject[]> {
  const all = await readAllProjects()
  return all.sort(
    (a, b) => Number(b.enabled) - Number(a.enabled) || b.source.savedAt - a.source.savedAt,
  )
}

/** 读单个项目（不存在 / 形态不对返回 undefined） */
export function getProject(uuid: string): Promise<ScriptProject | undefined> {
  return readProject(uuid)
}

/** 列出全部分组（按 order 升序） */
export function listGroups(): Promise<ScriptGroup[]> {
  return readAllGroups()
}

/** 生成不与现有项目重名的默认名称：「新建的脚本 1」→「新建的脚本 2」→「新建的脚本 3」…（序号从 1 起，跳过已占用号） */
export async function nextScriptName(base = '新建的脚本'): Promise<string> {
  const names = new Set((await listProjects()).map((p) => p.name))
  let n = 1
  while (names.has(`${base} ${n}`)) n += 1
  return `${base} ${n}`
}

/**
 * 文件树校验已随多文件形态移除：单文件源码无路径校验需求，保存恒成功（见 project-write.ts）。
 */

// —— match pattern 校验——
// 导入路径（project-write.importScriptsZip）与启用路径（registration.registerScript）共用：
// 非法值在导入 / 启用当场拦下并指明哪条不合法，不拖到注册时才以 Chrome 的英文异常冒出。
// 语法校验器（isValidMatchPattern）在 `@duoling/userscript-core`（match-pattern.ts），
// 语义校验器（validateMatchPatterns）在 `@duoling/userscript-sw`（registration.ts）——
// 此处 re-export 维持既有 import 路径不变。
export { isValidMatchPattern } from '@duoling/userscript-core'
export { validateMatchPatterns } from '@duoling/userscript-sw'
