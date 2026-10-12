// 本机环境快照（AI 的 env_read 工具的数据源）。
//
// 取数位置 = offscreen document（扩展自己的隐藏页面）：它是完整 DOM 文档，navigator / screen /
// Intl / matchMedia 都在场。这些是**浏览器进程级**的值，与用户正在看的那个网页读到的是同一份
// —— 例外只有两种：页面被 DevTools 设备模拟覆盖、或页面上的脚本改写过 navigator。
// 那两类差异属「页面实际读数」，归 page_env_read（走注入通道取），本模块只负责机器真值。
//
// 逐层降级取数（任何一层拿不到都继续往下走，不抛错）：
//   1. UA Client Hints 高熵值 —— **唯一**能拿到芯片架构的路子。必须用它而不是解析 UA 字符串：
//      Apple Silicon 上的 Chrome 至今把 UA 写成 `Intel Mac OS X`，从 UA 推架构必然给出错的答案。
//   2. UA-CH 低熵值（platform）—— 无需异步查询，覆盖面更广。
//   3. UA 字符串解析 —— 兜底，只判平台名。**架构与平台版本留空**，不用解析结果冒充实测值
//      （UA 里的 macOS 版本同样被冻结在 10_15_7，是假值）。
//
// 为什么依赖注入：单测跑在 Node 下，没有 userAgentData / screen / matchMedia。把宿主对象当参数
// 传进来，取数本身就成了纯函数，可以逐项造值验证降级路径。

import { readInjectedBuildInfo } from '@/lib/build-info'

/** UA Client Hints 面（TS 的 DOM lib 未收录该 API，故就地声明；字段全可选，缺失即当不可用） */
interface UaDataLike {
  platform?: string
  getHighEntropyValues?: (hints: string[]) => Promise<Record<string, unknown>>
}

/** 取数用到的 navigator 面（只列用得上的字段，不照抄 lib.dom 的全量 Navigator） */
export interface EnvHostNav {
  userAgent?: string
  platform?: string
  language?: string
  languages?: readonly string[]
  hardwareConcurrency?: number
  /** 2 的幂分档、封顶 8 —— 给的是内存档次而非实测量 */
  deviceMemory?: number
  maxTouchPoints?: number
  userAgentData?: UaDataLike
}

/** 取数用到的 screen 面 */
export interface EnvHostScreen {
  width?: number
  height?: number
  availWidth?: number
  availHeight?: number
  colorDepth?: number
}

export interface EnvSnapshotDeps {
  nav: EnvHostNav
  screen: EnvHostScreen
  devicePixelRatio?: number
  matchMedia?: (query: string) => { matches: boolean }
  /** IANA 时区名（如 Asia/Shanghai）；取不到给空串 */
  timeZone?: () => string
  /** 扩展自身版本与是否 dev 构建 */
  extension?: () => { version: string; dev: boolean }
}

/**
 * 一份环境快照。形状固定（取不到的项给 `''` / `null`，不留空字段）——
 * 模型要能一眼分清「这项是空」和「这项没给」，缺字段会逼它去猜。
 */
export interface EnvSnapshot {
  collectedAt: number
  os: {
    /** macOS / Windows / Linux / Chrome OS / Android / iOS；判不出为空串 */
    platform: string
    /** 平台版本（UA-CH 高熵值；UA 里的那版是冻结假值，不从那里兜底） */
    version: string
    /** arm / x86 —— 只认 UA-CH，判不出留空 */
    arch: string
    /** 64 / 32 —— 同上 */
    bitness: string
  }
  cpu: {
    cores: number | null
    /** 内存档次（GB，2 的幂近似、封顶 8），不是实测量 */
    memoryGB: number | null
  }
  browser: {
    /** Chrome / Edge / Opera / Firefox / Safari；判不出为空串 */
    name: string
    /** 完整版本号 */
    version: string
    /** 完整 UA 原串 */
    ua: string
  }
  extension: {
    /** 扩展自身版本（含预发布标签） */
    version: string
    /** 是否 dev 构建 */
    dev: boolean
  }
  display: {
    width: number | null
    height: number | null
    availWidth: number | null
    availHeight: number | null
    colorDepth: number | null
    /** 设备像素比 */
    dpr: number | null
  }
  locale: {
    language: string
    languages: string[]
    timeZone: string
  }
  prefs: {
    /** 系统是否深色（本扩展主题跟随系统） */
    darkMode: boolean | null
    /** 系统是否要求减弱动效 */
    reducedMotion: boolean | null
    touchPoints: number | null
  }
}

const UNKNOWN = ''

/** 数值项：非有限数一律当拿不到（NaN / undefined 都不该进入快照） */
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** 字符串项：非字符串当空串（拿不到与空值是同一个语义） */
function str(v: unknown): string {
  return typeof v === 'string' ? v : UNKNOWN
}

/** UA 里的平台名兜底。只判平台，**不判架构、不取版本**（两者在 UA 里都不可信） */
export function platformFromUa(ua: string): string {
  if (!ua) return UNKNOWN
  if (/Android/i.test(ua)) return 'Android'
  if (/CrOS/i.test(ua)) return 'Chrome OS'
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS'
  if (/Mac OS X|Macintosh/i.test(ua)) return 'macOS'
  if (/Windows/i.test(ua)) return 'Windows'
  if (/Linux/i.test(ua)) return 'Linux'
  return UNKNOWN
}

