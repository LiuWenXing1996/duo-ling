// 网络录制件（dl-recorder）注册同步：MAIN 捕获件 + USER_SCRIPT 转发件。
//
// 这是 duo-ling 原生的 userScripts 注入特性（与脚本运行引擎解耦）：脚本引擎（自研 / VM）负责
// 跑用户脚本，录制件负责在用户已同意的 host 上捕获页面 fetch/XHR 供 AI 使用，两者独立进退。
// P4 自研引擎删除后，这段注册逻辑从 engine.ts 迁出独立成模块。
import { getNetCaptureHosts } from './net-capture-gate'
import { buildNetRecorderSource } from './net-recorder'
import { buildNetForwarderSource } from './net-forwarder'
import { hostToMatchPattern } from './net-record-protocol'
// 内置注入脚本共用：匹配并集与「未变则跳过」比对
import { sameMatchSet } from './match-union'

/** 网络录制 · MAIN 捕获件注册 ID（一个扩展一份） */
export const NET_RECORDER_ID = 'dl-net-recorder'
/** 网络录制 · USER_SCRIPT 转发件注册 ID（一个扩展一份） */
export const NET_FORWARDER_ID = 'dl-net-forwarder'
/** 转发件的独立世界 id：必须 configureWorld({ messaging: true })，否则世界内无 chrome.runtime */
const NET_FORWARDER_WORLD_ID = 'us-dl-net'

/**
 * 配置指定 USER_SCRIPT 世界的 messaging —— 录制转发件的前提。
 * 不传 worldId 则配置默认世界。
 */
async function configureUserScriptWorld(worldId?: string): Promise<boolean> {
  if (!chrome.userScripts || typeof chrome.userScripts.configureWorld !== 'function') {
    return false
  }
  const base = worldId ? { worldId } : {}
  try {
    await chrome.userScripts.configureWorld({ ...base, messaging: true })
    return true
  } catch (e) {
    // 配置失败：该世界无 chrome.runtime，转发不可用，但 SW 不崩（捕获件仍可本地记录）
    console.warn('[duoling:userscript] 世界配置失败，转发件不可用', worldId ?? '(默认世界)', e)
    return false
  }
}

/** 逐个注销（Chrome 批量注销是整批原子，混进不在册 id 整批失败，故循环单个注销） */
async function unregisterScripts(ids: string[]): Promise<void> {
  if (!ids.length) return
  if (!chrome.userScripts || typeof chrome.userScripts.unregister !== 'function') return
  for (const id of ids) {
    await chrome.userScripts.unregister({ ids: [id] }).catch((e) => {
      if (!/Nonexistent script ID/.test(String(e))) {
        console.warn('[duoling:sw] 注销失败：', id, e)
      }
    })
  }
}

/**
 * 按门禁集合维护录制件注册（幂等可重入；调用方负责串行化）。
 * 集合为空 → 注销两件；否则对 `*://<host>/*` 注册 MAIN 捕获件 + USER_SCRIPT 转发件。
 * 集合未变且两件都在位时跳过重注册（重注册会换注入源码，已加载页面要到下次导航才换新）。
 */
async function syncNetRecorder(): Promise<void> {
  if (!chrome.userScripts || typeof chrome.userScripts.register !== 'function') return
  const hosts = await getNetCaptureHosts()
  const matches = hosts.map(hostToMatchPattern).filter(Boolean)
  let existing: chrome.userScripts.RegisteredUserScript[] = []
  try {
    existing = (await chrome.userScripts.getScripts()).filter(
      (s) => s.id === NET_RECORDER_ID || s.id === NET_FORWARDER_ID,
    )
  } catch {
    return // 引擎不可用时静默跳过（上层已有状态横幅兜底）
  }
  if (!matches.length) {
    if (existing.length) {
      await unregisterScripts(existing.map((s) => s.id))
      console.log('[duoling:sw] 录制门禁为空，已注销 dl-recorder')
    }
    return
  }
  const recorder = existing.find((s) => s.id === NET_RECORDER_ID)
  const forwarder = existing.find((s) => s.id === NET_FORWARDER_ID)
  const union = { matches }
  if (recorder && forwarder && sameMatchSet(recorder, union) && sameMatchSet(forwarder, union)) {
    return
  }
  // 转发件的独立世界必须先开 messaging——自定义世界不继承默认世界配置，否则它没有
  // chrome.runtime、转发件 sendMessage 全静默失败（症状：录制件在、库里永远没数据）
  const worldOk = await configureUserScriptWorld(NET_FORWARDER_WORLD_ID)
  if (!worldOk) {
    console.warn('[duoling:userscript] 录制转发件世界配置失败（无 messaging，转发不可用）', NET_FORWARDER_WORLD_ID)
  }
  await unregisterScripts([NET_RECORDER_ID, NET_FORWARDER_ID])
  const common = { matches, runAt: 'document_start' as const, allFrames: true }
  const recorderScript: chrome.userScripts.RegisteredUserScript = {
    id: NET_RECORDER_ID,
    world: 'MAIN',
    js: [{ code: buildNetRecorderSource() }],
    ...common,
  }
  const forwarderScript: chrome.userScripts.RegisteredUserScript = {
    id: NET_FORWARDER_ID,
    worldId: NET_FORWARDER_WORLD_ID,
    js: [{ code: buildNetForwarderSource() }],
    ...common,
  }
  try {
    await chrome.userScripts.register([recorderScript, forwarderScript])
    console.log('[duoling:sw] 录制件注册成功：', JSON.stringify(matches))
  } catch (e) {
    console.warn('[duoling:sw] 录制件注册失败：', e)
    throw e
  }
}

/**
 * 重算录制件注册（挂串行队列）。门禁集合变更后（开启 / 关闭录制）由调用方触发。
 * 与脚本注册分开：录制件跟随的是 per-host 门禁，不是脚本集合。
 */
let netRecorderChain: Promise<void> = Promise.resolve()
export function refreshNetRecorder(): Promise<void> {
  const run = netRecorderChain.then(() => syncNetRecorder())
  netRecorderChain = run.catch(() => {})
  return run
}
