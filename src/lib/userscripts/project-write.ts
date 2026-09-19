// 用户脚本项目数据的**写侧**（⚠️ offscreen 专属，见 state-db.ts 文件头的单写方约定）。
//
// 这里是本方案的落点：源码的唯一权威在 duoling-fs（us-git），状态库（duoling-state）退化为
// 「注册态库」只存 bundle + 元数据。**一切源码落盘都收敛到 saveSource 一个入口**：
// 写工作树 → 提交 git 版本 → 立刻构建 → 写状态库（+ 出口广播由命令面 handleStateCommand 负责）。
//
// 保存语义（2026-09-19 经评审确认）：**保存恒成功，构建跟随**——源码提交即保存，不再以构建
// 成功为落盘前提；构建失败则**产物置空**（bundle=undefined），脚本立即停止注入（旧产物不兜底，
// 刷新目标页后不生效），直到用户改到能构建。构建终态另记 buildOk / lastBuildAt（列表状态标
// 与「失败于何时」用；bundle 有无本身也是同一事实，但失败时没有时间戳可看）。
//
// 失败策略：git 提交失败只丢历史不丢源码？不——duoling-fs 就是源码唯一来源，提交失败时
// 工作树仍持有本次内容，故只 warn（下次保存再提交）；写工作树失败才是真保存失败（源码没落地）。
import { buildProject, BuildError } from './builder'
import { broadcastBuildPhase, broadcastDataChange } from '../data-broadcast'
import { getProject, listProjects, nextScriptName, validateFiles } from './project-store'
import { removeProject, writeProject } from './state-db'
import { deleteAllRepos, deleteRepo, writeSourceTree, commitSource, readSourceTree } from './us-git'
import { ENTRY_DEFAULT, defaultConfig, defaultSource } from './types'
import type { ImportItemResult, ImportReport, ScriptConfig, ScriptMeta, ScriptProject } from './types'
import { base64ToBytes, filesFingerprint, parseScriptsZip } from './zip-transfer'
import type { ParsedScript } from './zip-transfer'

/** 构造状态库记录（无源码；源码在 duoling-fs） */
function makeState(
  uuid: string,
  name: string,
  enabled: boolean,
  config: ScriptConfig,
  entry: string,
  bundle: { code: string; builtAt: number } | undefined,
  buildOk: boolean,
  lastBuildAt: number,
  fileCount: number,
  createdAt: number,
  updatedAt: number,
): ScriptProject {
  return {
    v: 1,
    uuid,
    name,
    enabled,
    config,
    entry,
    bundle,
    buildOk,
    lastBuildAt,
    fileCount,
    createdAt,
    updatedAt,
  }
}

// —— 构建结果（可辨识联合，不抛异常：构建失败是**正常业务态**，不是错误） ——

export type BuildRun =
  | { ok: true; code: string; files: Record<string, string>; remoteFetched: string[] }
  | { ok: false; issues: string[] }

/** 构建（读内存 Record）；BuildError → { ok:false, issues }，其余异常照抛（IPC/环境问题）。
 *  deps 来自 meta.config.deps（UMD / 资源依赖 URL 列表），交给 builder 内联对齐 */
async function runBuild(
  files: Record<string, string>,
  entry: string,
  deps?: string[],
  opts?: { refreshDeps?: boolean },
): Promise<BuildRun> {
  try {
    const outcome = await buildProject(files, entry, deps, opts)
    return { ok: true, code: outcome.code, files: outcome.files, remoteFetched: outcome.remoteFetched }
  } catch (e) {
    if (e instanceof BuildError) return { ok: false, issues: e.issues }
    throw e
  }
}

/** 保存结果：project = 落库后的注册态记录；buildOk=false 时 issues 为 esbuild 诊断、产物已置空 */
export interface SaveOutcome {
  project: ScriptProject
  buildOk: boolean
  issues: string[]
  /** 构建期拉取并持久化进文件树的远程依赖（构建改写了文件树时非空） */
  remoteFetched: string[]
  /** 最终文件树（构建可能补拉远程依赖改写文件，保存结果以它为准） */
  files: Record<string, string>
}

/** 源码落盘（写工作树 + 提交 git）：saveSource 与导入共用的底层步骤。提交失败只丢历史不丢源码 */
async function persistSource(
  uuid: string,
  files: Record<string, string>,
  meta: ScriptMeta,
  note?: string,
): Promise<void> {
  await writeSourceTree(uuid, files, meta)
  try {
    await commitSource(uuid, meta, note)
  } catch (e) {
    // 工作树已落地，提交失败只丢历史版本（下次保存会补提交），不判保存失败
    console.warn('[duoling:userscript] git 提交失败（不影响保存）', uuid, e)
  }
}