/** UA 里的浏览器名（判序即优先级：Edge / Opera 的 UA 里都含 Chrome 字样） */
function browserNameFromUa(ua: string): string {
  if (!ua) return UNKNOWN
  if (/\bEdg[A-Z]?\//.test(ua)) return 'Edge'
  if (/\bOPR\//.test(ua)) return 'Opera'
  if (/\bFirefox\//.test(ua)) return 'Firefox'
  if (/\bChrome\//.test(ua)) return 'Chrome'
  if (/\bSafari\//.test(ua)) return 'Safari'
  return UNKNOWN
}

/** UA 里的浏览器完整版本 */
function versionFromUa(ua: string): string {
  const m = ua.match(/(?:Chrome|Firefox|Version)\/([\d.]+)/)
  return m ? m[1] : UNKNOWN
}

/**
 * 从 UA-CH 的 fullVersionList 取版本：优先「Google Chrome」品牌，其次 Chromium，
 * 最后取任一非 grease 品牌（grease 品牌是规范要求的占位符，版本号无意义）。
 */
function versionFromBrands(list: unknown): string {
  if (!Array.isArray(list)) return UNKNOWN
  const brands = list.filter(
    (b): b is { brand: string; version: string } =>
      !!b && typeof b === 'object' && typeof (b as { version?: unknown }).version === 'string',
  )
  const pick =
    brands.find((b) => /Google Chrome/i.test(b.brand)) ??
    brands.find((b) => /Chromium/i.test(b.brand)) ??
    brands.find((b) => !/Not/i.test(b.brand) || !/Brand/i.test(b.brand))
  return pick?.version ?? UNKNOWN
}

/** 媒体查询求值；没有 matchMedia（或它抛错）时返回 null = 未知 */
function queryMatches(
  mq: EnvSnapshotDeps['matchMedia'],
  query: string,
): boolean | null {
  if (!mq) return null
  try {
    return mq(query)?.matches ?? null
  } catch {
    return null
  }
}

/** 汇总一份环境快照。任何单项取不到都只让那一项为空，不影响其余项。 */
export async function collectEnvSnapshot(deps: EnvSnapshotDeps): Promise<EnvSnapshot> {
  const ua = str(deps.nav.userAgent)
  const uaData = deps.nav.userAgentData

  // UA-CH 高熵值：受权限策略约束，可能被拒（内嵌场景）或 API 整体缺失 —— 一律退化为空对象
  let hi: Record<string, unknown> = {}
  if (uaData?.getHighEntropyValues) {
    try {
      hi = await uaData.getHighEntropyValues([
        'architecture',
        'bitness',
        'platform',
        'platformVersion',
        'fullVersionList',
      ])
    } catch {
      hi = {}
    }
  }

  const ext = deps.extension?.() ?? { version: UNKNOWN, dev: false }

  return {
    collectedAt: Date.now(),
    os: {
      platform: str(hi.platform) || str(uaData?.platform) || platformFromUa(ua),
      version: str(hi.platformVersion),
      arch: str(hi.architecture),
      bitness: str(hi.bitness),
    },
    cpu: {
      cores: num(deps.nav.hardwareConcurrency),
      memoryGB: num(deps.nav.deviceMemory),
    },
    browser: {
      name: browserNameFromUa(ua),
      version: versionFromBrands(hi.fullVersionList) || versionFromUa(ua),
      ua,
    },
    extension: { version: str(ext.version), dev: !!ext.dev },
    display: {
      width: num(deps.screen.width),
      height: num(deps.screen.height),
      availWidth: num(deps.screen.availWidth),
      availHeight: num(deps.screen.availHeight),
      colorDepth: num(deps.screen.colorDepth),
      dpr: num(deps.devicePixelRatio),
    },
    locale: {
      language: str(deps.nav.language),
      languages: Array.isArray(deps.nav.languages) ? [...deps.nav.languages] : [],
      timeZone: deps.timeZone?.() ?? UNKNOWN,
    },
    prefs: {
      darkMode: queryMatches(deps.matchMedia, '(prefers-color-scheme: dark)'),
      reducedMotion: queryMatches(deps.matchMedia, '(prefers-reduced-motion: reduce)'),
      touchPoints: num(deps.nav.maxTouchPoints),
    },
  }
}

/**
 * 生产取数：把宿主全局对象打包成 deps。offscreen 文档里这些都在场。
 *
 * 扩展版本走构建注入而非 `getManifest().version`：manifest 的 version 字段装不下预发布标签
 * （有预发布标签时会被改写成别的值），注入值才是本次构建的真实版本。
 */
export function defaultEnvDeps(): EnvSnapshotDeps {
  const g = globalThis as unknown as {
    navigator?: EnvHostNav
    screen?: EnvHostScreen
    devicePixelRatio?: number
    matchMedia?: (query: string) => { matches: boolean }
  }
  return {
    nav: g.navigator ?? {},
    screen: g.screen ?? {},
    devicePixelRatio: g.devicePixelRatio,
    matchMedia: g.matchMedia,
    timeZone: () => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || UNKNOWN
      } catch {
        return UNKNOWN
      }
    },
    extension: () => ({
      version:
        readInjectedBuildInfo()?.version ??
        (typeof chrome !== 'undefined' && chrome.runtime?.getManifest
          ? chrome.runtime.getManifest().version
          : UNKNOWN),
      dev: import.meta.env.DEV,
    }),
  }
}

/** 一步取到（env_read 的调用点用它） */
export function readEnvSnapshot(): Promise<EnvSnapshot> {
  return collectEnvSnapshot(defaultEnvDeps())
}
