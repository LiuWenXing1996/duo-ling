// SW 的 registerScript 也走这里：它负责校验、解析源码与 @require、把脚本配置映射成注册参数，
// 注册动作（拼装 → 先注销再注册）收敛在本函数。裸代码的程序化安装直接调本函数即可。
// 装进去的代码一律过 buildUserScript 拼装，因此正文按词法就能拿到内核建好的 `DL`。
import { buildUserScript } from './build-user-script'

/** 装一条自定义脚本时可覆盖的注册参数（缺省值见下面的常量） */
export interface InstallCustomUserScriptOptions {
  /** 注册幂等键：同 id 重装会先注销再注册。缺省随机，适合一次性的临时脚本 */
  id?: string
  /** 注入体里首尾日志与 sourceURL 用的名字。缺省取 id */
  name?: string
  /** 匹配规则（match pattern）；缺省全站 —— register 不接受空 matches */
  matches?: string[]
  /** 排除规则 / glob 三件，原样透传给 register（脚本库的注册要把它们带上） */
  excludeMatches?: string[]
  includeGlobs?: string[]
  excludeGlobs?: string[]
  /** `@require` 已抓取的源码，按声明顺序拼在正文之前 */
  requires?: readonly string[]
  /** 缺省 document_start：脚本库那条的常用档位 */
  runAt?: 'document_start' | 'document_end' | 'document_idle'
  /** 缺省只注入顶层 frame（与脚本库默认一致） */
  allFrames?: boolean
  /**
   * 是否把 id 记进全量同步的保留名单，缺省 true。
   *
   * 走脚本库的注册要传 false：那些 id 由引擎自己管 —— 删除 / 关停时靠全量同步的残留清扫
   * 兜底（注销失败也不会留下幽灵注册）。记进名单等于把这条兜底关掉。
   */
  protectFromSync?: boolean
}

const DEFAULT_MATCHES: string[] = ['*://*/*']
const DEFAULT_RUN_AT: NonNullable<InstallCustomUserScriptOptions['runAt']> = 'document_start'

// 本进程内装过的 id：SW 的全量同步据此把它们排除在 stale 清扫之外。
// 只活在内存里 —— 注册本身也不跨浏览器重启存活，重启后两者一起归零，不会出现
// 「名单还在、注册已没」的半截状态。
const installedIds = new Set<string>()

/** 本进程内装上、且要保护的 id（供 SW 拼全量同步的保留名单） */
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
  await ensureWorldMessaging()
  await api.unregister({ ids: [script.id] }).catch(() => {})
  await api.register([script])
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
      { code: buildUserScript({ uuid: id, name, source: code, requires: options.requires }) },
    ],
    matches: options.matches?.length ? options.matches : DEFAULT_MATCHES,
    excludeMatches: options.excludeMatches,
    includeGlobs: options.includeGlobs,
    excludeGlobs: options.excludeGlobs,
    runAt: options.runAt ?? DEFAULT_RUN_AT,
    allFrames: options.allFrames ?? false,
  })
  if (options.protectFromSync !== false) installedIds.add(id)
  return { id }
}

/** 注销一条自定义脚本：不在册也静默成功（与 SW 的 unregisterScripts 同口径） */
export async function uninstallCustomUserScript(id: string): Promise<void> {
  const api = chrome.userScripts
  if (!api || typeof api.unregister !== 'function') return
  await api.unregister({ ids: [id] }).catch(() => {})
  installedIds.delete(id)
}