/**
 * **统一保存入口**（全部源码落盘路径都走这里）：写工作树 → 提交 git 版本 → 立刻构建 →
 * 写状态库。保存不依赖构建成功；构建失败产物置空（见文件头语义说明）。
 *
 * 构建可能改写文件树（拉取远程依赖写回）：此时把改写后的文件树再写一遍 + 追加一次提交，
 * 保证历史里的源码 = 状态库的源码 = 构建输入。
 */
export async function saveSource(
  uuid: string,
  files: Record<string, string>,
  meta: ScriptMeta,
  opts: { enabled: boolean; createdAt: number; note?: string },
): Promise<SaveOutcome> {
  await persistSource(uuid, files, meta, opts.note)
  // 进构建前广播瞬态阶段：列表行切「构建中」转圈（写工作树 / git 提交阶段由 SW 的
  // userscript:save 转发侧广播「保存中」覆盖；offscreen 侧广播覆盖新建 / 导入这类不经转发的路径）
  broadcastBuildPhase('script', uuid, 'building')
  const build = await runBuild(files, meta.entry, meta.config.deps)
  let finalFiles = files
  if (build.ok) {
    finalFiles = build.files
    if (build.remoteFetched.length) {
      // 远程依赖已持久化进文件树：再写一遍 + 追加提交，保持三处（工作树/历史/构建输入）一致
      try {
        await writeSourceTree(uuid, build.files, meta)
        await commitSource(uuid, meta, '拉取远程依赖').catch(() => {})
      } catch (e) {
        console.warn('[duoling:userscript] 远程依赖落盘失败（不影响本次保存）', uuid, e)
      }
    }
  }
  const builtAt = Date.now()
  const project = makeState(
    uuid,
    meta.name,
    opts.enabled,
    meta.config,
    meta.entry,
    build.ok ? { code: build.code, builtAt } : undefined, // 构建失败产物置空
    build.ok,
    builtAt,
    Object.keys(finalFiles).length,
    opts.createdAt,
    Date.now(),
  )
  await writeProject(project)
  return {
    project,
    buildOk: build.ok,
    issues: build.ok ? [] : build.issues,
    remoteFetched: build.ok ? build.remoteFetched : [],
    files: finalFiles,
  }
}

/** 新建（零输入）：自动命名 + 初始模板 + 首次保存（模板构建失败也创建，产物置空待修） */
export async function createProject(): Promise<ScriptProject> {
  const name = await nextScriptName()
  const ts = Date.now()
  const uuid = crypto.randomUUID()
  const files = { [ENTRY_DEFAULT]: defaultSource(name) }
  const meta: ScriptMeta = { name, config: defaultConfig(['*://*/*']), entry: ENTRY_DEFAULT, createdAt: ts }
  const outcome = await saveSource(uuid, files, meta, { enabled: true, createdAt: ts })
  return outcome.project
}

/**
 * AI 生成脚本落盘：
 * 收 name / config / files / entry + enabled（默认 false）。
 * **不调用 registerScript**——「生成」与「生效」解耦，AI 产物默认零影响；
 * loop 内已自收敛构建过一次，这里按统一保存语义再构建一次（esbuild 秒级，换入口唯一）；
 * git 提交 note = AI summary（us-git 已支持，正好是提交信息）。
 */
export async function createGeneratedProject(payload: {
  name: string
  config: ScriptConfig
  files: Record<string, string>
  entry: string
  enabled: boolean
  note?: string
}): Promise<ScriptProject> {
  const name = payload.name.trim()
  if (!name) throw new Error('脚本名称不能为空')
  if (!payload.config.matches?.length) throw new Error('匹配规则（matches）至少一条')
  validateFiles(payload.files, payload.entry)
  const ts = Date.now()
  const uuid = crypto.randomUUID()
  const meta: ScriptMeta = { name, config: payload.config, entry: payload.entry, createdAt: ts }
  const outcome = await saveSource(uuid, payload.files, meta, {
    enabled: payload.enabled,
    createdAt: ts,
    note: payload.note,
  })
  return outcome.project
}

