// 用户脚本的 chrome.storage 侧持久化。
//
// 2026-09-15 单写方落地后，**项目数据（源码/配置/产物/enabled）已迁往 IndexedDB 状态库
// duoling-state**（读侧 lib/userscripts/project-store.ts，写侧 project-write.ts，均不碰 chrome API）。
// 本文件只剩两类：DL.store 值（us:gm:*）、错误日志（us:errors）。
//
// 为什么这两类不一起迁：写入方是**注入页面里的用户脚本**（不受我们控制、可能被高频调用、
// 且脚本崩溃时才上报错误），且它们不参与「脚本是什么」的判定——转 offscreen 只会多一跳、
// 在最脆弱的时刻更容易丢（见 src/lib/userscripts/state-db.ts）。
import {
  GM_KEY_PREFIX,
  ERRORS_KEY,
  gmKey,
  type ScriptProject,
  type ScriptSummary,
  type UserScriptErrorRecord,
} from './types'

/**
 * 列表视图：项目摘要（不含源码与构建产物），未启用在后、启用在前，组内按更新时间倒序。
 * 项目由调用方传入（读自状态库，见 background.ts）——本文件已不再持有项目数据。
 */
export async function listSummaries(projects: ScriptProject[]): Promise<ScriptSummary[]> {
  const projectSummaries: ScriptSummary[] = projects.map((p) => ({
    uuid: p.uuid,
    name: p.name,
    enabled: p.enabled,
    matches: p.config.matches ?? [],
    // 文件数来自状态库缓存（源码在 duoling-fs，SW 读不到，故落盘时算好存于此）
    fileCount: p.fileCount ?? 0,
    updatedAt: p.updatedAt,
  }))
  return [...projectSummaries].sort(
    (a, b) => Number(b.enabled) - Number(a.enabled) || b.updatedAt - a.updatedAt,
  )
}

// —— DL.store 值存储（键空间 us:gm:<uuid>:<key> 沿用）——

export async function getGMValue(uuid: string, key: string): Promise<unknown> {
  const store = await chrome.storage.local.get(gmKey(uuid, key))
  return store[gmKey(uuid, key)]
}

export async function setGMValue(uuid: string, key: string, value: unknown): Promise<void> {
  await chrome.storage.local.set({ [gmKey(uuid, key)]: value })
}

export async function deleteGMValue(uuid: string, key: string): Promise<void> {
  await chrome.storage.local.remove(gmKey(uuid, key))
}

/** 列出某脚本存过的全部键 */
export async function listGMKeys(uuid: string): Promise<string[]> {
  const all = await chrome.storage.local.get()
  const prefix = GM_KEY_PREFIX + uuid + ':'
  return Object.keys(all)
    .filter((k) => k.startsWith(prefix))
    .map((k) => k.slice(prefix.length))
}

/** 清空某脚本的全部 DL.store 值 */
export async function clearGMValues(uuid: string): Promise<void> {
  const all = await chrome.storage.local.get()
  const prefix = GM_KEY_PREFIX + uuid + ':'
  const keys = Object.keys(all).filter((k) => k.startsWith(prefix))
  if (keys.length) await chrome.storage.local.remove(keys)
}

// —— 错误日志（错误面板）——
//
// 运行期错误经 DL 包装转发到 onUserScriptMessage 后被收集；注册/桥失败在后台直接收集。
// 环形保留最近 N 条，避免无限增长。

const MAX_ERRORS = 50

// us:errors 是「读全量 → 改 → 写回整块」的 RMW，chrome.storage.local 没有原子写。
// 脚本崩溃风暴时多个 append 并发执行会互相覆盖（lost update），必须按 key 串行化。
// 进程内 promise 队列即可：写入方（用户脚本消息转发 / 后台兜底收集）都在本 SW 进程内。
// clear 也排进同一队列——否则清空可能被排在前面的 append 用旧数据写回覆盖。
let errorOpsQueue: Promise<unknown> = Promise.resolve()

function enqueueErrorOp<T>(op: () => Promise<T>): Promise<T> {
  const run = errorOpsQueue.then(op, op)
  // 队列自身永不 reject，否则后续操作全部中断；错误由调用方拿到的 run 承接
  errorOpsQueue = run.catch(() => {})
  return run
}

/** 追加一条错误（自动补 id；time 缺省用当前时间）。并发安全：读改写按队列串行。 */
export async function appendUserScriptError(
  // time 由本函数兜底（rec.time || Date.now()），故对调用方可选
  rec: Omit<UserScriptErrorRecord, 'id' | 'time'> & { id?: string; time?: number },
): Promise<void> {
  return enqueueErrorOp(async () => {
    const existing =
      ((await chrome.storage.local.get(ERRORS_KEY))[ERRORS_KEY] as UserScriptErrorRecord[] | undefined) ?? []
    const next = existing.slice(-(MAX_ERRORS - 1))
    next.push({ ...rec, id: rec.id || crypto.randomUUID(), time: rec.time || Date.now() })
    await chrome.storage.local.set({ [ERRORS_KEY]: next })
  })
}

/** 列出全部错误（最新在前） */
export async function listUserScriptErrors(): Promise<UserScriptErrorRecord[]> {
  const r = (await chrome.storage.local.get(ERRORS_KEY))[ERRORS_KEY] as UserScriptErrorRecord[] | undefined
  return (r ?? []).slice().reverse()
}

/** 清空错误日志（与 append 同队列串行，避免清空被并发写回覆盖） */
export async function clearUserScriptErrors(): Promise<void> {
  return enqueueErrorOp(() => chrome.storage.local.remove(ERRORS_KEY))
}

/**
 * 按 id 查一条错误：精确 id，或至少 8 位的前缀唯一匹配。
 * 前缀下限 8 位：工作台展示的就是前 8 位（复制的是完整 id），前缀太短碰撞概率失控。
 * 多命中 = 前缀不唯一（ambiguous），调用方让用户复制完整 ID，绝不猜。
 */
export type UserScriptErrorLookup =
  | { found: true; record: UserScriptErrorRecord }
  | { found: false; reason: 'not-found' | 'ambiguous' }

export async function findUserScriptError(id: string): Promise<UserScriptErrorLookup> {
  const list = await listUserScriptErrors()
  const exact = list.find((e) => e.id === id)
  if (exact) return { found: true, record: exact }
  if (id.length < 8) return { found: false, reason: 'not-found' }
  const matches = list.filter((e) => e.id.startsWith(id))
  if (matches.length === 1) return { found: true, record: matches[0]! }
  if (matches.length > 1) return { found: false, reason: 'ambiguous' }
  return { found: false, reason: 'not-found' }
}
