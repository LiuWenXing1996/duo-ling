// 系统提示组装（从 chat-host 抽出：纯函数、无运行时依赖，便于单测覆盖档位组合）。
//
// 组装顺序（每档独立成块，互不依赖）：
//   基础规范 → dev 例外（仅 DEV 构建）→ 档 0 当前页面 → 档 2 元素拾取摘要 → 续跑说明 → 会话内既有脚本 → 用户需求。
// 摘要层（ElementPickSummary）≤2KB 常驻 prompt，同类计数（命中数）必须在内——
// AI 自证选择器唯一性不该再花一次读取；全量层走 element_read 工具按需读；
// 页面整体结构走 page_snapshot 工具（AI 按需采集，不再常驻/回注 prompt）。
// （拾取器交互与载荷形态，2026-09-17 定稿）

import type { UIMessage } from 'ai'
import type {
  ChatMessageMetadata,
  ElementPickContext,
  MessagePageContext,
  PageContextInfo,
} from '@/shared/extension-ipc'

/** 档 2 摘要层：用户点选元素的摘要（选择器候选 × 命中数 / 关键属性 / 截断样本） */
export function describePickedElement(el: ElementPickContext): string[] {
  const s = el.summary
  const lines: string[] = []
  lines.push(
    `\n用户点选了页面上的一个元素（拾取时刻快照，非实时）：` +
      `<${s.tag}${s.id ? ` id="${s.id}"` : ''}${s.classes.length ? ` class="${s.classes.join(' ')}"` : ''}>`,
  )
  const attrEntries = Object.entries(s.attrs)
  if (attrEntries.length) {
    lines.push('关键属性：' + attrEntries.map(([k, v]) => `${k}="${v}"`).join(' '))
  }
  if (s.selectors.length) {
    lines.push(
      '候选选择器（hitCount = 当前页面命中元素数，1 为唯一）：',
      ...s.selectors.map((c) => `  - ${c.selector}（命中 ${c.hitCount}）`),
    )
  }
  if (s.textSample) lines.push(`文本样本：${s.textSample}`)
  if (s.htmlSample) lines.push(`HTML 片段（截断）：\n${s.htmlSample}`)
  lines.push(
    '写选择器时优先参考命中数为 1 的候选；摘要不够用时用 element_read 读该元素的完整快照（全部属性 / 完整 outerHTML / 祖先链）。',
  )
  return lines
}

/**
 * 历史消息里**最近一次**随消息附上的拾取元素（倒序扫 user 消息，找到即回）。
 * 只认 metadata.pageContext.element、只取最近一份，不做语义匹配——
 * 跨轮指代（「再把字号调大一点」）、重开面板续聊，都靠它。
 * 快照已改 AI 工具采集（2026-09-17），不再认 metadata.snapshot（旧数据的 snapshot 字段直接忽略）。
 */
export function mostRecentPageContext(messages: UIMessage[]): MessagePageContext | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'user') continue
    const ctx = (m.metadata as ChatMessageMetadata | undefined)?.pageContext
    if (ctx?.element) return ctx
  }
  return undefined
}

/**
 * 合并本请求的新鲜上下文（chat:start 带的）与历史最近一次附上的上下文：
 *   · 档 0（URL/标题）只认新鲜的——每轮实时取，历史里的 URL 会过时误导；
 *   · 元素拾取新鲜优先，缺位时回退历史最近一次（≤2KB 摘要，常驻可接受）；
 *   · 快照不再走这条通道（AI 工具按需采集，工具结果只在当轮），一律剥掉。
 */
export function mergePageContext(
  fresh: PageContextInfo | undefined,
  history: MessagePageContext | undefined,
): PageContextInfo | undefined {
  const out: PageContextInfo = { ...(fresh ?? {}) }
  const element = fresh?.element ?? history?.element
  if (element) out.element = element
  else delete out.element
  delete out.snapshot
  return out.url || out.title || out.element ? out : undefined
}

/** 会话内最近一次落盘脚本的身份（从历史 data-generation 卡片摘出，供「改既有脚本」指路） */
export interface PrevGeneratedScript {
  uuid: string
  name: string
}

