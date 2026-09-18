// 用户脚本项目数据的**写侧**（⚠️ offscreen 专属，见 state-db.ts 文件头的单写方约定）。
//
// 这里是本方案的落点：
// 原先一次保存是「SW 写 chrome.storage」+「IPC 让 offscreen commit git 仓」两次分离操作、
// 两个写方，任一步失败就产生「已保存但没 commit」的偏差。
// 现在状态库与 git 仓都在 offscreen 本地，写状态与 commit 收进同一个函数、同一个上下文里：
// 先落状态、紧接着快照提交，**不再有跨上下文的缝隙**。
//
// 失败策略不变：commit 失败只丢历史不丢脚本（仓损坏可重建，状态库是权威），故快照异常只 warn。
//
// 2026-09-15 产物不变量（老大拍板：SW 只注册最终产物）：bundle 是注册的**必要条件**——
// 新建在本模块内先构建（同在 offscreen，直接调 builder，零新链路），构建失败即创建失败；
// updateProjectFiles 的 bundle 参数为必填（UI 只在构建成功后才调保存）。不存在「无产物被注册」的路径。
// 同日粘贴安装（installProject 及整条协议链）移除：产品上不再提供「粘贴源码装脚本」入口。
import { buildProject, BuildError } from './builder'
import { getProject, listProjects, nextScriptName, validateFiles } from './project-store'
import { removeProject, writeProject } from './state-db'
import { deleteAllRepos, deleteRepo, snapshotProject } from './us-git'
import { ENTRY_DEFAULT, defaultConfig, defaultSource } from './types'
import type { ImportItemResult, ImportReport, ScriptConfig, ScriptProject } from './types'
import { base64ToBytes, filesFingerprint, parseScriptsZip } from './zip-transfer'
import type { ParsedScript } from './zip-transfer'

function nowProject(name: string, files: Record<string, string>, config: ScriptConfig): ScriptProject {
  const ts = Date.now()
  return {
    v: 1,
    uuid: crypto.randomUUID(),
    name,
    // 新建即启用（2026-09-14 老大拍板）；初始模板先构建出产物才落盘，注册有产物可注入
    enabled: true,
    config,
    files,
    entry: ENTRY_DEFAULT,
    createdAt: ts,
    updatedAt: ts,
  }
}

/** 构建并返回产物（bundle 必存在，注册的前置条件）；BuildError 格式化为可读多行错误 */
async function buildOutcome(files: Record<string, string>, entry: string): Promise<{ code: string; builtAt: number }> {
  try {
    const outcome = await buildProject(files, entry)
    return { code: outcome.code, builtAt: Date.now() }
  } catch (e) {
    if (e instanceof BuildError) throw new Error('构建失败：\n' + e.issues.join('\n'))
    throw e
  }
}

/** 落状态 + 快照提交（首次即建仓）；快照失败只 warn，不阻断写入 */
async function writeAndSnapshot(project: ScriptProject, note?: string): Promise<void> {
  await writeProject(project)
  try {
    await snapshotProject(project, note)
  } catch (e) {
    console.warn('[duoling:userscript] 历史快照失败（不影响保存）', project.uuid, e)
  }
}

/** 新建（零输入）：自动命名 + 初始模板 + **先构建出产物再落盘**（构建失败即创建失败） */
export async function createProject(): Promise<ScriptProject> {
  const name = await nextScriptName()
  const project = nowProject(name, { [ENTRY_DEFAULT]: defaultSource(name) }, defaultConfig(['*://*/*']))
  project.bundle = await buildOutcome(project.files, project.entry)
  await writeAndSnapshot(project)
  return project
}

/**
 * AI 生成脚本落盘：
 * 收 name / config / files / entry / bundle（必填，构建已在 loop 内收敛通过）+ enabled（默认 false）。
 * **不调用 registerScript**——「生成」与「生效」解耦，AI 产物默认零影响；
 * git 快照 note = AI summary（us-git 已支持，正好是提交信息）。
 */
export async function createGeneratedProject(payload: {
  name: string
  config: ScriptConfig
  files: Record<string, string>
  entry: string
  bundle: { code: string; builtAt: number }
  enabled: boolean
  note?: string
}): Promise<ScriptProject> {
  const name = payload.name.trim()
  if (!name) throw new Error('脚本名称不能为空')
  if (!payload.config.matches?.length) throw new Error('匹配规则（matches）至少一条')
  validateFiles(payload.files, payload.entry)
  const ts = Date.now()
  const project: ScriptProject = {
    v: 1,
    uuid: crypto.randomUUID(),
    name,
    enabled: payload.enabled,
    config: payload.config,
    files: payload.files,
    entry: payload.entry,
    bundle: payload.bundle,
    createdAt: ts,
    updatedAt: ts,
  }
  await writeAndSnapshot(project, payload.note)
  return project
}

