// 用户脚本项目数据的**写侧**（⚠️ offscreen 专属，见 state-db.ts 文件头的单写方约定）。
//
// 这里是本方案的落点：源码的唯一权威在 duoling-fs（us-git），状态库（duoling-state）退化为
// 「注册态库」只存 bundle + 元数据。**一切源码落盘都收敛到 saveSource 一个入口**：
// 写工作树 → 提交 git 版本 → 立刻构建 → 写状态库（+ 出口广播由命令面 handleStateCommand 负责）。
//
// 保存语义（2026-09-19 老大拍板）：**保存恒成功，构建跟随**——源码提交即保存，不再以构建
// 成功为落盘前提；构建失败则**产物置空**（bundle=undefined），脚本立即停止注入（旧产物不兜底，
// 刷新目标页后不生效），直到用户改到能构建。构建终态另记 buildOk / lastBuildAt（列表状态标
// 与「失败于何时」用；bundle 有无本身也是同一事实，但失败时没有时间戳可看）。
//
// 失败策略：git 提交失败只丢历史不丢源码？不——duoling-fs 就是源码唯一来源，提交失败时
// 工作树仍持有本次内容，故只 warn（下次保存再提交）；写工作树失败才是真保存失败（源码没落地）。
import { buildProject, BuildError } from './builder'
import { broadcastBuildPhase } from '../data-broadcast'
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
): Promise<BuildRun> {
  try {
    const outcome = await buildProject(files, entry, deps)
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
  await writeSourceTree(uuid, files, meta)
  try {
    await commitSource(uuid, meta, opts.note)
  } catch (e) {
    // 工作树已落地，提交失败只丢历史版本（下次保存会补提交），不判保存失败
    console.warn('[duoling:userscript] git 提交失败（不影响保存）', uuid, e)
  }
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
 * 范围（2026-09-17 老大拍板）：只有新形态用户脚本——状态库项目 + 各自 git 仓。
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
 *  · 构建失败：**仍导入**，产物置空（统一保存语义）；报告 note 带 esbuild 诊断，
 *    用户去编辑器改到能构建。（无产物注册会被 resolveInjectCode 拦下，绝不会注入页面。）
 * 导入默认值：uuid 重生成、enabled 恒 false（先审后启）、保留原名（名字不拦重复，uuid 才是标识）。
 */
export async function importScriptsZip(zipBase64: string): Promise<ImportReport> {
  const parsed = parseScriptsZip(base64ToBytes(zipBase64))
  const results: ImportItemResult[] = []
  for (const script of parsed.scripts) {
    results.push(await importOneScript(script))
  }
  for (const s of parsed.skipped) {
    results.push({ status: 'failed', name: s.dirName, reason: s.reason })
  }
  return {
    succeeded: results.filter((r) => r.status === 'ok').length,
    failed: results.filter((r) => r.status === 'failed').length,
    results,
    ignored: parsed.ignored.map((f) => ({ status: 'ignored' as const, ...f })),
  }
}

/** 导入单个脚本：守卫 + 指纹去重提示 + 统一保存（源码库写失败 = 该条导入失败） */
async function importOneScript(script: ParsedScript): Promise<ImportItemResult> {
  // 解码期的兜底提示（字段缺失已补默认等）先收进来，再叠加构建期提示
  const notes = [...(script.notes ?? [])]
  try {
    // 指纹去重提示：与现有项目（含本批先导入的——逐个落盘后立即可见）比对
    const duplicateOf = await findContentDuplicate(script.entry, script.files)
    const name = script.name.trim() || 'script'
    const ts = Date.now()
    const uuid = crypto.randomUUID()
    const meta: ScriptMeta = { name, config: script.config, entry: script.entry, createdAt: ts }
    const outcome = await saveSource(uuid, script.files, meta, { enabled: false, createdAt: ts, note: '从 zip 导入' })
    if (!outcome.buildOk) {
      notes.push('构建失败（已导入，产物未生成，可在编辑器修复后保存）：' + outcome.issues.join('；'))
    }
    return {
      status: 'ok',
      uuid: outcome.project.uuid,
      name: outcome.project.name,
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
