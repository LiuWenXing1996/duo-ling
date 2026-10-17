// 脚本桥中继件 · 宿主侧注册面（自 builtin-scripts registry.ts + 应用 engine.ts 收编进包）。
//
// 中继件（relay/entry.ts + install.ts）打成 IIFE 后以**字符串内嵌**进包产物：
//   js: [{ code: RELAY_IIFE }, { code: buildRelayInit(secret) }]
// 两段按数组顺序在同一世界执行 —— ①把安装函数挂到 window，②把运行期密钥递进去调它。
// 密钥每扩展一把、运行期才生成，塞不进代码串，故必须两段。
//
// 为什么中继件归包而其余内置件（检查器 / 浮层 / 录制件）归应用：脚本切到 MAIN 世界后没有
// `chrome.*`，GM 能力全靠本件转给 SW —— 它是「跑全量 GM」的组成部分而非产品功能，
// 任何接入扩展都需要它，registerAllEnabled 内置维护（第三方零接线）。
//
// 世界要求：注册到独立世界（worldId: SCRIPT_RELAY_WORLD_ID）且必须
// configureWorld({ messaging: true })，否则世界内没有 chrome.runtime，整条桥静默失效。
import type { ScriptProject } from '@duoling/userscript-core'
import { BRIDGE_RELAY_BOOT_KEY } from '@duoling/shared'
import { RELAY_IIFE } from './relay-code.gen'
import { enabledMatchUnion, sameMatchSet } from '@duoling/userscript-core'
import { configureWorld, getOrCreatePageSecret } from '../registration'

/** 注册 id（一个扩展一份） */
export const SCRIPT_RELAY_ID = 'dl-script-relay'
/** 独立世界 id：必须 configureWorld({ messaging: true })，否则世界内无 chrome.runtime */
export const SCRIPT_RELAY_WORLD_ID = 'us-dl-bridge'

/**
 * 中继件的装配段：运行器代码注入后由本段把运行期密钥递进去。
 *
 * 运行器缺失（两段没落在同一世界 / 包产物损坏）是装配错误，这里出声而不是静默：
 * 静默的话脚本侧只能等 GM 调用超时，看不出是装配问题。
 */
export function buildRelayInit(secret: string): string {
  const key = JSON.stringify(BRIDGE_RELAY_BOOT_KEY)
  return `;(function () {
  var boot = window[${key}]
  if (typeof boot !== 'function') {
    console.warn('[duoling:relay] 中继件运行器未装配到本世界，GM 桥不可用')
    return
  }
  boot(${JSON.stringify(secret)})
})()`
}

/**
 * 按并集维护脚本桥中继件（幂等可重入；调用方负责串行化 —— 全量链与宿主注入件同队列）。
 *
 * 注册条件是「启用脚本的匹配并集」。并集未变且件已在位时跳过重注册
 * （重注册会换注入源码，已加载页面要到下次导航才换新）。
 */
export async function syncScriptRelay(projects: ScriptProject[]): Promise<void> {
  if (!chrome.userScripts || typeof chrome.userScripts.register !== 'function') return
  const union = enabledMatchUnion(projects)
  let existing: chrome.userScripts.RegisteredUserScript | undefined
  try {
    existing = (await chrome.userScripts.getScripts()).find((s) => s.id === SCRIPT_RELAY_ID)
  } catch {
    return // 引擎不可用时静默跳过（上层已有可用性检测兜底）
  }
  if (!union) {
    if (existing) await chrome.userScripts.unregister({ ids: [SCRIPT_RELAY_ID] }).catch(() => {})
    return
  }
  if (existing && sameMatchSet(existing, union)) return
  const secret = await getOrCreatePageSecret()
  // 中继件的独立世界必须先开 messaging，否则件内没有 chrome.runtime，整条桥静默失效
  // （自定义世界不继承默认世界配置）。
  const worldOk = await configureWorld(SCRIPT_RELAY_WORLD_ID)
  if (!worldOk) {
    console.warn(
      '[duoling:userscript] 脚本桥中继件世界配置失败（无 messaging，GM 桥不可用）',
      SCRIPT_RELAY_WORLD_ID,
    )
  }
  await chrome.userScripts.unregister({ ids: [SCRIPT_RELAY_ID] }).catch(() => {})
  const relay: chrome.userScripts.RegisteredUserScript = {
    id: SCRIPT_RELAY_ID,
    worldId: SCRIPT_RELAY_WORLD_ID,
    // 两段顺序不能换：前一段（IIFE）只把安装函数挂到 window 上，后一段把运行期密钥递进去调它
    js: [{ code: RELAY_IIFE }, { code: buildRelayInit(secret) }],
    matches: union.matches,
    excludeMatches: union.excludeMatches,
    includeGlobs: union.includeGlobs,
    excludeGlobs: union.excludeGlobs,
    // document_start：必须早于脚本默认的 document_idle 握手窗口
    runAt: 'document_start',
    allFrames: true,
  }
  try {
    await chrome.userScripts.register([relay])
    console.log('[duoling:userscript] 脚本桥中继件注册成功：', JSON.stringify(union.matches))
  } catch (e) {
    console.warn('[duoling:userscript] 脚本桥中继件注册失败：', e)
    throw e
  }
}
