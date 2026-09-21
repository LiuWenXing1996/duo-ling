// 检查更新：扩展自己向 GitHub Releases 取最新版本，与当前构建版本比对，供 UI 提示用户。
//
// 止于「提示」而不是「自更新」——这不是偷懒，是能力边界：
//   · Chrome 不允许扩展替换自身；
//   · 非商店渠道的自动更新在 macOS / Windows 上被平台限制（`update_url` 必须指向商店），
//     且 unpacked 扩展本就不参与自动更新。
// 所以这条链路只产出「有新版本 + 下次去哪下载」，剩下的下载与替换由用户完成。
//
// 取数用 `GET /repos/{repo}/releases` 列表而不是 `/releases/latest`：
// 后者只返回最新**正式版**、跳过 prerelease，而本项目版本线长期处于预发布
// （`0.2.0-alpha.N` 这类），那时该端点会直接 404。列表接口带 `prerelease` / `draft`
// 标记，自己筛更可靠（见 pickLatestRelease）。
//
// 仓库地址不在这里写死：由构建期从 git remote 推导、随 `__BUILD_INFO__.repo` 注入
// （见 wxt.config.ts），源码因此不含任何个人 ID，fork 出去也会自动指向各自的仓库。
//
// 结果落在 duoling-app 库（扩展自己的小数据，与模型配置 / 归属映射同处）：
// SW 在浏览器启动时写，工具栏 popup 与设置页直连读出——读侧不走命令面，不新增 IPC。

import * as appDb from './app-db'
import { readInjectedBuildInfo } from './build-info'

/** 检查结果在 duoling-app 库里的键 */
const STORAGE_KEY = 'updateCheck'

/** GitHub 请求超时：检查更新是背景行为，不能挂着不动 */
const REQUEST_TIMEOUT_MS = 10000

/** 一次 release 的裁剪视图（只留判断新版本与给出查看去处所需的字段） */
export interface ReleaseLite {
  /** 原始 tag，如 `v0.2.0-alpha.1` */
  tag: string
  prerelease: boolean
  draft: boolean
  /** Release 页面地址：更新说明与产物下载都在这一页，比直链 zip 更能说明「换了什么」 */
  htmlUrl: string
}

/** 检查结论 */
export type UpdateCheckStatus =
  /** 有新版本可用 */
  | { kind: 'update'; latest: string; releaseUrl: string }
  /** 已经是最新 */
  | { kind: 'current'; latest: string }
  /** 这次没查成（缺仓库信息 / 网络不通 / 接口报错）；reason 仅供诊断展示 */
  | { kind: 'unavailable'; reason: string }

/** 落盘的一次检查结果 */
export interface UpdateCheckRecord {
  /** 检查完成时刻（ms） */
  checkedAt: number
  /** 当时的构建版本（含预发布标签） */
  current: string
  status: UpdateCheckStatus
}

/** tag → 版本号（去掉 `v` 前缀） */
export function parseTag(tag: string): string {
  return tag.replace(/^v/, '')
}

interface ParsedVersion {
  nums: [number, number, number]
  /** 预发布标识符序列；稳定版为空数组 */
  pre: string[]
}

function parseVersion(v: string): ParsedVersion | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v.trim())
  if (!m) return null
  return {
    nums: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] ? m[4].split('.') : [],
  }
}

/** 是否是本模块能比较的版本串 */
export function isValidVersion(v: string): boolean {
  return parseVersion(v) !== null
}

/**
 * 按 SemVer 比较两个版本：`a` 较新返回正数，较旧返回负数，相同返回 0。
 *
 * 比较规则（SemVer 规范）：
 *   · 先比主次修订三段数字；
 *   · 三段相同时，**稳定版大于同 base 的预发布版**（`0.2.0-rc.1` < `0.2.0`）；
 *   · 都是预发布时逐段比较：纯数字段按数值比、其余按字典序，数字段小于字母段，
 *     前缀相同则段数少的较小（`0.2.0-alpha.1` < `0.2.0-alpha.1.1`）。
 *
 * 不能用字符串比较代替：那样 `0.2.0-alpha.1 > 0.2.0` 会判成真，方向正好反了。
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) throw new Error(`无法比较的版本串：${!pa ? a : b}`)

  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] - pb.nums[i]
  }

  const ap = pa.pre
  const bp = pb.pre
  if (ap.length === 0 && bp.length === 0) return 0
  if (ap.length === 0) return 1
  if (bp.length === 0) return -1

  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    const x = ap[i]
    const y = bp[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const xNum = /^\d+$/.test(x)
    const yNum = /^\d+$/.test(y)
    if (xNum && yNum) return Number(x) - Number(y)
    if (xNum) return -1
    if (yNum) return 1
    return x < y ? -1 : 1
  }
  return 0
}

/**
 * 未知来源的 release 载荷 → 裁剪视图；形状不对返回 null。
 * 导出便于单测：这层是外部数据的入参守卫，得能喂畸形载荷。
 */
