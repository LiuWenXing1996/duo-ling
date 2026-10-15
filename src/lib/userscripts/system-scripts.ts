// 系统脚本（原「内置件」）：扩展随包分发的注入件，改走统一脚本注册链。
//
// 与用户脚本的差别只在**来源与托管**：源码 = 扩展产物里的件文件（随扩展发版更新，
// 扩展更新清空注册后由同步链补回），uuid 固定，不入项目库 —— 不占用户脚本列表、
// 不可被用户编辑 / 删除，也没有 duoling-fs 侧的工作区。注册本身与用户脚本同一条
// registerScript 路径（GM 包装 + 脚本桥一并内联，中继件并集须把系统脚本算上，
// 见 engine.ts 的调用处）。
import type { ScriptProject } from './types'
import { TAB_RECORDER_FILE, TAB_RECORDER_ID } from '@duoling/builtin-scripts'
import { defaultConfig } from '@duoling/userscript-runtime'

/** 件文件内容缓存（同一扩展版本内产物不可变，读一次就够） */
const codeCache = new Map<string, string>()

async function loadSystemScriptCode(file: string): Promise<string> {
  const hit = codeCache.get(file)
  if (hit != null) return hit
  const res = await fetch(chrome.runtime.getURL(file))
  if (!res.ok) throw new Error(`系统脚本源码读取失败：${file}（HTTP ${res.status}）`)
  const code = await res.text()
  codeCache.set(file, code)
  return code
}

// 录制系统脚本的匹配面：覆盖全部站点。录制绑**标签页**不绑站点 —— 用户点的是
// 「这一页在录」，此后这一页导航到哪个 host 都该继续录；而注册没有 tab 维度
// （RegisteredUserScript 的匹配字段全是 URL），只能覆盖全部。
// 注意：本文件涉及这条匹配串的说明只用行注释 —— 串里的「*」紧跟「/」，写进块注释
// 会被当成注释结束符，注释提前截断会连带大片代码解析错位。
const TAB_RECORD_MATCHES = ['*://*/*']

/** 录制系统脚本的匹配面（engine 的「在册没变就跳过」比对面也用它） */
export const SYSTEM_TAB_RECORD_MATCHES = TAB_RECORD_MATCHES

/**
 * 录制系统脚本的注册态（每次调用现取：源码有缓存，项目对象是廉价派生）。
 * enabled 恒真 —— 录制的启停在注册面（注册 / 注销），不在项目开关上。
 */
export async function tabRecorderProject(): Promise<ScriptProject> {
  const code = await loadSystemScriptCode(TAB_RECORDER_FILE)
  const now = Date.now()
  return {
    v: 2,
    uuid: TAB_RECORDER_ID,
    name: '页面录制',
    enabled: true,
    config: { ...defaultConfig(TAB_RECORD_MATCHES), runAt: 'document_start', allFrames: true },
    source: { code, savedAt: now },
    createdAt: now,
  }
}