/**
 * 历史消息里**最近一张**生成卡片的脚本身份（倒序扫 assistant 消息的 data-generation parts）。
 * 卡片随消息落盘且 uuid 唯一，天然就是「本会话生成过哪些脚本」的记录——
 * 没有它，模型拿不到脚本 uuid（script_apply 不回传、卡片是 data part 不进模型），只能新建。
 */
export function mostRecentGeneratedScript(messages: UIMessage[]): PrevGeneratedScript | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'assistant') continue
    for (const p of m.parts) {
      if (p.type !== 'data-generation') continue
      const data = (p as { data?: { uuid?: string; name?: string } }).data
      if (data?.uuid) return { uuid: data.uuid, name: data.name || data.uuid }
    }
  }
  return undefined
}

export function buildSystemPrompt(
  prompt: string,
  pageContext?: PageContextInfo,
  continuing = false,
  prevScript?: PrevGeneratedScript,
): string {
  const lines = [
    '你是「哆灵」浏览器扩展的用户脚本助手。除日常对话外，你可以为网页编写用户脚本：',
    '先用 script_spec 拿规范，再用 script_apply 提交文件树并构建验证（构建失败按诊断修改后整体重交），',
    '构建通过即收敛——落盘、生效与提交说明由系统处理，你不需要也无法自己保存脚本。',
    'matches 默认收窄到目标站点；改既有脚本前先 script_read 读出现有内容。',
    '脚本跑在 USER_SCRIPT 隔离世界，该世界用浏览器默认的严 CSP：**禁止** eval / new Function，',
    '也不要引入内部靠它们动态生成代码的库（如 ajv 的编译校验器、Vue 运行时模板编译器）。',
    '需要动态行为就用普通函数、事件监听或数据驱动写法；提交后才被拦下的脚本会静默失败，很难排查。',
    '需要页面整体结构或更多节点上下文时，用 page_snapshot 工具抓当前页面的渲染后 DOM（按需调用，不必每轮都抓）。',
    '闲聊或与脚本无关的消息只正常回应，**不要**顺手继续此前被停止 / 中断的任务——',
    '历史里可能出现中断的半截工具调用，那是用户主动停止留下的，不代表用户想要你续做；',
    '只有用户新消息里明确要求（如「继续」「把脚本写完」）才继续未完成的脚本工作。',
  ]
  // 测试豁免只进 dev 构建（手测停手机制用），prod 构建里静态消除
  if (import.meta.env.DEV) {
    lines.push(
      '例外：用户明确要求提交注定构建失败的代码（如测试停手机制）时照做——不要"修正"、不要注释掉，',
      '按用户指定的错误原样提交；构建失败后也不要修复、不要自行决定停止或减少提交次数，',
      '每次失败后立即原样重交，直到工具结果里出现 stop:true（那才是系统的停手指令），再如实总结诊断。',
    )
  }
  if (pageContext?.url) {
    lines.push(`\n当前页面：${pageContext.title ? `「${pageContext.title}」` : ''}${pageContext.url}`)
    lines.push('用户很可能在说这个页面；选择器以此站点的真实结构为准，不要凭空猜。')
  }
  if (pageContext?.element) {
    lines.push(...describePickedElement(pageContext.element))
  }
  if (continuing) {
    lines.push('\n注意：此前一次生成任务在浏览器中断了。任务的内存文件树已恢复，' +
      '先 script_read（不带参数）查看已有文件，再决定继续修改还是重写。')
  }
  if (prevScript) {
    lines.push(
      `\n本会话此前落盘过脚本：「${prevScript.name}」（uuid=${prevScript.uuid}）。`,
      '用户要求修改 / 继续调整这个脚本时：先 script_read 该 uuid 读出现有内容再改，' +
        'script_apply 时带 updateUuid=该 uuid（落盘会原地更新它，不产生新脚本）；' +
        '只有用户明确想要另一个新脚本时才省略 updateUuid。',
    )
  }
  lines.push(`\n用户需求：${prompt}`)
  return lines.join('\n')
}
