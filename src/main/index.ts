import { app, shell, BrowserWindow, ipcMain, protocol, screen } from 'electron'
import { join, normalize } from 'node:path'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { writeToolPage, newToolScaffoldHtml, toolsRoot, listToolPages, applyToolChanges, deleteToolPage, type ToolChangeList } from './tool-page'
import { runFrontendCapability } from './frontend-impls'
import { listTasks, createTask, renameTask, saveTasks, type Task } from './store'
import {
  deleteProfile,
  generateReply,
  generateReplyWithSystemPrompt,
  getActiveProfileId,
  getGeneratorApprovalMode,
  getProfileApiKey,
  getPublicProfiles,
  getSystemPrompt,
  isConfigured,
  listModels,
  saveProfile,
  setActiveProfile,
  setGeneratorApprovalMode,
  setProfileEnabled,
  setSystemPrompt,
  testChatConnection,
  type GeneratorApprovalMode,
  type ModelProfile,
  type ModelProfileInput
} from './online-llm'
import { getProviders, type ModelProvider } from './providers'
import { listChatMessages, appendChatMessage, type ChatMessage } from './chat-store'
import { listCapabilitiesHandler, runBackendCapability } from './capability-runtime'
import type { Capability } from './capability-registry'

// 端测等场景可通过环境变量指定 userData 目录，避免写入系统默认位置
if (process.env['DUO_LING_USER_DATA_DIR']) {
  app.setPath('userData', process.env['DUO_LING_USER_DATA_DIR'])
}

// 开发环境开启 CDP 远程调试端口（渲染进程），
// 可通过 chrome://inspect 或 Playwright connectOverCDP 远程调试界面
if (is.dev) {
  app.commandLine.appendSwitch('remote-debugging-port', '9222')
}

// 把 `tool://` 注册为标准安全 scheme：作为独立源被渲染层 iframe 嵌入工具详情栏，
// 否则非标准 scheme 会被当作不透明源，CSP `'self'` 与同源语义失效
protocol.registerSchemesAsPrivileged([
  { scheme: 'tool', privileges: { standard: true, secure: true, supportFetchAPI: true } }
])

let currentWindow: BrowserWindow | undefined

