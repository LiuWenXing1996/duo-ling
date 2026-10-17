// 用户脚本项目的**读侧**（SW / offscreen / 扩展页共用）。
//
// 与其它脚本模块的分工：
//   写侧 —— 全在 offscreen 的服务实现里（本包之外的 userstate，经 OffscreenService 调用）；
//   读写都在裸 IndexedDB（duoling-state），零 chrome API，故三边都能直接用。
//
// 派生读（排序 / 默认命名）与两个原始读函数同住 state-db.ts：那里同时是 offscreen 写侧取数的
// 入口，两处各存一份必漂移。本文件只把它们收成「项目」口径的读 API。
import { readAllGroups, readProject } from './state-db'
import type { ScriptGroup, ScriptProject } from './script-project'

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
// 校验器不住在本模块：语法校验器在 match-pattern.ts，语义校验器在 @duoling/service-worker 的
// registration.ts（validateMatchPatterns）。导入路径（offscreen 的写侧）与启用路径
// （registration.registerScript）共用它们：非法值在导入 / 启用当场拦下并指明哪条不合法，
// 不拖到注册时才以 Chrome 的英文异常冒出。
