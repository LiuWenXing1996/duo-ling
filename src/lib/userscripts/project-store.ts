// 用户脚本项目的**读侧**（SW / offscreen / 扩展页共用）。
//
// 与 store.ts 的分工：
//   store.ts        —— GM 值（duoling-usdata 库）+ 观测数据（duoling-runtime 库），只许 SW import；
//   project-store.ts —— 只读项目状态库（IndexedDB，见 state-db.ts），不碰任何 chrome API，
//                       所以 SW 与 offscreen 都能直接用，offscreen 不必再经 SW 桥接取项目。
//
// 这里**没有写 API**：写全在 offscreen 侧的服务实现里（@duoling/offscreen-document 的 userstate，
// 经 OffscreenService 调用）—— 单写方约定见 state-db.ts 文件头。
//
// 派生读（排序 / 默认命名）的实现已下沉 `@duoling/userscript-core` 的 state-db.ts：
// 那里同时是 offscreen 写侧取数的入口，两处各存一份必漂移。本文件只维持既有 import 路径不变。
import { readAllGroups, readProject } from '@duoling/userscript-core'
import type { ScriptGroup, ScriptProject } from './types'

export { listProjects, nextScriptName } from '@duoling/userscript-core'

/** 读单个项目（不存在 / 形态不对返回 undefined） */
export function getProject(uuid: string): Promise<ScriptProject | undefined> {
  return readProject(uuid)
}

/** 列出全部分组（按 order 升序） */
export function listGroups(): Promise<ScriptGroup[]> {
  return readAllGroups()
}

/**
 * 文件树校验已随多文件形态移除：单文件源码无路径校验需求，保存恒成功
 * （见 @duoling/offscreen-document 的 userstate/project-write）。
 */

// —— match pattern 校验 ——
// 校验器不住在本模块：语法校验器是 `@duoling/userscript-core` 的 isValidMatchPattern
// （match-pattern.ts），语义校验器是 `@duoling/service-worker` 的 validateMatchPatterns
// （registration.ts）。导入路径（offscreen 的写侧）与启用路径（registration.registerScript）
// 共用它们：非法值在导入 / 启用当场拦下并指明哪条不合法，不拖到注册时才以 Chrome 的英文异常冒出。
