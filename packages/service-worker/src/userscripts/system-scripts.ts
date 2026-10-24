import type { ScriptProject } from '@duoling/shared'
import { MESSAGING_RELAY_ID } from '@duoling/dl-core'
import {
  FLOAT_HOST_FILE,
  FLOAT_HOST_ID,
  PAGE_ENV_FILE,
  PAGE_ENV_ID,
  PAGE_SNAPSHOT_FILE,
  PAGE_SNAPSHOT_ID,
  PICK_ELEMENT_FILE,
  PICK_ELEMENT_ID,
  TAB_RECORDER_FILE,
  TAB_RECORDER_ID,
} from '@duoling/user-scripts/builtin'
import { defaultConfig } from '@duoling/shared'

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

/** 常驻系统脚本的匹配面：覆盖全部站点（注册没有 tab 维度，目标页由用户动作那一刻决定） */
const ALWAYS_ON_MATCHES = ['*://*/*']

export const SYSTEM_TAB_RECORD_MATCHES = ALWAYS_ON_MATCHES
export const SYSTEM_PICK_ELEMENT_MATCHES = ALWAYS_ON_MATCHES
export const SYSTEM_PAGE_SNAPSHOT_MATCHES = ALWAYS_ON_MATCHES
export const SYSTEM_PAGE_ENV_MATCHES = ALWAYS_ON_MATCHES
export const SYSTEM_FLOAT_MATCHES = ALWAYS_ON_MATCHES
export const SYSTEM_MESSAGING_RELAY_MATCHES = ALWAYS_ON_MATCHES

export const MESSAGING_RELAY_FILE = 'duoling-messaging-relay.js'

export const SYSTEM_SCRIPT_DISPLAY: Readonly<
  Record<string, { name: string; world: string; note: string }>
> = {
  [PICK_ELEMENT_ID]: {
    name: '页面拾取',
    world: '页面主世界',
    note: '在页面里待命：收到拾取请求才亮高亮框，用户点选后把元素载荷交回，平时不亮任何 UI',
  },
  [PAGE_SNAPSHOT_ID]: {
    name: '页面快照',
    world: '页面主世界',
    note: '在页面里待命：收到请求才抓一次渲染后的 DOM，平时不亮任何 UI',
  },
  [PAGE_ENV_ID]: {
    name: '页面环境',
    world: '页面主世界',
    note: '在页面里待命：收到请求才读视口 / 像素比 / 页面 UA，平时不亮任何 UI',
  },
  [FLOAT_HOST_ID]: {
    name: '浮层宿主',
    world: '页面主世界',
    note: '对话浮层的挂载点：收到「打开会话」才建 DOM 并展开 iframe，平时页面里什么都没有',
  },
  [TAB_RECORDER_ID]: {
    name: '页面录制',
    world: '页面主世界',
    note: '在页面真实世界里捕获网络请求（录制开关打开时才工作，经脚本桥上报）',
  },
  [MESSAGING_RELAY_ID]: {
    name: '消息中继',
    world: '用户脚本世界',
    note: '主世界件的回程通道：把页面里交来的帧汇到 SW 并按脚本分发（没有它，主世界的件收不到指令）',
  },
}

function alwaysOnProject(
  id: string,
  code: string,
  extra: { allFrames?: boolean } = {},
): ScriptProject {
  const now = Date.now()
  return {
    v: 2,
    uuid: id,
    name: SYSTEM_SCRIPT_DISPLAY[id].name,
    enabled: true,
    config: { ...defaultConfig(ALWAYS_ON_MATCHES), runAt: 'document_start', ...extra },
    source: { code, savedAt: now },
    createdAt: now,
  }
}

export async function messagingRelayCode(): Promise<string> {
  return loadSystemScriptCode(MESSAGING_RELAY_FILE)
}

export async function pickElementProject(): Promise<ScriptProject> {
  return alwaysOnProject(PICK_ELEMENT_ID, await loadSystemScriptCode(PICK_ELEMENT_FILE))
}

export async function pageSnapshotProject(): Promise<ScriptProject> {
  return alwaysOnProject(PAGE_SNAPSHOT_ID, await loadSystemScriptCode(PAGE_SNAPSHOT_FILE))
}

export async function pageEnvProject(): Promise<ScriptProject> {
  return alwaysOnProject(PAGE_ENV_ID, await loadSystemScriptCode(PAGE_ENV_FILE))
}

export async function tabRecorderProject(): Promise<ScriptProject> {
  return alwaysOnProject(TAB_RECORDER_ID, await loadSystemScriptCode(TAB_RECORDER_FILE), {
    allFrames: true,
  })
}

export async function floatHostProject(
  panelUrl: string,
  extensionName: string,
): Promise<ScriptProject> {
  const raw = await loadSystemScriptCode(FLOAT_HOST_FILE)
  const PANEL_TOKEN = '"__DL_FLOAT_PANEL_URL__"'
  const NAME_TOKEN = '"__DL_FLOAT_EXT_NAME__"'
  if (!raw.includes(PANEL_TOKEN) || !raw.includes(NAME_TOKEN)) {
    throw new Error('浮层宿主件源码缺占位符（构建产物与替换约定不符）：' + FLOAT_HOST_FILE)
  }
  const code = raw
    .replaceAll(PANEL_TOKEN, JSON.stringify(panelUrl))
    .replaceAll(NAME_TOKEN, JSON.stringify(extensionName))
  return alwaysOnProject(FLOAT_HOST_ID, code)
}
