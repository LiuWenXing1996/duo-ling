// 系统脚本（原「内置件」）：扩展随包分发的注入件，改走统一脚本注册链。
//
// 与用户脚本的差别只在**来源与托管**：源码 = 扩展产物里的件文件（随扩展发版更新，
// 扩展更新清空注册后由同步链补回），uuid 固定，不入项目库 —— 不占用户脚本列表、
// 不可被用户编辑 / 删除，也没有 duoling-fs 侧的工作区。注册本身与用户脚本同一条
// registerScript 路径（GM 包装 + 脚本桥一并内联，中继件并集须把系统脚本算上，
// 见 engine.ts 的调用处）。
import type { ScriptProject } from '@duoling/shared'
import {
  FLOAT_HOST_FILE,
  FLOAT_HOST_ID,
  INSPECTOR_HOST_FILE,
  INSPECTOR_HOST_ID,
  TAB_RECORDER_FILE,
  TAB_RECORDER_ID,
} from '@duoling/builtin-scripts'
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

/** 录制系统脚本的匹配面（engine 的「在册没变就跳过」比对面也用它） */
export const SYSTEM_TAB_RECORD_MATCHES = ALWAYS_ON_MATCHES

/** 页面检查器系统脚本的匹配面（engine 的「在册没变就跳过」比对面也用它） */
export const SYSTEM_INSPECTOR_MATCHES = ALWAYS_ON_MATCHES

/** 浮层宿主系统脚本的匹配面（engine 的「在册没变就跳过」比对面也用它） */
export const SYSTEM_FLOAT_MATCHES = ALWAYS_ON_MATCHES

/**
 * 三件系统脚本的展示信息（名字 / 注入世界 / 一句话作用）。
 *
 * 消费方两处：engine 的 listBuiltinRegistrations 把它并进 BUILTIN_META（popup 的页面概览与
 * 工作台「脚本列表」底部分区两处 UI 只读透出），以及本文件三个 project 构建器的 `name`
 * —— 展示名单一来源，件「自己声明自己」。中继件（脚本桥）不在：它已在包内
 * （relay/sync），不是系统脚本，展示条目由 engine 自行补。
 */
export const SYSTEM_SCRIPT_DISPLAY: Readonly<
  Record<string, { name: string; world: string; note: string }>
> = {
  [INSPECTOR_HOST_ID]: {
    name: '页面检查器',
    world: '页面主世界',
    note: '在页面里待命：收到指令才点选元素 / 抓快照 / 读环境，平时不亮任何 UI',
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
}

/**
 * 页面检查器系统脚本的注册态（每次调用现取：源码有缓存，项目对象是廉价派生）。
 * enabled 恒真 —— 它没有用户开关，与录制件同为「扩展托管、恒注册」。
 */
export async function pageInspectorProject(): Promise<ScriptProject> {
  const code = await loadSystemScriptCode(INSPECTOR_HOST_FILE)
  const now = Date.now()
  return {
    v: 2,
    uuid: INSPECTOR_HOST_ID,
    name: SYSTEM_SCRIPT_DISPLAY[INSPECTOR_HOST_ID].name,
    enabled: true,
    config: { ...defaultConfig(SYSTEM_INSPECTOR_MATCHES), runAt: 'document_start' },
    source: { code, savedAt: now },
    createdAt: now,
  }
}

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
    name: SYSTEM_SCRIPT_DISPLAY[TAB_RECORDER_ID].name,
    enabled: true,
    config: { ...defaultConfig(SYSTEM_TAB_RECORD_MATCHES), runAt: 'document_start', allFrames: true },
    source: { code, savedAt: now },
    createdAt: now,
  }
}

/**
 * 浮层宿主系统脚本的注册态（每次调用现取：源码有缓存，项目对象是廉价派生）。
 * enabled 恒真 —— 它没有用户开关，与检查器同为「扩展托管、恒注册」。
 *
 * **占位符替换**：件源码里的 `__DL_FLOAT_PANEL_URL__` / `__DL_FLOAT_EXT_NAME__`
 * 在这里替换成 JSON 字面量（浮层页地址与扩展显示名只有扩展侧取得到，而注册项是静态字符串；
 * 件包因此不认识 chrome.* 与扩展身份）。按「引号包住的完整 token」替换 —— esbuild 的产物
 * 一律用双引号输出字符串字面量，这个匹配形态是稳定的；找不到 token 说明产物变了，宁可炸出声。
 */
export async function floatHostProject(panelUrl: string, extensionName: string): Promise<ScriptProject> {
  const raw = await loadSystemScriptCode(FLOAT_HOST_FILE)
  const PANEL_TOKEN = '"__DL_FLOAT_PANEL_URL__"'
  const NAME_TOKEN = '"__DL_FLOAT_EXT_NAME__"'
  if (!raw.includes(PANEL_TOKEN) || !raw.includes(NAME_TOKEN)) {
    throw new Error('浮层宿主件源码缺占位符（构建产物与替换约定不符）：' + FLOAT_HOST_FILE)
  }
  const code = raw
    .replaceAll(PANEL_TOKEN, JSON.stringify(panelUrl))
    .replaceAll(NAME_TOKEN, JSON.stringify(extensionName))
  const now = Date.now()
  return {
    v: 2,
    uuid: FLOAT_HOST_ID,
    name: SYSTEM_SCRIPT_DISPLAY[FLOAT_HOST_ID].name,
    enabled: true,
    config: { ...defaultConfig(SYSTEM_FLOAT_MATCHES), runAt: 'document_start' },
    source: { code, savedAt: now },
    createdAt: now,
  }
}
