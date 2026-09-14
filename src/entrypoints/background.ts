// background = 桌面版 main 进程的能力运行时（对应迁移方案 §4.3）。
// 职责：工具文件与 git 操作的唯一写入方 + 原子能力执行。
// 对话、模型配置不走这里（分别直连 IndexedDB 与 chrome.storage.local，见 src/lib/api.ts）。
import '@/polyfills' // 必须在最前：补全 SW 的 global/Buffer/process 全局，早于 isomorphic-git 引用
import { defineBackground } from '#imports'
import {
  applyToolChanges,
  commitIfChanged,
  createTool,
  deleteTool,
  ensureToolRepo,
  ensureToolsRoot,
  fileExists,
  listCommits,
  listToolFiles,
  listTools,
  readArchive,
  readPageAtCommit,
  readToolFile,
  readToolMeta,
  readToolPage,
  rollbackToCommit,
  updateToolMeta,
  writeToolFile,
  writeToolMeta,
} from '@/fs-store'
import { getCapability, listCapabilities } from '@/capabilities/registry'
import { toolPageHtml } from '@/tool-page-template'
import type { GitCommitResult, ModelProfileState, OffscreenPush, RuntimeRequest } from '@/shared/extension-ipc'
import type {
  Capability,
  ToolArchiveResult,
  ToolCodeFile,
  ToolCodeResult,
  ToolCreateResult,
  ToolHistoryResult,
  ToolResult,
  ToolUpdateMetaResult,
  ToolUpdateResult,
  UserToolMeta,
} from '@/shared/types'

// 用户脚本管理器（v2 方案 docs/userscript-v2-plan.md Phase 0）：引擎 + 存储 + DL 桥 + 类型
import {
  configureUserScriptsWorld,
  isUserScriptsAvailable,
  getUserScriptsStatus,
  registerAllEnabled,
  recoverOnUpdate,
  registerScript,
  unregisterScripts,
  getEffectiveCspPermissive,
  collectCspWarnings,
  resolveInjectCode,
} from '@/lib/userscripts/engine'
import { initDlBridge } from '@/lib/userscripts/dl-bridge'
import { listSummaries, getProject, saveProject, deleteScript, updateProjectFiles, clearDeprecatedScripts, listUserScriptErrors, clearUserScriptErrors, appendUserScriptError, nextScriptName } from '@/lib/userscripts/store'
import type { ScriptProject, UserScriptsAvailability } from '@/lib/userscripts/types'
import { snapshotProject, listHistory, readTreeAt, restoreToCommit, deleteRepo } from '@/lib/userscripts/us-git'
import { ENTRY_DEFAULT, defaultConfig, defaultSource } from '@/lib/userscripts/types'

// offscreen document 容器（AI 生成链路的执行宿主，方案 §4.8 定位 B）
import { ensureOffscreen, closeOffscreen, isOffscreenReady } from '@/lib/offscreen'
// 模型配置：offscreen 既收不到 storage.onChanged、也不该直连存储，一律由 SW 经命令 / 推送中转
import { getActiveProfileState } from '@/lib/model-store'

/**
 * 模型配置在 chrome.storage.local 的键。
 * 与 src/lib/model-store.ts 的 `KEY`、tool-prefs.ts 保留键清单里那个字符串是同一个值
 * （键名是持久化契约，改名要迁数据，故各处并行硬编码、不互相 import）。
 */
const MODEL_PROFILES_KEY = 'modelProfiles'

/** 初始示例工具：工具工厂开箱即用的一个工具，验证"生成 → 运行 → 提交 → 回滚"闭环 */
const SAMPLE_TOOL_ID = 'markdown'

/** 幂等：SW 闲置回收后会重启，初始化必须可重复执行且不覆盖用户改动 */
async function ensureSampleTool(): Promise<void> {
  await ensureToolsRoot()
  await ensureToolRepo(SAMPLE_TOOL_ID)
  if (!(await fileExists(SAMPLE_TOOL_ID, 'index.html'))) {
    await writeToolFile(SAMPLE_TOOL_ID, 'index.html', toolPageHtml(SAMPLE_TOOL_ID))
  }
  if (!(await fileExists(SAMPLE_TOOL_ID, 'meta.json'))) {
    await writeToolMeta(SAMPLE_TOOL_ID, {
      id: SAMPLE_TOOL_ID,
      name: SAMPLE_TOOL_ID,
      title: 'Markdown 渲染',
      description: '把 Markdown 渲染成 HTML 并留版本',
      icon: '📝',
      capabilities: ['markdown.render'],
    })
  }
  if (!(await fileExists(SAMPLE_TOOL_ID, 'output.html'))) {
    await writeToolFile(SAMPLE_TOOL_ID, 'output.html', '<p>还没有内容</p>')
  }
}

