// 用户脚本项目数据的**写侧**（⚠️ offscreen 专属，见 state-db.ts 文件头的单写方约定）。
//
// 这里是本方案的落点：源码的唯一权威在 duoling-fs（us-git），状态库（duoling-state）退化为
// 「注册态库」只存元数据 + 源码搬运副本。**一切源码落盘都收敛到 saveSource 一个入口**：
// 写工作树 → 提交 git 版本 → 写状态库（+ 出口广播由命令面 handleStateCommand 负责）。
//
// 保存语义（2026-09-20 单文件化）：**保存恒成功、保存即注入**——无构建流程，源码原文随落盘
// 写入注册态（SW 读不到 lfs，注册的注入代码从注册态取）。语法错误不拦保存：坏了的脚本照样
// 装（油猴同款），运行期报错走现成的错误日志 / 运行日志链路。
//
// 失败策略：git 提交失败只丢历史不丢源码——duoling-fs 就是源码唯一来源，提交失败时
// 工作树仍持有本次内容，故只 warn（下次保存再提交）；写工作树失败才是真保存失败（源码没落地）。
import { getProject, listGroups, listProjects, nextScriptName } from './project-store'
import { readGroup, removeGroup, removeProject, writeGroup, writeProject } from './state-db'
import { deleteAllRepos, deleteRepo, writeSource, commitSource, readSource } from './us-git'
import { defaultConfig, defaultSource } from './types'
import type {
  CommitActor,
  ImportItemResult,
  ImportReport,
  ScriptConfig,
  ScriptGroup,
  ScriptProject
} from './types'
import { base64ToBytes, parseScriptsZip, sourceFingerprint } from './zip-transfer'
// metadata 归一化（唯一路径：写入口 saveSource 调用一次，不再另写第二套）
import { resolveConfigFromSource } from './metadata'

/** 构造状态库记录（无源码权威；源码在 duoling-fs，这里只带搬运副本） */
function makeState(
  uuid: string,
  name: string,
  enabled: boolean,
  config: ScriptConfig,
  group: string,
  code: string,
  savedAt: number,
  createdAt: number,
  updatedAt: number,
): ScriptProject {
  return {
    v: 2,
    uuid,
    name,
    enabled,
    config,
    group,
    source: { code, savedAt },
    createdAt,
    updatedAt,
  }
}

/** 保存结果：project = 落库后的注册态记录；notes = metadata 解析提示（须经 warnings 通道给用户看） */
export interface SaveOutcome {
  project: ScriptProject
  notes: string[]
}

/** 源码落盘（写工作树 + 提交 git）：saveSource 与导入共用的底层步骤。提交失败只丢历史不丢源码 */
async function persistSource(
  uuid: string,
  code: string,
  note?: string,
  actor: CommitActor = 'user',
): Promise<void> {
  await writeSource(uuid, code)
  try {
    await commitSource(uuid, note, actor)
  } catch (e) {
    // 工作树已落地，提交失败只丢历史版本（下次保存会补提交），不判保存失败
    console.warn('[duoling:userscript] git 提交失败（不影响保存）', uuid, e)
  }
}

/**
 * **统一保存入口**（全部源码落盘路径都走这里）：写工作树 → 提交 git 版本 → 写状态库。
 * 保存恒成功、保存即注入（源码原文进注册态，无构建流程）。
 *
 * **metadata 归一化就在这一处做**：源码里的 `// ==UserScript==` 块是**输入**，
 * `config` 是此后唯一的运行期事实源（不回写源码）。逐字段「metadata 声明了就采用、没声明才沿用
 * 调用方给的 config」—— 因为全部落盘路径（编辑器保存 / 新建 / AI 生成 / zip 导入）都收敛到这里，
 * 只需一处即无遗漏。改了这里不会漏掉某条写路径。
 *
 * `opts.adoptName`：新建 / 导入采用源码声明的 `@name`（用户尚无命名意图）；
 * 编辑器保存**不采用**（用户在界面上起的名字不该每次保存被改回去），此时 `@name` 只进 `GM_info`。
 */