/** 更新文件树 + 入口 + 名称/配置 + 构建产物（读改写在同一处，不跨上下文）。
 *  bundle **必填**：调用方（编辑器保存 / 历史恢复）必须在构建成功后才能走到这里 */
export async function updateProjectFiles(
  uuid: string,
  files: Record<string, string>,
  entry: string,
  bundle: { code: string; builtAt: number },
  opts?: { name?: string; config?: ScriptConfig; note?: string },
): Promise<ScriptProject> {
  const project = await getProject(uuid)
  if (!project) throw new Error('脚本不存在')
  validateFiles(files, entry)
  project.files = files
  project.entry = entry
  project.bundle = bundle
  if (opts?.name !== undefined) {
    const name = opts.name.trim()
    if (!name) throw new Error('脚本名称不能为空')
    project.name = name
  }
  if (opts?.config) {
    if (!opts.config.matches?.length) throw new Error('匹配规则（matches）至少一条')
    project.config = opts.config
  }
  project.updatedAt = Date.now()
  await writeAndSnapshot(project, opts?.note)
  return project
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
 * **不含**已弃用旧 GM 记录（它在 chrome.storage，不是项目形态，另有逐行删除与
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
 * **不产生提交**——enabled 不入仓（buildContents 刻意排除它，否则每次启停都是一次「假变更」）。
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
 * 2026-09-17 语义修订（老大拍板「不是原则项的阻断，尽量导入脚本，剩余走编辑器修」）：
 * 导入侧不再是「校验 + 淘汰」，而是「尽量落盘 + 报告说明」——
 *  · 解码层已放行版本 / 字段缺失 / 路径不安全（后者只过滤该文件），只剩「无 project.json」跳过；
 *  · matches 非法、文件树非法：不在这里拦（启用时 registerScript 会以中文报错，导入后可在编辑器改）；
 *  · 构建失败：**仍导入**，只是不写 bundle；报告 note 带 esbuild 诊断，用户去编辑器改到能构建。
 *    （无产物注册会被 resolveInjectCode 拦下并记 register 警告，绝不会把未构建源码注入页面。）
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

/**
 * 导入单个脚本：只做「尽量落盘」，非原则项一律不淘汰它。
 *
 * 落盘顺序（2026-09-17 拍板「先写 lfs」）：
 *   ① 构建（buildOutcome，已有流程，读内存 Record）—— 成功即带产物落盘；**失败不淘汰**，
 *      只记 note 并以「无 bundle」落盘，等用户在编辑器修好重建产物；
 *   ② 先写 lfs（snapshotProject）：把真实文件树物化进 lfs 工作树 + 首提交，作为导入
 *      **首要落点**，早于状态库；lfs 写入失败只 warn 不阻断状态库落盘（仓坏只丢历史
 *      不丢脚本的不变量保留）；
 *   ③ 再写状态库（state-DB 仍为权威：SW 注册读 bundle、编辑器基准读 files 均不变）。
 * 构建不必读 lfs（builder 仍收内存 Record），故 lfs 写入对构建无依赖，仅表达落盘优先级。
 */
async function importOneScript(script: ParsedScript): Promise<ImportItemResult> {
  // 解码期的兜底提示（字段缺失已补默认等）先收进来，再叠加构建期提示
  const notes = [...(script.notes ?? [])]
  try {
    // 指纹去重提示：与现有项目（含本批先导入的——逐个落盘后立即可见）比对
    const duplicateOf = await findContentDuplicate(script.entry, script.files)
    let bundle: { code: string; builtAt: number } | undefined
    try {
      bundle = await buildOutcome(script.files, script.entry) // ① 已有构建流程（读内存 Record）
    } catch (e) {
      notes.push(
        '构建失败（已导入，可在编辑器修复后保存）：' + (e instanceof Error ? e.message : String(e)),
      )
    }
    const name = script.name.trim() || 'script'
    const ts = Date.now()
    const project: ScriptProject = {
      v: 1,
      uuid: crypto.randomUUID(),
      name,
      enabled: false, // 先审后启
      config: script.config,
      files: script.files,
      entry: script.entry,
      // 构建失败的脚本也导入：只留 files/entry，bundle 缺省（可注册性由启用时的报错兜底）
      ...(bundle ? { bundle } : {}),
      createdAt: ts,
      updatedAt: ts,
    }
    // ② 先写 lfs（导入首要目标）：真实文件树物化进 lfs 工作树 + 首提交，早于状态库
    try {
      await snapshotProject(project, '从 zip 导入')
    } catch (e) {
      console.warn('[duoling:userscript] 导入快照失败（不影响状态库落盘）', project.uuid, e)
    }
    // ③ 再写状态库（权威仍 state-DB）
    await writeProject(project)
    return {
      status: 'ok',
      uuid: project.uuid,
      name: project.name,
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
    if ((await filesFingerprint(p.entry, p.files)) === fingerprint) {
      return p.name
    }
  }
  return undefined
}