/**
 * SW 管辖的 kind 前缀（路由白名单，方案 §4.8「统一的 route」）。
 *
 * offscreen 与 SW 同时在监听 runtime 消息，而 sendResponse 对一条消息只有一次机会 ——
 * SW 只应响应这里登记的前缀，其余（如将来 offscreen 的 ai: / chat: 指令）必须让路，
 * 否则 SW 会抢答、把 offscreen 的响应挤掉。
 *
 * 新增命令时若忘了登记前缀，该命令会静默无响应（而不是报「未知消息类型」）——
 * 这是刻意的：静默比一个假错误更诚实。
 */
const SW_KIND_PREFIXES = ['tool:', 'cap:', 'git:', 'userscript:', 'model:', 'offscreen:'] as const

const handlers: {
  [K in RuntimeRequest['kind']]: (msg: Extract<RuntimeRequest, { kind: K }>) => Promise<unknown>
} = {
  // —— offscreen 容器（方案 §4.8 定位 B）——
  // A 组只做容器与通道：这几个命令供手动 / 调试触发；B 组的生成入口会直接调 ensureOffscreen()。
  'offscreen:ensure': async (): Promise<{ ready: boolean }> => {
    await ensureOffscreen()
    return { ready: await isOffscreenReady() }
  },

  'offscreen:close': async (): Promise<void> => closeOffscreen(),

  'offscreen:status': async (): Promise<{ ready: boolean }> => ({ ready: await isOffscreenReady() }),

  /** offscreen 启动握手（offscreen → SW）：容器自己报告已就绪，便于排查启动问题 */
  'offscreen:ready': async (): Promise<void> => {
    console.log('[duoling:offscreen] 容器已就绪')
  },

  // 模型配置：offscreen 拉取当前生效配置（含 apiKey）。复用现成的 getActiveProfileState()，
  // SW 里本来就能调；offscreen 侧须「取一次、缓存、不写日志」（方案 §4.8 配置通道）。
  'model:getActiveProfile': async (): Promise<ModelProfileState | undefined> => getActiveProfileState(),

  // 工具列表：只列 meta.json 完整的工具（残留目录不进网格，对齐桌面版 listUserTools）
  'tool:list': async (): Promise<UserToolMeta[]> => listTools(),

  'tool:getMeta': async (msg): Promise<UserToolMeta | undefined> => readToolMeta(msg.toolId),

  'tool:create': async (): Promise<ToolCreateResult> => createTool(),

  'tool:getPage': async (msg): Promise<string> => readToolPage(msg.toolId),

  'tool:readFile': async (msg): Promise<string> => readToolFile(msg.toolId, msg.path),

  'tool:listFiles': async (msg): Promise<ToolCodeFile[]> => listToolFiles(msg.toolId),

  // 「代码浏览」标签页：白名单源码树（含内容）
  'tool:codeTree': async (msg): Promise<ToolCodeResult> => {
    try {
      if (!msg.toolId) return { ok: false, error: '缺少工具 id' }
      return { ok: true, files: await listToolFiles(msg.toolId) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  },

  'tool:updateMeta': async (msg): Promise<ToolUpdateMetaResult> => updateToolMeta(msg.toolId, msg.patch),

  // 「版本历史」标签页：新提交在前；无仓库/无提交视为空历史（正常态，不报错）
  'tool:history': async (msg): Promise<ToolHistoryResult> => {
    try {
      return { ok: true, commits: await listCommits(msg.toolId) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  },

  // 「工具档案」面板：archive.md 只读展示，无档案返回空串
  'tool:archive': async (msg): Promise<ToolArchiveResult> => readArchive(msg.toolId),

  // 版本预览：返回目标提交下的工具页 HTML，由 ToolHistory 以 sandbox iframe 渲染
  'tool:pageAt': async (msg): Promise<string> => readPageAtCommit(msg.toolId, msg.oid),

  // 回滚到指定提交：写回文件并产生新的回滚提交（历史可逆，不 reset）
  'tool:rollbackTo': async (msg): Promise<ToolResult> => {
    const result = await rollbackToCommit(msg.toolId, msg.oid)
    return result.ok ? { ok: true } : { ok: false, error: result.error }
  },

  // 应用变更清单（AI 编辑工具产物）：校验白名单后落盘并提交一次
  'tool:update': async (msg): Promise<ToolUpdateResult> => applyToolChanges(msg.toolId, msg.changes),

  'tool:delete': async (msg): Promise<void> => deleteTool(msg.toolId),

  'cap:run': async (msg): Promise<unknown> => {
    const capability = getCapability(msg.capId)
    if (!capability) throw new Error(`未注册的能力：${msg.capId}`)
    const result = await capability.run(msg.input)
    // 工具输出落盘约定：渲染类能力的产物写进 output.html，由工具页随后显式提交版本。
    // （后续接入 file.write 能力后，这层约定可以移交给工具页自己声明。）
    if (msg.toolId && msg.capId === 'markdown.render' && typeof result.html === 'string') {
      await writeToolFile(msg.toolId, 'output.html', result.html)
    }
    return result
  },

  // 开发者界面：能力清单（注册表只存在于 SW 侧，渲染页不引它，避免把 isomorphic-git 打进页面包）
  'cap:list': async (): Promise<Capability[]> => listCapabilities(),

  // 工具页「提交版本」：仅在有净变更时提交（对齐桌面版 commitToolChanges），无变更返回 committed:false
  'git:commit': async (msg): Promise<GitCommitResult> => commitIfChanged(msg.toolId, msg.message),

  // —— 用户脚本管理器（v2 方案 Phase 0：命令面沿用，载荷换成项目形态）——
  'userscript:list': async (): Promise<unknown> => listSummaries(),

  // 读完整项目（编辑器多文件用；管理页是可信扩展页，源码不过滤）
  'userscript:getProject': async (msg): Promise<ScriptProject | undefined> => getProject(msg.uuid),

  // 更新文件树 + 入口 + 构建产物（Phase 2：UI 页构建成功后才调用），启用中则重注册。
  // registerScript 已优先 bundle.code（零改动）；无 bundle 时 resolveInjectCode 守卫兜底。
  'userscript:updateFiles': async (msg): Promise<{ warnings?: string[] }> => {
    const next = await updateProjectFiles(msg.uuid, msg.files, msg.entry, msg.bundle, {
      name: msg.name,
      config: msg.config,
    })
    await unregisterScripts([next.uuid]).catch(() => {})
    if (next.enabled) {
      try {
        await registerScript(next)
      } catch (e) {
        void appendUserScriptError({
          uuid: next.uuid,
          name: next.name,
          phase: 'register',
          message: e instanceof Error ? e.message : String(e),
        }).catch(() => {})
        throw e
      }
    }
    // git 历史侧车：保存成功后快照（bundle 不入库）。失败只丢历史不丢脚本，不阻断保存。
    try {
      await snapshotProject(next, msg.note)
    } catch (e) {
      console.warn('[duoling:userscript] 历史快照失败（不影响保存）', e)
    }
    return { warnings: collectCspWarnings(resolveInjectCode(next), await getEffectiveCspPermissive()) }
  },

  // 一键清理全部旧 GM 形态记录（含各自 DL.store 值）
  'userscript:clearDeprecated': async (): Promise<{ removed: number }> => {
    const removed = await clearDeprecatedScripts()
    return { removed }
  },

  // 新建脚本（零输入）：自动命名 + 初始模板 + 建 git 仓（首次快照）+ 注册。
  // 与下面的 install 的分工 —— install 由调用方提供源码与匹配规则（粘贴安装），这个全自动。
  'userscript:create': async (): Promise<{ uuid: string; name: string; warnings?: string[] }> => {
    const now = Date.now()
    const name = await nextScriptName()
    const project: ScriptProject = {
      v: 1,
      uuid: crypto.randomUUID(),
      name,
      // 新建即启用（2026-09-14 老大拍板）；初始源码无害，注入也安全
      enabled: true,
      config: defaultConfig(['*://*/*']),
      files: { [ENTRY_DEFAULT]: defaultSource(name) },
      entry: ENTRY_DEFAULT,
      createdAt: now,
      updatedAt: now,
    }
    await saveProject(project)
    // 建仓 + 首次提交（project.json 元数据 + files/main.js），让新脚本一开始就有完整历史起点。
    // 失败不阻断创建 —— 与保存链路同策略：仓损坏只丢历史，不丢脚本。
    await snapshotProject(project, '创建脚本').catch(() => {})
    try {
      await registerScript(project)
    } catch (e) {
      void appendUserScriptError({
        uuid: project.uuid,
        name: project.name,
        phase: 'register',
        message: e instanceof Error ? e.message : String(e),
      }).catch(() => {})
      throw e
    }
    const code = project.files[ENTRY_DEFAULT] ?? ''
    return { uuid: project.uuid, name: project.name, warnings: collectCspWarnings(code, await getEffectiveCspPermissive()) }
  },

  // 安装：单文件源码 → ScriptProject(v:1) 落盘 → 注册。
  // v2 新形态无 metadata：名称与匹配规则由调用方显式给出（缺省给开发用默认值）。
  'userscript:install': async (msg): Promise<{ uuid: string; warnings?: string[] }> => {
    const now = Date.now()
    const project: ScriptProject = {
      v: 1,
      uuid: crypto.randomUUID(),
      name: msg.name?.trim() || '未命名脚本',
      enabled: true,
      config: defaultConfig(msg.matches?.length ? msg.matches : ['*://*/*']),
      files: { [ENTRY_DEFAULT]: msg.source },
      entry: ENTRY_DEFAULT,
      createdAt: now,
      updatedAt: now,
    }
    await saveProject(project)
    try {
      await registerScript(project)
    } catch (e) {
      // 注册失败既在 UI 错误条提示，也进错误日志（面板可见）
      void appendUserScriptError({
        uuid: project.uuid,
        name: project.name,
        phase: 'register',
        message: e instanceof Error ? e.message : String(e),
      }).catch(() => {})
      throw e
    }
    const code = project.files[ENTRY_DEFAULT] ?? ''
    return { uuid: project.uuid, warnings: collectCspWarnings(code, await getEffectiveCspPermissive()) }
  },

  'userscript:remove': async (msg): Promise<void> => {
    await unregisterScripts([msg.uuid]).catch(() => {})
    await deleteScript(msg.uuid)
    // 历史不保留（拍板：删脚本即删历史仓）
    await deleteRepo(msg.uuid).catch(() => {})
  },

  // —— git 历史侧车（docs/userscript-git-history.md）——
  'userscript:history': async (msg): Promise<unknown> => listHistory(msg.uuid),

  'userscript:historyTree': async (msg): Promise<unknown> => readTreeAt(msg.uuid, msg.oid),

  // 恢复：物化项目落盘 + 重注册（enabled 保持当前值）；仓侧按需产生「回滚到 <oid>」新提交。
  // bundle 已丢弃，由 UI 页 builder 重建后再 updateFiles（构建失败仅提示，源码已恢复）。
  'userscript:restoreToCommit': async (msg): Promise<{ committed: boolean; project: ScriptProject }> => {
    const current = await getProject(msg.uuid)
    if (!current) throw new Error('脚本不存在或为已弃用旧记录')
    const { committed, restored } = await restoreToCommit(current, msg.oid)
    await saveProject(restored)
    await unregisterScripts([restored.uuid]).catch(() => {})
    if (restored.enabled) {
      try {
        await registerScript(restored)
      } catch (e) {
        void appendUserScriptError({
          uuid: restored.uuid,
          name: restored.name,
          phase: 'register',
          message: e instanceof Error ? e.message : String(e),
        }).catch(() => {})
        throw e
      }
    }
    return { committed, project: restored }
  },

  'userscript:toggle': async (msg): Promise<void> => {
    const existing = await getProject(msg.uuid)
    if (!existing) throw new Error('脚本不存在')
    existing.enabled = msg.enabled
    existing.updatedAt = Date.now()
    await saveProject(existing)
    if (msg.enabled) await registerScript(existing)
    else await unregisterScripts([msg.uuid]).catch(() => {})
  },

  'userscript:availability': async (): Promise<UserScriptsAvailability> => getUserScriptsStatus(),

  'userscript:errors': async (): Promise<ReturnType<typeof listUserScriptErrors>> => listUserScriptErrors(),

  'userscript:clearErrors': async (): Promise<void> => {
    await clearUserScriptErrors()
  },
}

/** 用户脚本管理器启动：挂载 DL 桥 + 配置 USER_SCRIPT 世界 + 恢复已启用项目 */
async function initUserScripts(): Promise<void> {
  initDlBridge() // DL 后台桥（独立于 world 配置，只需注册一次）
  // chrome.userScripts 仅在已开启「Allow User Scripts」（Chrome ≥138）或全局开发者模式
  // （Chrome <138）/ 已授权 userScripts 权限（Firefox）时存在；否则为 undefined，
  // 直接调用会令 SW 初始化崩溃。先判存在性，不可用则优雅跳过（UI 横幅会引导开启）。
  if (!chrome.userScripts) {
    console.warn(
      '[duoling:userscript] chrome.userScripts 不可用：Chrome ≥138 需在扩展详情页开启「Allow User Scripts」，' +
        'Chrome <138 需开启全局「开发者模式」；Firefox 需授权 userScripts 权限。用户脚本功能已禁用。',
    )
    return
  }
  await configureUserScriptsWorld()
  const ok = await isUserScriptsAvailable()
  if (!ok) {
    console.warn(
      '[duoling:userscript] userScripts 不可用：Chrome ≥138 需在扩展详情页开启「Allow User Scripts」，' +
        'Chrome <138 需开启全局「开发者模式」；Firefox 需授权 userScripts 权限',
    )
    return
  }
  await registerAllEnabled()
}

export default defineBackground(() => {
  // 点击工具栏图标即打开 side panel。
  // 需 manifest 同时声明 sidePanel 权限 + action 键，否则 chrome.sidePanel 不存在、此调用静默失败。
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((e) => console.error('[duoling] setPanelBehavior failed', e))

  void ensureSampleTool().catch((e) => console.error('[duoling] init failed', e))

  // 用户脚本管理器：启动配置世界并恢复已启用脚本（设计文档 §4）
  void initUserScripts().catch((e) => console.error('[duoling:userscript] init failed', e))

  // 扩展更新会清空 userScripts 注册与 world 配置，需在 update 分支重配重注册（设计文档 §4.4）
  chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'update') {
      void recoverOnUpdate().catch((e) => console.error('[duoling:userscript] recover failed', e))
    }
  })

  // 模型配置变更 → 通知 offscreen 重新拉取（它只有 chrome.runtime，收不到 storage.onChanged）。
  // 只发「变了」这个信号、**不推配置内容**：由 offscreen 主动回拉，apiKey 只在它取用时过界，
  // 而不是被 SW 广播（方案 §4.8 配置通道）。容器不存在就直接跳过，不为一条通知唤醒上下文。
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !Object.prototype.hasOwnProperty.call(changes, MODEL_PROFILES_KEY)) {
      return
    }
    void isOffscreenReady()
      .then((ready) => {
        if (!ready) return
        const push: OffscreenPush = { kind: 'offscreen:configChanged' }
        return chrome.runtime.sendMessage(push)
      })
      .catch(() => {
        // 尽力而为：容器刚被关掉 / 无人监听时不阻断
      })
  })

  chrome.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
    const msg = raw as RuntimeRequest | undefined
    if (!msg?.kind) return

    // 路由：只响应归 SW 管辖的 kind，其余静默让路给 offscreen（见 SW_KIND_PREFIXES）
    if (!SW_KIND_PREFIXES.some((p) => msg.kind.startsWith(p))) return false

    const handler = handlers[msg.kind] as ((m: RuntimeRequest) => Promise<unknown>) | undefined
    if (!handler) {
      sendResponse({ ok: false, error: `未知消息类型：${msg.kind}` })
      return false
    }

    handler(msg)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      )
    return true // 保留消息通道用于异步回传
  })
})