export async function saveSource(
  uuid: string,
  code: string,
  opts: {
    /** 脚本名（界面/调用方给的）；adoptName=true 且源码声明了 @name 时以 @name 覆盖 */
    name: string
    /** 兜底配置：源码无 metadata 块时沿用（新建默认全站、AI 生成用其给定 config、编辑器保存沿用现有 config） */
    config: ScriptConfig
    enabled: boolean
    createdAt: number
    note?: string
    group?: string
    adoptName?: boolean
    /** 本次改动来源（默认 user）；AI 落盘显式传 'ai' —— 历史面板据此显示来源标签 */
    actor?: CommitActor
  },
): Promise<SaveOutcome> {
  const resolved = resolveConfigFromSource(code, opts.config)
  const name = (opts.adoptName && resolved.name?.trim()) || opts.name
  await persistSource(uuid, code, opts.note, opts.actor)
  const savedAt = Date.now()
  const project = makeState(
    uuid,
    name,
    opts.enabled,
    resolved.config,
    opts.group ?? '',
    code,
    savedAt,
    opts.createdAt,
    savedAt,
  )
  await writeProject(project)
  return { project, notes: resolved.notes }
}

/** 新建（零输入）：自动命名 + 初始模板 + 首次保存 */
export async function createProject(): Promise<ScriptProject> {
  const name = await nextScriptName()
  const ts = Date.now()
  const uuid = crypto.randomUUID()
  const outcome = await saveSource(uuid, defaultSource(), {
    name,
    config: defaultConfig(['*://*/*']),
    enabled: true,
    createdAt: ts,
    adoptName: true,
    // 这条不是「保存」来的（用户还没动过它），给个说得通的名字，别让它长成「保存 <时间>」
    note: '初始版本',
  })
  return outcome.project
}

/**
 * AI 生成脚本落盘：
 * 收 name / config / code + enabled（默认 false）。
 * **不调用 vmInstallScript**——「生成」与「生效」解耦，AI 产物默认零影响；
 * git 提交 note = AI summary（us-git 已支持，正好是提交信息）。
 */
export async function createGeneratedProject(payload: {
  name: string
  config: ScriptConfig
  code: string
  enabled: boolean
  note?: string
}): Promise<ScriptProject> {
  const name = payload.name.trim()
  if (!name) throw new Error('脚本名称不能为空')
  // code 类型守卫必须置于解析之前：resolveConfigFromSource 内部 parseUserScriptMetadata 会
  // 对 code 做 .split，code 非字符串（如 undefined）会先崩在内部，到不了下面的中文报错。
  if (typeof payload.code !== 'string') throw new Error('脚本源码必须是字符串')
  // matches 可来自调用方给定的 config，也可来自源码的 @match 块：先归一化一次再校验，
  // 避免「config 缺省但源码带了 @match」被误判为无匹配（resolveConfigFromSource 以源码为准）。
  // config 缺省时交给源码归一化（applyMetadataToConfig 对 fallback 全程 ?? 兜底，不会崩）。
  const resolvedConfig = resolveConfigFromSource(payload.code, payload.config).config
  if (!resolvedConfig.matches.length) throw new Error('匹配规则（matches）至少一条')
  const ts = Date.now()
  const uuid = crypto.randomUUID()
  const outcome = await saveSource(uuid, payload.code, {
    name,
    config: payload.config,
    enabled: payload.enabled,
    createdAt: ts,
    note: payload.note,
    // AI 产物同样可能自带 metadata 块：新建语义 → 采用其中的 @name / @match
    adoptName: true,
    actor: 'ai',
  })
  return outcome.project
}

