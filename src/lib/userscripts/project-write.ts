// 用户脚本项目数据的**写侧**（⚠️ offscreen 专属，见 state-db.ts 文件头的单写方约定）。
//
// 这里是本方案（docs/userscript-single-writer.md）的落点：
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
import { getProject, listProjects, nextScriptName, validateFiles, validateMatchPatterns } from './project-store'
import { removeProject, writeProject } from './state-db'
import { deleteRepo, snapshotProject } from './us-git'
import { ENTRY_DEFAULT, defaultConfig, defaultSource } from './types'
import type { ImportItemResult, ImportReport, ScriptConfig, ScriptProject } from './types'
import { base64ToBytes, filesFingerprint, parseScriptsZip } from './zip-transfer'
import type { ZipScriptPayload } from './zip-transfer'

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
 * AI 生成脚本落盘（docs/userscript-ai-generation.md「生成结果行为」）：
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

// —— zip 导入（docs/userscript-zip-transfer.md §5）——

/**
 * zip 导入（state:import 的落点）：解码 → 解析 → 逐脚本独立容错导入。
 *
 * 与 createProject 同构的「先构建后落盘」不变量：每个脚本先构建出产物再落库，
 * 构建失败（语法错 / TS 报错 / 远程依赖拉不到）只跳过该脚本，成功的照常落盘（§5.7），
 * 报告给 esbuild 的 `文件:行:列`。导入默认值（§5.5）：uuid 重生成（createGeneratedProject
 * 内 crypto.randomUUID）、enabled 恒 false（先审后启）、保留原名（2026-09-17 拍板：名字
 * 不拦重复，uuid 才是标识）。解码与解析安全（zip slip 等）在 zip-transfer.parseScriptsZip，
 * 这里的 validateFiles / validateMatchPatterns 是落盘前的第二道闸。
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
  }
}

/**
 * 导入单个脚本：任一步失败只淘汰它自己（逐脚本独立容错），错误转成报告条目。
 *
 * 落盘顺序（2026-09-17 拍板「先写 lfs」）：
 *   ① 构建（buildOutcome，已有流程，读内存 Record）—— 产物不变量前置，构建失败
 *      即整脚本失败，此时 lfs / 状态库都不碰（不破坏「构建失败不落盘」）；
 *   ② 先写 lfs（snapshotProject）：把真实文件树物化进 lfs 工作树 + 首提交，作为导入
 *      **首要落点**，早于状态库；lfs 写入失败只 warn 不阻断状态库落盘（仓坏只丢历史
 *      不丢脚本的不变量保留）；
 *   ③ 再写状态库（state-DB 仍为权威：SW 注册读 bundle、编辑器基准读 files 均不变）。
 * 构建不必读 lfs（builder 仍收内存 Record），故 lfs 写入对构建无依赖，仅表达落盘优先级。
 */
async function importOneScript(script: ZipScriptPayload): Promise<ImportItemResult> {
  try {
    validateMatchPatterns(script.config)
    validateFiles(script.files, script.entry)
    // 指纹去重提示（§5.6）：与现有项目（含本批先导入的——逐个落盘后立即可见）比对
    const duplicateOf = await findContentDuplicate(script.entry, script.files)
    const bundle = await buildOutcome(script.files, script.entry) // ① 已有构建流程（读内存 Record）
    const name = script.name.trim()
    if (!name) throw new Error('脚本名称不能为空')
    const ts = Date.now()
    const project: ScriptProject = {
      v: 1,
      uuid: crypto.randomUUID(),
      name,
      enabled: false, // 先审后启
      config: script.config,
      files: script.files,
      entry: script.entry,
      bundle,
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
      // duplicateOf 仅在命中时出现（报告形状稳定，调用方不用判 undefined key）
      ...(duplicateOf ? { duplicateOf } : {}),
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
