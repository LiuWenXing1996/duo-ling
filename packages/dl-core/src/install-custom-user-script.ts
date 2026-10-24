import { buildUserScript } from './build-user-script'
import type { ScriptInfo } from './dl'

export interface InstallCustomUserScriptOptions {
  id?: string
  name?: string
  info?: ScriptInfo
  matches?: string[]
  excludeMatches?: string[]
  includeGlobs?: string[]
  excludeGlobs?: string[]
  requires?: readonly string[]
  runAt?: 'document_start' | 'document_end' | 'document_idle'
  allFrames?: boolean
  protectFromSync?: boolean
  world?: 'MAIN' | 'USER_SCRIPT'
}

const DEFAULT_MATCHES: string[] = ['*://*/*']
const DEFAULT_RUN_AT: NonNullable<InstallCustomUserScriptOptions['runAt']> = 'document_start'

const installedIds = new Set<string>()

export function installedCustomScriptIds(): readonly string[] {
  return [...installedIds]
}

export function protectCustomScriptId(id: string): void {
  installedIds.add(id)
}

function userScriptsApi(): typeof chrome.userScripts {
  const api = chrome.userScripts
  if (!api || typeof api.register !== 'function') {
    throw new Error('用户脚本功能不可用：需在扩展详情页开启「允许运行用户脚本」')
  }
  return api
}

async function ensureWorldMessaging(): Promise<void> {
  const api = chrome.userScripts
  if (typeof api?.configureWorld === 'function') {
    await api.configureWorld({ messaging: true })
  }
}

export async function registerUserScript(
  script: chrome.userScripts.RegisteredUserScript,
): Promise<void> {
  const api = userScriptsApi()
  if (script.world !== 'MAIN') await ensureWorldMessaging()
  await api.unregister({ ids: [script.id] }).catch(() => {})
  await api.register([script])
}

export async function registerRelayScript(
  id: string,
  code: string,
  matches: readonly string[],
): Promise<void> {
  if (!code.trim()) throw new Error('registerRelayScript：中继件源码为空，拒绝注册')
  await registerUserScript({
    id,
    js: [{ code }],
    matches: [...matches],
    runAt: 'document_start',
    allFrames: true,
  })
}

export async function installCustomUserScript(
  code: string,
  options: InstallCustomUserScriptOptions = {},
): Promise<{ id: string }> {
  if (!code.trim()) throw new Error('installCustomUserScript：脚本代码为空，拒绝注册')
  const id = options.id ?? `dl-custom-${crypto.randomUUID()}`
  const name = options.name ?? id
  await registerUserScript({
    id,
    js: [
      {
        code: buildUserScript({
          uuid: id,
          name,
          source: code,
          requires: options.requires,
          info: options.info,
        }),
      },
    ],
    matches: options.matches?.length ? options.matches : DEFAULT_MATCHES,
    excludeMatches: options.excludeMatches,
    includeGlobs: options.includeGlobs,
    excludeGlobs: options.excludeGlobs,
    runAt: options.runAt ?? DEFAULT_RUN_AT,
    allFrames: options.allFrames ?? false,
    ...(options.world ? { world: options.world } : {}),
  })
  if (options.protectFromSync !== false) installedIds.add(id)
  return { id }
}

export async function uninstallCustomUserScript(id: string): Promise<void> {
  const api = chrome.userScripts
  if (!api || typeof api.unregister !== 'function') return
  await api.unregister({ ids: [id] }).catch(() => {})
  installedIds.delete(id)
}
