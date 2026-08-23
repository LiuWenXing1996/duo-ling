import { app, shell, BrowserWindow, ipcMain, screen } from 'electron'
import { join } from 'node:path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { listTasks, createTask, renameTask, saveTasks, type Task } from './store'
import {
  deleteProfile,
  generateReply,
  generateReplyWithSystemPrompt,
  getActiveProfileId,
  getProfileApiKey,
  getPublicProfiles,
  getSystemPrompt,
  isConfigured,
  listModels,
  saveProfile,
  setActiveProfile,
  setProfileEnabled,
  setSystemPrompt,
  testChatConnection,
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

let currentWindow: BrowserWindow | undefined

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

/** 生成器系统提示词：把当前能力清单喂给 LLM，让它在 setup 里用 cap.run 生成一个完整的前端组件 */
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
  return [
    '你是 Duo Ling 的工具生成器：用户说一句话，你要生成一个「完整的前端组件」，创建一个新工具。',
    `当前可用的原子能力如下（组件逻辑里用 cap.run('能力id', 参数对象) 调用，返回一个 Promise 对象）：\n${list}`,
    '请输出一个 JSON（用 ```json 代码块包裹，不要输出其它内容），结构如下：',
    '{"name":"kebab-case-id","title":"工具名","description":"说明","template":"...","setup":"..."}',
    '其中：',
    '1. template 是一个 Vue 3 模板字符串（含输入框 / 按钮 / 布局 / 结果展示），用双引号包裹，内部字符串用单引号或转义双引号（\\"），换行写成 \\n。',
    '   - 输入字段用 v-model 绑定 setup 里用 ref() 定义的变量。',
    '   - 点击按钮用 @click 绑定 setup 里定义的函数。',
    '   - 结果用 {{ }} 插值或 v-html 展示。',
    '2. setup 是一段组件逻辑源码，必须写成：export default function setup() { ... return { ... } }。',
    '   - 响应式变量用 ref() / computed() 定义，生命周期可用 onMounted() / onUnmounted()（这些 API 已全局注入，直接使用，不要 import）。',
    '   - cap.run(\'能力id\', 参数) 是能力调用入口，参数的字段名对照上面能力清单的入参，返回一个对象（如 { content }、{ html }）。',
    '   - 把模板里用到的变量与函数全部 return 出去。',
    '3. template 和 setup 里调用的能力 id 必须在上面清单内，不要伪造不存在的能力。',
    '示例（读取本地 Markdown 文件并渲染预览，这是最典型的完整组件）：',
    '{',
    '  "name": "md-file-preview",',
    '  "title": "Markdown 文件预览",',
    '  "description": "读取本地 Markdown 文件并渲染为 HTML",',
    '  "template": "<div class=\\"p-4 space-y-3\\">\\n  <div class=\\"flex gap-2\\">\\n    <input v-model=\\"path\\" placeholder=\\"文件绝对路径\\" class=\\"flex-1 rounded border border-input bg-transparent px-2 py-1 text-xs outline-none focus-visible:border-ring\\" />\\n    <button @click=\\"run\\" class=\\"rounded bg-primary px-3 py-1 text-xs text-primary-foreground\\">渲染预览</button>\\n  </div>\\n  <div v-if=\\"html\\" class=\\"prose-sm rounded-lg border border-border p-3\\" v-html=\\"html\\"></div>\\n  <p v-if=\\"error\\" class=\\"text-xs text-red-500\\">{{ error }}</p>\\n</div>",',
    '  "setup": "export default function setup() {\\n  const path = ref(\'\');\\n  const html = ref(\'\');\\n  const error = ref(\'\');\\n  async function run() {\\n    error.value = \'\';\\n    try {\\n      const file = await cap.run(\'local.file.read\', { path: path.value });\\n      const rendered = await cap.run(\'docs.markdown.render\', { markdown: file.content });\\n      html.value = rendered.html;\\n    } catch (e) {\\n      error.value = e instanceof Error ? e.message : String(e);\\n    }\\n  }\\n  return { path, html, error, run };\\n}"',
    '}',
    '交互规则：',
    '1. 目标明确 → 直接输出上面的 JSON，不要解释文字。',
    '2. 能力缺失 → 明确说明缺了什么能力，并用现有能力给出替代方案，或引导用户调整需求。',
    '3. 需求模糊 → 先追问澄清，再输出 JSON。',
    '4. setup 里只能调用 cap.run 且能力 id 必须在上面清单内。',
    '5. 组件只使用原生 HTML 元素（div / input / button 等）与内置指令，不要引入其它组件。'
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
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      sandbox: false
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

  // 原子能力：清单查询 + 后端能力执行（前端能力由渲染层注入方法直接调用）
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
      if (cap.runtime !== 'backend') {
        return { ok: false, error: `能力 ${id} 为 frontend 运行域，应经渲染层注入方法调用` }
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
