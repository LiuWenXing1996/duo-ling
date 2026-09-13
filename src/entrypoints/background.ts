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
import type { GitCommitResult, RuntimeRequest } from '@/shared/extension-ipc'
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

const handlers: {
  [K in RuntimeRequest['kind']]: (msg: Extract<RuntimeRequest, { kind: K }>) => Promise<unknown>
} = {
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
}

export default defineBackground(() => {
  // 点击工具栏图标即打开 side panel。
  // 需 manifest 同时声明 sidePanel 权限 + action 键，否则 chrome.sidePanel 不存在、此调用静默失败。
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((e) => console.error('[duoling] setPanelBehavior failed', e))

  void ensureSampleTool().catch((e) => console.error('[duoling] init failed', e))

  chrome.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
    const msg = raw as RuntimeRequest | undefined
    if (!msg?.kind) return
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