/** 生成一个足够唯一的宿主工具 ID（时间戳 + 随机段），用于工具文件夹名与 tool:// host */
function createToolId(): string {
  return `t-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

// 当前模型生成的中止控制器（模块级，供退出前中止使用）
let chatAbortController: AbortController | undefined
// 工具生成器的中止控制器（独立于对话，避免互斥）
let generatorAbortController: AbortController | undefined
let quitConfirmed = false

/** 是否正在生成回复 */
function isGenerating(): boolean {
  return chatAbortController != null || generatorAbortController != null
}

/** 中止当前所有生成（对话 + 生成器） */
function abortCurrentGeneration(): void {
  chatAbortController?.abort()
  generatorAbortController?.abort()
}

/** 生成器系统提示词：把当前能力清单喂给 LLM，让它对当前工具输出「变更清单」 */
function buildGeneratorSystemPrompt(): string {
  const caps = listCapabilitiesHandler()
  const list = caps
    .map((c) => {
      const inFields = c.inputSchema?.fields
        ? Object.entries(c.inputSchema.fields)
            .map(([k, v]) => `${k}: ${v.type}`)
            .join(', ')
        : '无'
      const outFields = c.outputSchema?.fields
        ? Object.entries(c.outputSchema.fields)
            .map(([k, v]) => `${k}: ${v.type}`)
            .join(', ')
        : '无'
      const sampleArgs = c.inputSchema?.fields
        ? Object.keys(c.inputSchema.fields)
            .map((k) => `${k}: '<${k}>'`)
            .join(', ')
        : ''
      return [
        `- ${c.id}（${c.name}）：${c.description}`,
        `  入参: ${inFields} → 出参: ${outFields}`,
        `  调用: cap.run('${c.id}', { ${sampleArgs} })`
      ].join('\n')
    })
    .join('\n')
  // 示例变更清单（把标题改成「Markdown 速览」并给预览容器加背景）：用 JSON.stringify 生成，避免手写转义出错。
  const example = JSON.stringify({
    summary: '把标题改成「Markdown 速览」，并给预览容器加上背景色。',
    actions: [
      { op: 'patch', file: 'index.html', find: '<h1>Markdown 文件预览</h1>', replace: '<h1>Markdown 速览</h1>' },
      { op: 'patch', file: 'index.html', find: '<style>', replace: '<style>#out{background:#f6f8fa;padding:8px;}' },
      {
        op: 'write',
        file: 'meta.json',
        content: { name: 'md-file-preview', title: 'Markdown 速览', description: '读取本地 Markdown 文件并渲染为 HTML' }
      }
    ]
  })
  return [
    '你是 Duo Ling 的工具生成器：用户要求「修改当前打开的工具」，你要输出一份「变更清单」描述对工具的改动，而不是整页重写。',
    '界面形态：这个工具就是一份完整、自我包含的 HTML 文档，由独立 <webview>（webContents）经 tool:// 协议承载，界面与交互用原生 HTML/CSS/JavaScript 编写，宿主已注入全局对象 cap（window.cap.run 调原子能力）。',
    '工具目录里只有两个可改文件：index.html（工具页面主体）、meta.json（工具元信息 name / title / description）。',
    `当前可用的原子能力如下（页面逻辑里用 cap.run('能力id', 参数对象) 调用，返回一个 Promise 对象，resolve 值为结果对象）：\n${list}`,
    '请输出一个 JSON（用 ```json 代码块包裹，不要输出其它内容），结构如下：',
    '{"summary":"一句话说明这次改了什么","actions":[{"op":"write|patch","file":"index.html|meta.json",...}]}',
    '其中 actions 每一项：',
    '1. write index.html：{"op":"write","file":"index.html","content":"<!doctype html>..."}，content 是一份完整 HTML 文档（含 <!doctype html><html><head><body>），CSS 写在 <style>，JS 写在 <script>，保持自我包含，不要依赖任何外部文件或 CDN（宿主已允许内联脚本、内联样式与内联事件）。',
    '   - 交互逻辑用原生 JS，通过 cap.run(\'能力id\', 参数) 调用原子能力，参数对照能力清单入参，返回值形如 { content }、{ html }。',
    '   - 用 addEventListener 绑定事件（或用 onclick 内联属性），结果写入页面 DOM。',
    '   - 页面只使用原生 HTML 元素（div / input / button / pre / textarea 等）。',
    '2. write meta.json：{"op":"write","file":"meta.json","content":{"name":"kebab-case-id","title":"工具名","description":"说明"}}。',
    '3. patch（精确替换，只用于小改动）：{"op":"patch","file":"index.html","find":"被替换的原文","replace":"替换后的内容"}。find 必须在文件里能精确匹配到；默认只替换第一处，需要全部替换时加 "replace_all": true。',
    '4. file 只能是 index.html 或 meta.json；不要修改其它文件。',
    '示例（把标题改成「Markdown 速览」并给预览容器加背景）：',
    example,
    '交互规则：',
    '1. 目标明确 → 直接输出上面的 JSON，不要解释文字。',
    '2. 能力缺失 → 明确说明缺了什么能力，并用现有能力给出替代方案，或引导用户调整需求。',
    '3. 需求模糊 → 先追问澄清，再输出 JSON。',
    '4. 页面逻辑里只能调用 cap.run 且能力 id 必须在上面清单内。',
    '5. 尽量用小而精确的 patch，避免不必要的整页重写；确需重写整个页面时再用 write。',
    '6. meta.json 的 title 要同步成最新标题，保证标签名一致。'
  ].join('\n')
}

const DEFAULT_WIDTH = 1100
const DEFAULT_HEIGHT = 750

// dev 模式窗口藏左下角：窗口右上角位于工作区左下角右上方 (DEV_CORNER_X, DEV_CORNER_Y) 处，
// 主体藏在屏幕左/下之外，避免 -w 重启/启动时弹到屏幕中央打断操作
const DEV_CORNER_X = 100
const DEV_CORNER_Y = 100