/** 编辑器保存 / AI 改既有脚本：读改写守卫（存在性 / 文件树 / 名称 / matches）+ 统一保存 */
export async function saveExisting(
  uuid: string,
  files: Record<string, string>,
  entry: string,
  opts?: { name?: string; config?: ScriptConfig; note?: string },
): Promise<SaveOutcome> {
  const project = await getProject(uuid)
  if (!project) throw new Error('脚本不存在')
  validateFiles(files, entry)
  const name = opts?.name?.trim() ?? project.name
  if (opts?.name !== undefined && !name) throw new Error('脚本名称不能为空')
  const config = opts?.config ?? project.config
  if (opts?.config && !opts.config.matches?.length) throw new Error('匹配规则（matches）至少一条')
  const meta: ScriptMeta = { name, config, entry, createdAt: project.createdAt }
  return saveSource(uuid, files, meta, {
    enabled: project.enabled,
    createdAt: project.createdAt,
    note: opts?.note,
  })
}

/**
 * 删除：状态库记录 + git 仓一起清。
 * 仓的删除原先要靠 offscreen 启动对账（reconcileFs）兜，删完脚本仓会滞留一段时间；
 * 现在写侧同在 offscreen，直接一步清干净。
 */
export async function removeProjectAndRepo(uuid: string): Promise<void> {
  await removeProject(uuid)
  await deleteRepo(uuid).catch((e: unknown) => {
    console.warn('[duoling:userscript] 删除 git 仓失败（脚本记录已删）', uuid, e)
  })
}

/**
 * 删除全部用户脚本（「全部删除」按钮的落点），返回删除条数。
 *
 * 范围（2026-09-17 经评审确认）：只有新形态用户脚本——状态库项目 + 各自 git 仓。
 * **不含**已弃用旧 GM 记录（它在 chrome.storage，另有逐行删除与
 * clearDeprecated 两条清理路径）与内置件（随扩展包分发，不在状态库）。
 *
 * 两步：① 记录逐条 removeProject（与单删同一删除入口）；② 仓整目录清一遍 /uscripts
 * （含无人认领的滞留仓）。不逐条 deleteRepo —— 反正随后整目录也要清，逐条只是重复劳动。
 *
 * 不做整批回滚（跨记录事务做得到但没必要）：中途失败把异常抛给调用方，已删的不复原，
 * 用户重试一次即可（幂等：剩余记录继续删，空库调用返回 0）。
 */
export async function removeAllProjects(): Promise<number> {
  const projects = await listProjects()
  for (const p of projects) await removeProject(p.uuid)
  await deleteAllRepos()
  return projects.length
}

/**
 * 启停：只改 enabled。
 * **不产生提交**——enabled 不入仓（commitSource 刻意排除它，否则每次启停都是一次「假变更」）。
 */
export async function setProjectEnabled(uuid: string, enabled: boolean): Promise<ScriptProject> {
  const project = await getProject(uuid)
  if (!project) throw new Error('脚本不存在')
  project.enabled = enabled
  project.updatedAt = Date.now()
  await writeProject(project)
  return project
}

// —— zip 导入——

/**
 * zip 导入（state:import 的落点）：解码 → 逐脚本**尽量导入**。
 *
 * 导入侧不是「校验 + 淘汰」，而是「尽量落盘 + 报告说明」——
 *  · 解码层已放行版本 / 字段缺失 / 路径不安全（后者只过滤该文件），只剩「无 project.json」跳过；
 *  · matches 非法、文件树非法：不在这里拦（启用时 registerScript 会以中文报错，导入后可在编辑器改）；
 *  · 构建失败：**仍导入**，产物置空（统一保存语义）；失败终态看列表失败标 / 编辑器打开时的诊断。
 * 导入默认值：uuid 重生成、enabled 恒 false（先审后启）、保留原名（名字不拦重复，uuid 才是标识）。
 *
 * **导入 ≠ 构建**（2026-09-19 经评审确认）：导入只落源码 + 占位注册态（lastBuildAt=0 = 从未构建），
 * 构建由后台串行队列静默接力——导入即时返回，不因 esbuild / 依赖拉取卡弹窗。
 */
export async function importScriptsZip(zipBase64: string): Promise<ImportReport> {
  const parsed = parseScriptsZip(base64ToBytes(zipBase64))
  const results: ImportItemResult[] = []
  const queue: PendingBuild[] = []
  for (const script of parsed.scripts) {
    results.push(await importOneScript(script, queue))
  }
  for (const s of parsed.skipped) {
    results.push({ status: 'failed', name: s.dirName, reason: s.reason })
  }
  enqueueBackgroundBuilds(queue)
  return {
    succeeded: results.filter((r) => r.status === 'ok').length,
    failed: results.filter((r) => r.status === 'failed').length,
    results,
    ignored: parsed.ignored.map((f) => ({ status: 'ignored' as const, ...f })),
  }
}

