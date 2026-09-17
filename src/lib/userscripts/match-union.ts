// 内置注入脚本（DL.page MAIN 桩 / 页面状态浮窗）的匹配并集与比对。
//
// 抽成独立模块的原因：扩展自己注册的「非用户脚本」现在有两份——MAIN 桩（engine.ts）
// 与状态浮窗（status-bubble.ts），两者都要按「全部启用脚本的 matches 并集」维护注册面
// （并集为空 → 注销），且都靠「并集未变则跳过」避免无谓重注册。并集算法与比对必须同源，
// 放这里可让两侧各自 import，而不会让 engine ↔ status-bubble 互相 import 成环。
//
// 并集取四字段的并（exclude 也取并）意味着内置脚本的注入面可能略大于单脚本需求；
// 两者都无特权、无会话，且浮窗只在有命中脚本的页面出现，宁可多注入不可漏注入。

import type { ScriptProject } from './types'

/** 四字段匹配并集（= `userScripts.RegisteredUserScript` 匹配相关字段的子集） */
export interface MatchUnion {
  matches: string[]
  excludeMatches?: string[]
  includeGlobs?: string[]
  excludeGlobs?: string[]
}

/** 启用脚本的四字段匹配并集；无启用脚本返回 null（调用方据此注销内置脚本） */
export function enabledMatchUnion(projects: ScriptProject[]): MatchUnion | null {
  const pageProjects = projects.filter((p) => p.enabled)
  if (!pageProjects.length) return null
  const merge = (get: (c: ScriptProject) => string[] | undefined): string[] | undefined => {
    const all = [...new Set(pageProjects.flatMap((p) => get(p) ?? []))]
    return all.length ? all : undefined
  }
  return {
    matches: merge((p) => p.config.matches) ?? [],
    excludeMatches: merge((p) => p.config.excludeMatches),
    includeGlobs: merge((p) => p.config.includeGlobs),
    excludeGlobs: merge((p) => p.config.excludeGlobs),
  }
}

/** 两套匹配字段是否等价（顺序无关）——「并集未变则跳过重注册」的判据 */
export function sameMatchSet(
  a: { matches?: string[]; excludeMatches?: string[]; includeGlobs?: string[]; excludeGlobs?: string[] },
  b: { matches?: string[]; excludeMatches?: string[]; includeGlobs?: string[]; excludeGlobs?: string[] },
): boolean {
  const norm = (v?: string[]) => JSON.stringify([...(v ?? [])].sort())
  return (
    norm(a.matches) === norm(b.matches) &&
    norm(a.excludeMatches) === norm(b.excludeMatches) &&
    norm(a.includeGlobs) === norm(b.includeGlobs) &&
    norm(a.excludeGlobs) === norm(b.excludeGlobs)
  )
}