/** dev 窗口初始位置：窗口右上角位于工作区左下角右上方 (DEV_CORNER_X, DEV_CORNER_Y) 处 */
function devCornerBounds(): { x: number; y: number } {
  const wa = screen.getPrimaryDisplay().workArea
  return {
    x: wa.x + DEV_CORNER_X - DEFAULT_WIDTH,
    y: wa.y + wa.height - DEV_CORNER_Y
  }
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    minWidth: 800,
    minHeight: 600,
    // 无标题栏：macOS 用 hiddenInset（隐藏标题栏、保留红绿灯），
    // Windows/Linux 用 titleBarOverlay（隐藏标题栏、保留系统窗口按钮）
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform !== 'darwin'
      ? {
          titleBarOverlay: {
            color: '#ffffff',
            symbolColor: '#52525b',
            height: 32
          }
        }
      : {}),
    // dev 藏角落：不在构造参数里传屏外坐标（macOS 会拉回屏内），改为显示后 setBounds
    show: false,
    autoHideMenuBar: true,
    title: 'Duo Ling',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      sandbox: false,
      // 允许渲染层用 <webview> 承载工具详情页：独立 webContents，可挂 preload 注入 window.cap + 心跳
      webviewTag: true
    }
  })
  currentWindow = mainWindow

  mainWindow.once('ready-to-show', () => {
    if (is.dev) {
      // 透明 + showInactive（不抢焦点）→ setBounds 移到屏外角落 → 恢复不透明，
      // 既避免 macOS 把屏外窗口拉回屏内，也避免启动闪现打断操作
      const bounds = devCornerBounds()
      mainWindow.setOpacity(0)
      mainWindow.showInactive()
      mainWindow.setBounds({ ...bounds, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT })
      setImmediate(() => mainWindow.setOpacity(1))
    } else {
      mainWindow.show()
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.duo-ling.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // 自定义 `tool://` 协议：把 <userData>/tools/<id>/… 作为工具页的同源根目录。
  // 所有资源（index.html / tool.js / vendor）均走 tool://，CSP `script-src 'self'` 可放行本地脚本。
  protocol.handle('tool', (request) => {
    try {
      const url = new URL(request.url)
      const { host, pathname } = url
      let filePath: string
      if (pathname.startsWith('/vendor/')) {
        filePath = join(toolsRoot(), 'vendor', pathname.replace(/^\/vendor\//, ''))
      } else {
        // pathname 以 / 开头，. 使其成为相对 host 目录的路径
        filePath = join(toolsRoot(), host, '.' + pathname)
      }
      const root = normalize(toolsRoot())
      const resolved = normalize(filePath)
      // 防目录穿越：解析后的路径必须仍在工具根目录内
      if (!resolved.startsWith(root)) {
        return new Response('forbidden', { status: 403 })
      }
      const body = readFileSync(resolved)
      const contentType = resolved.endsWith('.js')
        ? 'application/javascript; charset=utf-8'
        : resolved.endsWith('.json')
          ? 'application/json; charset=utf-8'
          : 'text/html; charset=utf-8'
      return new Response(body, {
        headers: { 'content-type': contentType, 'cache-control': 'no-cache' }
      })
    } catch {
      return new Response('not found', { status: 404 })
    }
  })

  // 示例 IPC：渲染进程通过 window.api.ping() 调用
  ipcMain.handle('app:ping', () => 'pong')

  // 任务列表持久化：electron-store 读写 <userData>/tasks.json
  ipcMain.handle('tasks:list', () => listTasks())
  ipcMain.handle('tasks:create', () => createTask())
  ipcMain.handle('tasks:rename', (_event, taskId: number, title: string) => renameTask(taskId, title))
  ipcMain.handle('tasks:save', (_event, tasks: Task[]) => saveTasks(tasks))

  // 在线大模型：模型配置列表管理（OpenAI 兼容接口）
  ipcMain.handle(
    'model:list',
    (): { profiles: ModelProfile[]; activeId: string } => ({
      profiles: getPublicProfiles(),
      activeId: getActiveProfileId()
    })
  )
  ipcMain.handle('model:save', (_event, profile: ModelProfileInput): ModelProfile =>
    saveProfile(profile)
  )
  ipcMain.handle('model:delete', (_event, id: string) => deleteProfile(id))
  ipcMain.handle('model:setActive', (_event, id: string) => setActiveProfile(id))
  // 启用/禁用模型（开关）
  ipcMain.handle('model:toggle', (_event, id: string, enabled: boolean) =>
    setProfileEnabled(id, enabled)
  )
  // 全局系统提示词：所有模型共用
  ipcMain.handle('settings:getSystemPrompt', () => getSystemPrompt())
  ipcMain.handle('settings:setSystemPrompt', (_event, value: string) => setSystemPrompt(value))
  // 服务商预设列表（用于「添加模型」弹窗）
  ipcMain.handle('provider:list', (): ModelProvider[] => getProviders())

  // 原子能力：清单查询 + 能力执行（backend 走 capability-runtime；frontend 走 frontend-impls，工具页也经此）
  ipcMain.handle('capability:list', (): Capability[] => listCapabilitiesHandler())

  ipcMain.handle(
    'capability:run',
    async (
      _event,
      id: string,
      args: unknown
    ): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> => {
      if (typeof id !== 'string' || !id.trim()) {
        return { ok: false, error: '能力 id 不能为空' }
      }
      const cap = listCapabilitiesHandler().find((c) => c.id === id)
      if (!cap) {
        return { ok: false, error: `未知能力: ${id}` }
      }
      if (cap.runtime === 'frontend') {
        // 工具页为 <webview> guest，无主窗口渲染层的注入方法，
        // 因此 frontend 能力也统一收口到主进程执行（由 frontend-impls.ts 提供实现）
        return runFrontendCapability(id, args)
      }
      try {
        return { ok: true, result: await runBackendCapability(id, args) }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )
  // 测试连接：用传入的 baseUrl/apiKey（不落盘）拉取模型列表，验证 key/网络
  ipcMain.handle(
    'model:test',
    async (
      _event,
      config: { baseUrl: string; apiKey: string }
    ): Promise<{ ok: boolean; models?: string[]; error?: string }> => {
      try {
        return { ok: true, models: await listModels(config) }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )
  // 连通性测试：发一次「最小」chat 请求验证地址/Key/模型（会消耗极少量 Token）
  ipcMain.handle(
    'model:testChat',
    async (
      _event,
      config: { baseUrl: string; apiKey: string; model: string; useFullUrl?: boolean; profileId?: string }
    ): Promise<{ ok: boolean; error?: string }> => {
      try {
        // 编辑态 Key 未回显：apiKey 为空时回退到该配置已保存的 Key
        const apiKey = config.apiKey?.trim() || (config.profileId ? getProfileApiKey(config.profileId) : '')
        await testChatConnection({ ...config, apiKey })
        return { ok: true }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  // 窗口信息：读取当前窗口位置/尺寸（用于开发调试与窗口状态管理）
  ipcMain.handle('window:getBounds', () => {
    const bounds = currentWindow?.getBounds()
    return bounds
      ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
      : null
  })

  // 对话：按任务（会话）读写历史，流式生成回复

  ipcMain.handle('chat:history', (_event, taskId: number) => listChatMessages(taskId))

  ipcMain.handle('chat:send', async (event, taskId: number, text: string) => {
    if (typeof text !== 'string' || !text.trim()) {
      throw new Error('消息不能为空')
    }
    if (!isConfigured()) {
      throw new Error('尚未配置可用的在线模型，请先在「设置」中添加')
    }
    if (chatAbortController) {
      throw new Error('当前有正在生成的回复，请先停止')
    }

    const userMessage: ChatMessage = {
      id: Date.now(),
      role: 'user',
      content: text,
      createdAt: new Date().toISOString()
    }
    appendChatMessage(taskId, userMessage)

    // 历史为当前用户消息之前的部分
    const history = listChatMessages(taskId).slice(0, -1)

    // 首条消息自动命名：标题仍是自动生成的「新会话*」时，用首条消息前缀替换
    if (history.length === 0) {
      const current = listTasks().find((task) => task.id === taskId)
      if (current && current.title.startsWith('新会话')) {
        renameTask(taskId, text.trim().slice(0, 15))
      }
    }

    const abort = new AbortController()
    chatAbortController = abort
    let full = ''

    try {
      const reply = await generateReply(history, text, (token) => {
        full += token
        event.sender.send('chat:event', { type: 'token', taskId, token })
      }, abort.signal)
      const assistantMessage: ChatMessage = {
        id: Date.now(),
        role: 'assistant',
        content: reply,
        createdAt: new Date().toISOString()
      }
      appendChatMessage(taskId, assistantMessage)
      event.sender.send('chat:event', { type: 'done', taskId, message: assistantMessage })
      return assistantMessage
    } catch (error) {
      if (abort.signal.aborted) {
        // 中止时保留已生成的部分回复
        const content = full.trim()
        const message = content
          ? ({
              id: Date.now(),
              role: 'assistant',
              content,
              createdAt: new Date().toISOString()
            } satisfies ChatMessage)
          : null
        if (message) appendChatMessage(taskId, message)
        event.sender.send('chat:event', { type: 'aborted', taskId, message })
        return message
      }
      const message = error instanceof Error ? error.message : String(error)
      event.sender.send('chat:event', { type: 'error', taskId, error: message })
      throw error
    } finally {
      if (chatAbortController === abort) chatAbortController = undefined
    }
  })

  ipcMain.handle('chat:abort', () => {
    chatAbortController?.abort()
  })

  // —— 工具生成器：把「一句话 → 多轮澄清 → 能力预判 → 组合原子能力」交给 LLM ——
  // 用当前能力清单构建系统提示词，让 LLM 决定是追问澄清，还是输出可执行的工具 JSON。
  ipcMain.handle('generator:abort', () => {
    generatorAbortController?.abort()
  })

  ipcMain.handle(
    'generator:send',
    async (
      event,
      history: Array<{ role: 'user' | 'assistant'; content: string }>
    ): Promise<{ ok: boolean; content?: string; error?: string }> => {
      if (!Array.isArray(history) || history.length === 0) {
        return { ok: false, error: '对话历史不能为空' }
      }
      if (!isConfigured()) {
        return { ok: false, error: '尚未配置可用的在线模型，请先在「设置」中添加' }
      }
      if (generatorAbortController) {
        return { ok: false, error: '当前有正在生成的回复，请先停止' }
      }

      // 最后一条为用户消息，其余作为历史
      const last = history[history.length - 1]
      if (last.role !== 'user') {
        return { ok: false, error: '最后一条消息应为用户输入' }
      }
      const historyMsgs: ChatMessage[] = history.slice(0, -1).map((m, i) => ({
        id: Date.now() + i,
        role: m.role,
        content: m.content,
        createdAt: new Date().toISOString()
      }))

      const abort = new AbortController()
      generatorAbortController = abort
      const systemPrompt = buildGeneratorSystemPrompt()
      let full = ''

      try {
        const reply = await generateReplyWithSystemPrompt(
          systemPrompt,
          historyMsgs,
          last.content,
          (token) => {
            full += token
            event.sender.send('generator:event', { type: 'token', token })
          },
          abort.signal
        )
        event.sender.send('generator:event', { type: 'done', content: reply })
        return { ok: true, content: reply }
      } catch (error) {
        if (abort.signal.aborted) {
          event.sender.send('generator:event', { type: 'aborted', content: full })
          return { ok: false, content: full }
        }
        const message = error instanceof Error ? error.message : String(error)
        event.sender.send('generator:event', { type: 'error', error: message })
        return { ok: false, error: message }
      } finally {
        if (generatorAbortController === abort) generatorAbortController = undefined
      }
    }
  )

  // —— 新建工具 ——
  // 点击「新建工具」：宿主分配唯一 ID，落盘脚手架 index.html 与 meta.json，返回后由渲染层打开该工具标签页。
  ipcMain.handle(
    'tool:create',
    (): { ok: boolean; id?: string; title?: string; error?: string } => {
      try {
        const id = createToolId()
        const title = '新建工具'
        writeToolPage({ id, name: 'new-tool', title, description: '', html: newToolScaffoldHtml(title) })
        return { ok: true, id, title }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  // 工具详情页 <webview> 需要 guest preload：注入 window.cap + 心跳。
  // <webview> 的 preload 属性要求 file: URL，故用 pathToFileURL 转成 file://。
  ipcMain.handle('tool:getPreloadPath', () =>
    pathToFileURL(join(import.meta.dirname, '../preload/tool.cjs')).toString()
  )

  // 读取所有已落盘工具列表（供全局搜索下拉等场景使用）
  ipcMain.handle('tool:list', () => listToolPages())

  // 删除指定工具：移除 <userData>/tools/<id>/ 目录（主页工具卡片删除按钮调用）
  ipcMain.handle(
    'tool:delete',
    (_event, id: string): { ok: boolean; error?: string } => {
      const result = deleteToolPage(id)
      return result.ok ? { ok: true } : { ok: false, error: result.error }
    }
  )

  // 应用生成器产出的「变更清单」到当前工具：由主进程负责校验 + 落盘，而非放开 AI 直接碰磁盘。
  // 「当前会话」聊天驱动 AI 构建/修改工具时调用（手动审批用户确认后 / 自动审批直接触发）。
  ipcMain.handle(
    'tool:update',
    (
      _event,
      id: string,
      changes: ToolChangeList
    ): { ok: boolean; title?: string; changedFiles?: string[]; error?: string } => {
      try {
        const result = applyToolChanges(id, changes)
        return result
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  // 读取生成器审批模式的全局默认（manual / auto）
  ipcMain.handle('settings:getGeneratorApprovalMode', (): GeneratorApprovalMode => getGeneratorApprovalMode())

  // 设置生成器审批模式的全局默认
  ipcMain.handle('settings:setGeneratorApprovalMode', (_event, mode: GeneratorApprovalMode): void => {
    setGeneratorApprovalMode(mode)
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// 退出前中止进行中的生成：避免 NAPI 工作线程在 Node 环境清理时抛异常导致崩溃
app.on('before-quit', (event) => {
  if (quitConfirmed || !isGenerating()) return
  event.preventDefault()
  abortCurrentGeneration()
  const deadline = Date.now() + 2000
  const timer = setInterval(() => {
    if (!isGenerating() || Date.now() >= deadline) {
      clearInterval(timer)
      quitConfirmed = true
      app.quit()
    }
  }, 100)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