/** 导入单个脚本：守卫 + 指纹去重提示 + 落源码与占位注册态（构建交后台队列，源码库写失败 = 该条导入失败） */
async function importOneScript(script: ParsedScript, queue: PendingBuild[]): Promise<ImportItemResult> {
  // 解码期的兜底提示（字段缺失已补默认等）先收进来；构建期提示不再进报告（构建在后台，报告已返回）
  const notes = [...(script.notes ?? [])]
  try {
    // 指纹去重提示：与现有项目（含本批先导入的——逐个落盘后立即可见）比对
    const duplicateOf = await findContentDuplicate(script.entry, script.files)
    const name = script.name.trim() || 'script'
    const ts = Date.now()
    const uuid = crypto.randomUUID()
    const meta: ScriptMeta = { name, config: script.config, entry: script.entry, createdAt: ts }
    await persistSource(uuid, script.files, meta, '从 zip 导入')
    // 占位注册态：bundle 空 / buildOk=false / **lastBuildAt=0 哨兵**（列表据此显示「构建中」而非「失败」，
    // 启动对账也据此重排被中断的构建）。列表行立即出现，转圈由下面这条 building 瞬态驱动
    await writeProject(
      makeState(uuid, name, false, script.config, script.entry, undefined, false, 0, Object.keys(script.files).length, ts, ts),
    )
    broadcastBuildPhase('script', uuid, 'building')
    queue.push({ uuid, meta, files: script.files })
    return {
      status: 'ok',
      uuid,
      name,
      // duplicateOf / notes 仅在命中时出现（报告形状稳定，调用方不用判 undefined key）
      ...(duplicateOf ? { duplicateOf } : {}),
      ...(notes.length ? { notes } : {}),
    }
  } catch (e) {
    return {
      status: 'failed',
      name: script.name,
      reason: e instanceof Error ? e.message : String(e),
    }
  }
}

/** 内容指纹比对：返回内容相同的现有脚本名（无则 undefined）。比对成本 = O(库内脚本数)，可接受 */
async function findContentDuplicate(entry: string, files: Record<string, string>): Promise<string | undefined> {
  const fingerprint = await filesFingerprint(entry, files)
  for (const p of await listProjects()) {
    const tree = await readSourceTree(p.uuid).catch(() => null)
    if (tree && (await filesFingerprint(tree.meta.entry, tree.files)) === fingerprint) {
      return p.name
    }
  }
  return undefined
}

// —— 导入后台构建队列（2026-09-19 经评审确认：导入只落源码，构建静默后台）——

/** 一条待后台构建的任务：导入时登记，构建输入在真正执行时再从工作树现读 */
interface PendingBuild {
  uuid: string
  meta: ScriptMeta
  /** 导入时的源码快照：仅作工作树读不到时的兜底 */
  files: Record<string, string>
}

// 串行链：esbuild-wasm 同进程本就该逐个跑；链式还保证两次导入的队列不交错构建
let pendingBuildChain: Promise<void> = Promise.resolve()

/** 把一批导入任务挂到后台构建链尾（fire-and-forget：导入报告不等构建） */
function enqueueBackgroundBuilds(items: PendingBuild[]): void {
  for (const item of items) {
    pendingBuildChain = pendingBuildChain.then(() => buildInBackground(item))
  }
}

/** 构建单条导入任务：与 saveSource 的构建段同语义（失败产物置空），只是时机在后台 */
async function buildInBackground(item: PendingBuild): Promise<void> {
  try {
    broadcastBuildPhase('script', item.uuid, 'building')
    // 构建输入取**当前工作树**（导入到真正构建之间用户可能已在编辑器改过源码），读不到再用导入快照兜底
    const tree = await readSourceTree(item.uuid).catch(() => null)
    const files = tree?.files ?? item.files
    const build = await runBuild(files, item.meta.entry, item.meta.config.deps)
    let finalFiles = files
    if (build.ok) {
      finalFiles = build.files
      if (build.remoteFetched.length) {
        // 远程依赖已持久化进文件树：再写一遍 + 追加提交，保持三处（工作树/历史/构建输入）一致
        try {
          await writeSourceTree(item.uuid, build.files, item.meta)
          await commitSource(item.uuid, item.meta, '拉取远程依赖').catch(() => {})
        } catch (e) {
          console.warn('[duoling:userscript] 远程依赖落盘失败（不影响后台构建）', item.uuid, e)
        }
      }
    }
    const builtAt = Date.now()
    await writeProject(
      makeState(
        item.uuid,
        item.meta.name,
        false,
        item.meta.config,
        item.meta.entry,
        build.ok ? { code: build.code, builtAt } : undefined, // 构建失败产物置空
        build.ok,
        builtAt,
        Object.keys(finalFiles).length,
        item.meta.createdAt,
        builtAt,
      ),
    )
    // 出口广播：这条链路不经命令面（handleStateCommand 不管后台任务），自己发数据变更让列表拉终态
    broadcastDataChange('script', item.uuid)
  } catch (e) {
    // 单条失败不拦队列；状态停在「从未构建」，下次 offscreen 启动对账（rebuildPendingProjects）重排
    console.warn('[duoling:userscript] 导入后台构建失败', item.uuid, e)
  }
}

