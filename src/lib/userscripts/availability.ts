// 用户脚本运行时可用性检测（与注入引擎无关：自研引擎与 VM 都建立在 chrome.userScripts API 之上，
// 该 API 是否可用、以及不可用时的引导文案两路通用）。
//
// 本模块只做「探测 + 文案」，不碰世界配置——自研引擎的默认 / 每脚本世界配置已随 P4 删除；
// VM 在装配期自行 configureWorld({ worldId: 'vm' })，不在此处触发。

import type { UserScriptsAvailability } from './types'
// 版本判断与「打开扩展管理页」入口同源（引导文案按 <138 / ≥138 分支，UI 侧按钮也按同一分支取 URL）
import { getChromeMajorVersion } from '@/lib/extension-page'

/** 版本无关的可用性检测：getScripts 抛错即不可用（全 Chrome 版本适用） */
export async function isUserScriptsAvailable(): Promise<boolean> {
  try {
    await chrome.userScripts.getScripts()
    return true
  } catch {
    return false
  }
}

/**
 * 运行时可用性状态：结合 isUserScriptsAvailable + UA 分支，返回结构化信息供管理页状态横幅展示。
 * - Chrome ≥138：需在扩展详情页开启「允许运行用户脚本」按扩展开关
 * - Chrome <138：需开启全局「开发者模式」
 * - Firefox：需授权 userScripts optional 权限
 */
export async function getUserScriptsStatus(): Promise<UserScriptsAvailability> {
  const ua = navigator.userAgent
  const isFirefox = /Firefox\//.test(ua)
  const chromeMajor = getChromeMajorVersion()
  // 纯查询、无副作用：开关被打开后的「补注册」自愈在 VM 装配 / 对账层（vm-runtime-host /
  // vm-script-manager），不藏在查询里——查询方（横幅 / 引导页 / 监视器）各自语义单一。
  const available = await isUserScriptsAvailable()
  let guideText = ''
  if (!available) {
    if (isFirefox) {
      guideText = 'Firefox：在扩展管理页（about:addons → 哆灵 → 偏好）勾选「User Scripts」权限后即可使用。'
    } else if (chromeMajor >= 138) {
      guideText = 'Chrome ≥138：在扩展详情页开启「允许运行用户脚本」开关后即可使用。'
    } else {
      guideText = 'Chrome <138：在 chrome://extensions 开启全局「开发者模式」后即可使用。'
    }
  }
  return { available, isFirefox, chromeMajor, guideText }
}