export function toReleaseLite(raw: unknown): ReleaseLite | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.tag_name !== 'string' || !r.tag_name) return null
  return {
    tag: r.tag_name,
    prerelease: r.prerelease === true,
    draft: r.draft === true,
    htmlUrl: typeof r.html_url === 'string' ? r.html_url : '',
  }
}

/**
 * 从 release 列表挑出版本最高的一个。
 * 筛掉 draft 与版本串无法解析的 tag；**不**按创建时间挑——tag 的先后不等于版本高低
 * （补发旧版本、预发布与正式版交错时都会翻车）。
 */
export function pickLatestRelease(releases: ReleaseLite[]): ReleaseLite | null {
  let best: ReleaseLite | null = null
  let bestVersion: string | null = null
  for (const r of releases) {
    if (r.draft) continue
    const v = parseTag(r.tag)
    if (!isValidVersion(v)) continue
    if (bestVersion === null || compareVersions(v, bestVersion) > 0) {
      best = r
      bestVersion = v
    }
  }
  return best
}

/** 拉 release 列表（网络出口单独成函数，便于单测注入替身） */
async function fetchReleases(repo: string): Promise<ReleaseLite[]> {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=30`, {
    headers: { Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`GitHub 返回 ${res.status}`)
  const raw: unknown = await res.json()
  if (!Array.isArray(raw)) throw new Error('GitHub 返回的不是列表')
  return raw.map(toReleaseLite).filter((r): r is ReleaseLite => r !== null)
}

/** 读上一次的检查结果（没有则为 undefined；读失败同样返回 undefined——它是可选信息，不该阻断页面） */
export async function readUpdateCheck(): Promise<UpdateCheckRecord | undefined> {
  try {
    return await appDb.get<UpdateCheckRecord>(STORAGE_KEY)
  } catch {
    return undefined
  }
}

/**
 * 跑一次检查并落盘。
 *
 * 任何失败都收敛成 `unavailable` 结果而不是抛出：这是背景行为，离线、限速、仓库改名
 * 都属常态，调用方（SW 启动 / 用户手点）不该因此报错。
 */
export async function runUpdateCheck(): Promise<UpdateCheckRecord> {
  const info = readInjectedBuildInfo()
  const current = info?.version ?? ''
  const repo = info?.repo ?? ''

  const settle = async (status: UpdateCheckStatus): Promise<UpdateCheckRecord> => {
    const record: UpdateCheckRecord = { checkedAt: Date.now(), current, status }
    try {
      await appDb.set(STORAGE_KEY, record)
    } catch (e) {
      // 落盘失败不影响本次结果的使用，但要留痕：读侧拿到的会是上一次的记录
      console.warn('[duoling:update] 检查结果落盘失败', e)
    }
    return record
  }

  if (!repo || repo === 'unknown') return settle({ kind: 'unavailable', reason: '构建信息里没有仓库地址' })
  if (!isValidVersion(current)) return settle({ kind: 'unavailable', reason: `当前版本号无法解析：${current}` })

  try {
    const latest = pickLatestRelease(await fetchReleases(repo))
    if (!latest) return settle({ kind: 'unavailable', reason: '没有可用的 Release' })
    const latestVersion = parseTag(latest.tag)
    return settle(
      compareVersions(latestVersion, current) > 0
        ? { kind: 'update', latest: latestVersion, releaseUrl: latest.htmlUrl }
        : { kind: 'current', latest: latestVersion },
    )
  } catch (e) {
    return settle({ kind: 'unavailable', reason: e instanceof Error ? e.message : String(e) })
  }
}