/**
 * 启动对账（offscreen 启动时调）：把「从未完成过构建」的脚本重新排队——
 * lastBuildAt=0 只会出现在导入占位态，出现即说明后台构建没跑完（offscreen 被杀 / 扩展重载）。
 * 源码读不到的（仓损坏 / 已被清）跳过，留着不动。
 */
export async function rebuildPendingProjects(): Promise<number> {
  let projects: ScriptProject[]
  try {
    projects = await listProjects()
  } catch (e) {
    // 启动对账失败不阻断（幂等，下次启动再试）
    console.warn('[duoling:userscript] 待构建对账失败（下次启动重试）', e)
    return 0
  }
  const items: PendingBuild[] = []
  for (const p of projects) {
    if (p.lastBuildAt !== 0) continue
    const tree = await readSourceTree(p.uuid).catch(() => null)
    if (!tree) continue
    items.push({ uuid: p.uuid, meta: tree.meta, files: tree.files })
  }
  enqueueBackgroundBuilds(items)
  return items.length
}

// —— 依赖缓存管理（2026-09-19 经评审确认：清缓存 / 刷缓存两个动作分开）——

/** 刷新依赖缓存的返回：ok=false 时缓存原封未动，issues 带失败的 URL */
export type DepsRefreshOutcome = { ok: true; refreshed: string[] } | { ok: false; issues: string[] }

/**
 * 刷新依赖缓存（「刷缓存」按钮）：无视缓存全量重拉，**全部成功**才落盘替换 + 重建重注册态；
 * 任一拉取失败 → 什么都不写（旧缓存原封不动），issues 带失败 URL 让 UI 提示。
 * 操作对象是**已保存的工作树**（不经编辑器内存态）；构建失败同样视为刷新失败（缓存未动）。
 */
export async function refreshDepsCache(uuid: string): Promise<DepsRefreshOutcome> {
  const project = await getProject(uuid)
  if (!project) throw new Error('脚本不存在')
  const tree = await readSourceTree(uuid)
  if (!tree) throw new Error('源码树不可读（duoling-fs 仓缺失或损坏）')
  const build = await runBuild(tree.files, tree.meta.entry, tree.meta.config.deps, { refreshDeps: true })
  if (!build.ok) return { ok: false, issues: build.issues }
  // 全部拉取成功：落盘新依赖 + 提交 + 状态库重建 + 广播（写侧不经命令面的部分自己广播）
  await writeSourceTree(uuid, build.files, tree.meta)
  await commitSource(uuid, tree.meta, '刷新依赖缓存').catch(() => {})
  const builtAt = Date.now()
  await writeProject(
    makeState(
      uuid,
      project.name,
      project.enabled,
      project.config,
      tree.meta.entry,
      { code: build.code, builtAt },
      true,
      builtAt,
      Object.keys(build.files).length,
      project.createdAt,
      builtAt,
    ),
  )
  broadcastDataChange('script', uuid)
  return { ok: true, refreshed: build.remoteFetched }
}

/**
 * 清依赖缓存（「清缓存」按钮）：只删 `_deps/`，**不拉取、不重建**——bundle 原样保留
 * （脚本继续跑旧产物），下次任何构建（保存 / 导入 / 刷新）自然冷拉。
 */
export async function clearDepsCache(uuid: string): Promise<{ cleared: number }> {
  const project = await getProject(uuid)
  if (!project) throw new Error('脚本不存在')
  const tree = await readSourceTree(uuid)
  if (!tree) throw new Error('源码树不可读（duoling-fs 仓缺失或损坏）')
  const kept = Object.fromEntries(Object.entries(tree.files).filter(([f]) => !f.startsWith('_deps/')))
  const cleared = Object.keys(tree.files).length - Object.keys(kept).length
  if (!cleared) return { cleared: 0 }
  await writeSourceTree(uuid, kept, tree.meta)
  await commitSource(uuid, tree.meta, '清依赖缓存').catch(() => {})
  await writeProject({ ...project, fileCount: Object.keys(kept).length, updatedAt: Date.now() })
  broadcastDataChange('script', uuid)
  return { cleared }
}