/** 编辑器保存 / AI 改既有脚本：读改写守卫（存在性 / 名称 / matches）+ 统一保存 */
export async function saveExisting(
  uuid: string,
  code: string,
  opts?: { name?: string; config?: ScriptConfig; note?: string; actor?: CommitActor },
): Promise<SaveOutcome> {
  const project = await getProject(uuid)
  if (!project) throw new Error('脚本不存在')
  if (typeof code !== 'string') throw new Error('脚本源码必须是字符串')
  const name = opts?.name?.trim() ?? project.name
  if (opts?.name !== undefined && !name) throw new Error('脚本名称不能为空')
  const config = opts?.config ?? project.config
  if (opts?.config && !opts.config.matches?.length) throw new Error('匹配规则（matches）至少一条')
  return saveSource(uuid, code, {
    name,
    config,
    enabled: project.enabled,
    createdAt: project.createdAt,
    note: opts?.note,
    actor: opts?.actor,
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
 * 范围（2026-09-17 经评审确认）：只有用户脚本——状态库项目 + 各自 git 仓。
 * 不含内置件（随扩展包分发，不在状态库）。
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

/**
 * 重命名脚本：只改状态库里的 name + updatedAt。
 *
 * 名字是**管理面标识**（列表 / 标签页 / GM_info / 错误日志分组名都用它），不入 git 仓——
 * 仓里的名字是源码的 `// @name`，两者互不覆盖：这里改名不动源码，改源码的 `@name`
 * 也不会覆盖这里的名字（见 saveSource 的 adoptName 说明）。故与启停、归组一样不产生提交。
 */
export async function renameProject(uuid: string, name: string): Promise<ScriptProject> {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('脚本名不能为空')
  const project = await getProject(uuid)
  if (!project) throw new Error('脚本不存在')
  project.name = trimmed
  project.updatedAt = Date.now()
  await writeProject(project)
  return project
}

// —— 导入（zip / 粘贴）——

/**
 * zip 导入（state:import 的落点）：解码 → 逐脚本**尽量导入**。
 *
 * 导入侧不是「校验 + 淘汰」，而是「尽量落盘 + 报告说明」——
 *  · 解码层配置由源码里的 `// ==UserScript==` 块派生（无块按默认配置），只剩「缺 script.js 源码文件」跳过；
 *  · matches 非法：不在这里拦（启用时 vmInstallScript 会以中文报错，导入后可在编辑器改）。
 * 导入默认值：uuid 重生成、enabled 恒 false（先审后启）、保留原名（名字不拦重复，uuid 才是标识）。
 */
export async function importScriptsZip(zipBase64: string): Promise<ImportReport> {
  const parsed = parseScriptsZip(base64ToBytes(zipBase64))
  const results: ImportItemResult[] = []
  for (const script of parsed.scripts) {
    results.push(await importOneScript(script, '从 zip 导入'))
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
 * 粘贴导入（state:import-text 的落点）：把一段脚本源码落成一个脚本。
 *
 * 与 zip 导入**同一条落盘路径**（importOneScript），语义也照抄：尽量导入、报告说明、
 * uuid 重生成、enabled 恒 false（先审后启）、指纹去重提示照给。
 * 两处差异都来自「没有 zip 容器」：① 无解码期 notes；② 源码没声明 `@name` 时用自动编号名
 * （zip 那边用目录名兜底）—— 故此处先取名再交给 importOneScript 的 name 字段。
 * 匹配规则兜底为空数组：没写 `@match` 就落「不匹配任何页面」，由报告里的提示指引用户补，
 * 不替他放宽成全域。
 */
export async function importScriptFromText(code: string): Promise<ImportReport> {
  if (!code.trim()) {
    return {
      succeeded: 0,
      failed: 1,
      results: [{ status: 'failed', name: '粘贴的脚本', reason: '没有可导入的内容' }],
      ignored: [],
    }
  }
  const result = await importOneScript(
    { name: await nextScriptName('粘贴的脚本'), config: defaultConfig([]), code },
    '粘贴导入',
  )
  return {
    succeeded: result.status === 'ok' ? 1 : 0,
    failed: result.status === 'ok' ? 0 : 1,
    results: [result],
    ignored: [],
  }
}

/**
 * 导入单个脚本：守卫 + 指纹去重提示 + 落源码与注册态（源码库写失败 = 该条导入失败）。
 *
 * `note` = git 提交信息，点明这一批脚本从哪条入口进来（zip / 粘贴）。两条入口的落盘语义完全一致，
 * 差别只在这句提交说明与上游「怎么拿到内容」，故共用本函数、不另写一套。
 */
async function importOneScript(
  script: { name: string; config: ScriptConfig; code: string; notes?: string[] },
  note: string,
): Promise<ImportItemResult> {
  // 解码期的兜底提示（字段缺失已补默认等）先收进来
  const notes = [...(script.notes ?? [])]
  try {
    // 指纹去重提示：与现有项目（含本批先导入的——逐个落盘后立即可见）比对
    const duplicateOf = await findContentDuplicate(script.code)
    // metadata 归一化走**与保存同一套**路径（同一函数，不新写第二套）；导入是「新建」语义 → 采用 @name
    const resolved = resolveConfigFromSource(script.code, script.config)
    const name = (resolved.name?.trim() || script.name.trim() || 'script').trim()
    notes.push(...resolved.notes)
    // 没匹配规则 = 装上了也永不注入。两条导入入口都可能是这情形（外部脚本没写 @match），
    // 提示一句，别让用户把「导入成功」当成「已经在跑」。
    if (!resolved.config.matches.length) {
      notes.push('未声明匹配规则，脚本不会注入任何页面：进编辑器补 @match 再启用')
    }
    const ts = Date.now()
    const uuid = crypto.randomUUID()
    await persistSource(uuid, script.code, note)
    await writeProject(makeState(uuid, name, false, resolved.config, '', script.code, ts, ts, ts))
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
async function findContentDuplicate(code: string): Promise<string | undefined> {
  const fingerprint = await sourceFingerprint(code)
  for (const p of await listProjects()) {
    const source = await readSource(p.uuid).catch(() => null)
    if (source && (await sourceFingerprint(source.code)) === fingerprint) {
      return p.name
    }
  }
  return undefined
}

// —— 分组管理（脚本列表分组功能；全部为 offscreen 单写方，落库后由命令面广播 group 域） ——

/**
 * 新建分组：自动生成 id + order（现有最大 order + 1，空库从 0 起）。
 * 返回建好的分组记录供 UI 直接用（无需回拉）。
 */
export async function createGroup(name: string): Promise<ScriptGroup> {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('分组名不能为空')
  const existing = await listGroups()
  const order =
    existing.length === 0 ? 0 : Math.max(...existing.map((g) => g.order)) + 1
  const group: ScriptGroup = { id: crypto.randomUUID(), name: trimmed, order }
  await writeGroup(group)
  return group
}

/** 重命名分组（仅改展示名；脚本只持有 id，不受影响） */
export async function renameGroup(id: string, name: string): Promise<ScriptGroup> {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('分组名不能为空')
  const group = await readGroupSafe(id)
  if (!group) throw new Error('分组不存在')
  group.name = trimmed
  await writeGroup(group)
  return group
}

/**
 * 删除分组：先把所有引用该分组的脚本退回未分组（同事务逐条改 group 字段），
 * 再删分组定义——脚本不会悬空在「已删分组」下（UI 对查不到定义的 id 按未分组渲染，
 * 但这里主动归位更稳，避免遗留脏引用）。分组不存在直接 no-op。
 */
export async function removeGroupAndReassign(id: string): Promise<void> {
  const group = await readGroupSafe(id, { silent: true })
  if (!group) return
  const projects = await listProjects()
  const ts = Date.now()
  for (const p of projects) {
    if (p.group === id) {
      p.group = ''
      p.updatedAt = ts
      await writeProject(p)
    }
  }
  await removeGroup(id)
}

/** 重排分组顺序：orderedIds 为全部分组 id 的目标顺序，按索引设 order */
export async function reorderGroups(orderedIds: string[]): Promise<void> {
  const groups = await listGroups()
  const byId = new Map(groups.map((g) => [g.id, g]))
  for (let i = 0; i < orderedIds.length; i++) {
    const g = byId.get(orderedIds[i]!)
    if (g) g.order = i
  }
  for (const g of byId.values()) await writeGroup(g)
}

/**
 * 把脚本移动到某分组（groupId 为空字符串 = 归未分组）。
 * 只改 group 字段 + updatedAt，不产生 git 提交（group 不入仓）。
 */
export async function setProjectGroup(uuid: string, groupId: string): Promise<ScriptProject> {
  const project = await getProject(uuid)
  if (!project) throw new Error('脚本不存在')
  project.group = groupId
  project.updatedAt = Date.now()
  await writeProject(project)
  return project
}

/** 读分组，不存在则抛错（silent=true 时返回 undefined） */
async function readGroupSafe(id: string, opts?: { silent?: boolean }): Promise<ScriptGroup | undefined> {
  const group = await readGroup(id)
  if (!group) {
    if (opts?.silent) return undefined
    throw new Error('分组不存在')
  }
  return group
}
