// 工具生成器 IPC：把「一句话 → 多轮澄清 → 能力预判 → 组合原子能力」交给 LLM。
// 用当前能力清单构建系统提示词，让 LLM 决定是追问澄清，还是输出可执行的工具 JSON。
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { CH, EVENT_CH } from '../../shared/ipc'
import type { ChatMessage, GeneratorEventData, GeneratorMessage } from '../../shared/types'
import { listCapabilities } from '../capability-registry'
import { generateReplyWithSystemPrompt, isConfigured } from '../online-llm'
import { getGeneratorAbortController, setGeneratorAbortController } from './state'

/** 生成器系统提示词：把当前能力清单喂给 LLM，让它对当前工具输出「变更清单」 */
function buildGeneratorSystemPrompt(): string {
  const caps = listCapabilities()
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
        content: {
          name: 'md-file-preview',
          title: 'Markdown 速览',
          description: '读取本地 Markdown 文件并渲染为 HTML',
          capabilities: ['local.file.read', 'docs.markdown.render']
        }
      }
    ]
  })
  return [
    '你是 Duo Ling 的工具生成器：用户要求「修改当前打开的工具」，你要输出一份「变更清单」描述对工具的改动，而不是整页重写。',
    '界面形态：这个工具就是一份完整、自我包含的 HTML 文档，由独立 <webview>（webContents）经 tool:// 协议承载，界面与交互用原生 HTML/CSS/JavaScript 编写，宿主已注入全局对象 cap（window.cap.run 调原子能力）。',
    '工具目录里只有两个可改文件：index.html（工具页面主体）、meta.json（工具元信息 name / title / description / icon / capabilities）。',
    `当前可用的原子能力如下（页面逻辑里用 cap.run('能力id', 参数对象) 调用，返回一个 Promise 对象，resolve 值为结果对象）：\n${list}`,
    '工具如果需要跨会话保存数据（如收藏、历史、用户配置），用 tool.data.* 能力持久化：tool.data.write 写入 key/value，tool.data.read 读回，tool.data.list 列出所有 key，tool.data.remove 删除某个 key。key 只能用字母/数字/下划线/连字符。这些能力与其它能力一样，必须在 meta.json 的 capabilities 里声明。',
    '请输出一个 JSON（用 ```json 代码块包裹，不要输出其它内容），结构如下：',
    '{"summary":"一句话说明这次改了什么","actions":[{"op":"write|patch","file":"index.html|meta.json",...}]}',
    '其中 actions 每一项：',
    '1. write index.html：{"op":"write","file":"index.html","content":"<!doctype html>..."}，content 是一份完整 HTML 文档（含 <!doctype html><html><head><body>），CSS 写在 <style>，JS 写在 <script>，保持自我包含，不要依赖任何外部文件或 CDN（宿主已允许内联脚本、内联样式与内联事件）。',
    '   - 交互逻辑用原生 JS，通过 cap.run(\'能力id\', 参数) 调用原子能力，参数对照能力清单入参，返回值形如 { content }、{ html }。',
    '   - 用 addEventListener 绑定事件（或用 onclick 内联属性），结果写入页面 DOM。',
    '   - 页面只使用原生 HTML 元素（div / input / button / pre / textarea 等）。',
    '2. write meta.json：{"op":"write","file":"meta.json","content":{"name":"kebab-case-id","title":"工具名","description":"说明","icon":"图示字符","capabilities":["能力id1","能力id2"]}}。其中 icon 可选，必须是单个字符（emoji 或字母/汉字/符号，如 "🗂" 或 "文"），用于工具卡片与标签展示，缺省时不填；capabilities 是本工具页面会调用的能力 id 数组，只能从上面可用能力清单中选取，页面用到的每个 cap.run 的能力 id 都必须在这里声明，否则运行会被拒绝。',
    '3. patch（精确替换，只用于小改动）：{"op":"patch","file":"index.html","find":"被替换的原文","replace":"替换后的内容"}。find 必须在文件里能精确匹配到；默认只替换第一处，需要全部替换时加 "replace_all": true。',
    '4. file 只能是 index.html 或 meta.json；不要修改其它文件。',
    '示例（把标题改成「Markdown 速览」并给预览容器加背景）：',
    example,
    '交互规则：',
    '1. 目标明确 → 直接输出上面的 JSON，不要解释文字。',
    '2. 能力缺失 → 明确说明缺了什么能力，并用现有能力给出替代方案，或引导用户调整需求。',
    '3. 需求模糊 → 先追问澄清，再输出 JSON。',
    '4. 页面逻辑里只能调用 cap.run 且能力 id 必须在上面清单内，并在 meta.json 的 capabilities 里逐一声明。',
    '5. 尽量用小而精确的 patch，避免不必要的整页重写；确需重写整个页面时再用 write。',
    '6. meta.json 的 title 要同步成最新标题，保证标签名一致。'
  ].join('\n')
}

function sendGeneratorEvent(event: IpcMainInvokeEvent, payload: GeneratorEventData): void {
  event.sender.send(EVENT_CH.generator, payload)
}

export function registerGeneratorIpc(): void {
  ipcMain.handle(CH.generatorAbort, () => {
    getGeneratorAbortController()?.abort()
  })

  ipcMain.handle(
    CH.generatorSend,
    async (
      event,
      history: GeneratorMessage[]
    ): Promise<{ ok: boolean; content?: string; error?: string }> => {
      if (!Array.isArray(history) || history.length === 0) {
        return { ok: false, error: '对话历史不能为空' }
      }
      if (!isConfigured()) {
        return { ok: false, error: '尚未配置可用的在线模型，请先在「设置」中添加' }
      }
      if (getGeneratorAbortController()) {
        return { ok: false, error: '当前有正在生成的回复，请先停止' }
      }

      // 最后一条为用户消息，其余作为历史
      const last = history[history.length - 1]
      if (last.role !== 'user') {
        return { ok: false, error: '最后一条消息应为用户输入' }
      }
      const historyMsgs: ChatMessage[] = history
        .slice(0, -1)
        .map((m, i) => ({
          id: Date.now() + i,
          role: m.role,
          content: m.content,
          createdAt: new Date().toISOString()
        }))

      const abort = new AbortController()
      setGeneratorAbortController(abort)
      const systemPrompt = buildGeneratorSystemPrompt()
      let full = ''

      try {
        const reply = await generateReplyWithSystemPrompt(
          systemPrompt,
          historyMsgs,
          last.content,
          (token) => {
            full += token
            sendGeneratorEvent(event, { type: 'token', token })
          },
          abort.signal
        )
        sendGeneratorEvent(event, { type: 'done', content: reply })
        return { ok: true, content: reply }
      } catch (error) {
        if (abort.signal.aborted) {
          sendGeneratorEvent(event, { type: 'aborted', content: full })
          return { ok: false, content: full }
        }
        const message = error instanceof Error ? error.message : String(error)
        sendGeneratorEvent(event, { type: 'error', error: message })
        return { ok: false, error: message }
      } finally {
        if (getGeneratorAbortController() === abort) setGeneratorAbortController(undefined)
      }
    }
  )
}
