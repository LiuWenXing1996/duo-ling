<script setup lang="ts">
// UI 测试面板：用 mock 数据按「方案 C」预览思考与执行过程的展示效果。
// 方案 C = 单层折叠（整条消息一个 ChainOfThought）+ 折叠内按 step 分组
// （「第 N 步」小标题分隔，不嵌套折叠）+ 最终答案气泡。
// 约定：所有 mock 数据与渲染逻辑集中在本组件内，便于快速调整预览。
import { nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import {
  Brain as UiBrain,
  ChevronsDown as UiChevronsDown,
  CircleCheck as UiCircleCheck,
  CircleX as UiCircleX,
  FileText as UiFileText,
  LoaderCircle as UiLoaderCircle
} from '@lucide/vue'
import {
  ChainOfThought as UiChainOfThought,
  ChainOfThoughtContent as UiChainOfThoughtContent,
  ChainOfThoughtHeader as UiChainOfThoughtHeader,
  ChainOfThoughtStep as UiChainOfThoughtStep
} from '@/components/ai-elements/chain-of-thought'
import {
  Tool as UiTool,
  ToolContent as UiToolContent,
  ToolHeader as UiToolHeader,
  ToolInput as UiToolInput,
  ToolOutput as UiToolOutput
} from '@/components/ai-elements/tool'
import {
  Message as UiMessage,
  MessageContent as UiMessageContent,
  MessageResponse as UiMessageResponse
} from '@/components/ai-elements/message'

// —— mock：一条多步 Agent Loop 的 assistant 消息（parts 顺序 = 实际流式到达顺序）——
// step-start 为 AI SDK 生成的 step 边界标记（每步一次 gen reply）
type MockToolState = 'input-streaming' | 'input-available' | 'output-available' | 'output-error'
type MockPart =
  | { type: 'reasoning'; text: string }
  | { type: 'step-start' }
  | { type: 'text'; text: string }
  | {
      type: `tool-${string}`
      toolCallId: string
      state: MockToolState
      title: string
      input?: unknown
      output?: unknown
      errorText?: string
    }

// 超长思考样本：用于验证长思考在卡片内的内部滚动（max-h-64 overflow-y-auto）效果
const LONG_THINKING = `先整体过一遍需求：用户想了解项目结构，需要先确认有哪些工具、每个工具的能力边界，再决定从哪个工具入手。
这一步我把候选工具逐项对比：
- MD 阅读器：包含解析与渲染两个模块，覆盖 Markdown 的读取、AST 转换与 HTML 输出；
- 代码浏览器：偏源码浏览，不适合直接回答"结构"类问题；
- 数据查看器：用于查看数据区，与本需求关联较弱。

结合以上对比，MD 阅读器最贴合，接下来需要确认它的内部实现：解析器如何把 Markdown 分词成块、渲染器如何处理嵌套列表与代码块、以及对外暴露了哪些接口。
同时还要注意边界情况：空文件、超长行、非法标签分别会走到哪条分支，避免遗漏。
（这段思考故意拉长，用于验证长思考内容在卡片内部滚动展示的效果。）`.trim()

const mockParts: MockPart[] = [
  // step 1：思考 + 中间正文 + 查询工具列表（正文在 step 中间：先说明要做什么，再调工具）
  { type: 'reasoning', text: '用户想了解项目结构，我先看看当前有哪些可用工具。' },
  { type: 'text', text: `当前共有 7 个工具，我按与需求的关联度排了一下：
- MD 阅读器：支持 Markdown 的读取、AST 转换与 HTML 输出，最贴合；
- 代码浏览器：偏源码浏览，适合排查实现细节；
- 数据查看器：用于查看工具数据区，与本需求关联较弱。

接下来我准备打开 MD 阅读器，确认它的解析与渲染模块的具体实现。` },
  {
    type: 'tool-agent_tools_list',
    toolCallId: 'tc-1',
    state: 'output-available',
    title: '查询工具列表',
    input: { type: 'all' },
    output: `[
  { "id": "md-reader", "title": "MD 阅读器", "description": "支持 Markdown 的读取、AST 转换与 HTML 输出" },
  { "id": "code-browser", "title": "代码浏览器", "description": "浏览项目源码与文件结构" },
  { "id": "data-viewer", "title": "数据查看器", "description": "查看工具数据区（键 / 大小 / 时间）" },
  { "id": "tool-creator", "title": "工具创建器", "description": "按模板生成新工具页面" },
  { "id": "tool-archiver", "title": "工具档案", "description": "管理与编辑工具的归档说明" },
  { "id": "history-browser", "title": "版本历史", "description": "查看工具页面的 git 提交记录" },
  { "id": "settings", "title": "设置", "description": "模型配置与应用偏好设置" }
]`
  },
  // step 2：短思考 + 超长思考 + 短中间正文 + 打开工具（验证短正文不折叠：header 无 chevron）
  { type: 'step-start' },
  { type: 'reasoning', text: 'MD 阅读器包含解析与渲染两个模块，先打开确认实现细节。' },
  { type: 'reasoning', text: LONG_THINKING },
  { type: 'text', text: '我来打开这个工具。' },
  {
    type: 'tool-agent_tools_open',
    toolCallId: 'tc-2',
    state: 'output-available',
    title: '打开工具',
    input: { path: 'src/reader.ts' },
    output: '已打开 MD 阅读器（解析模块 + 渲染模块）'
  },
  // step 3：思考 + 最终答案
  { type: 'step-start' },
  { type: 'reasoning', text: '结构已清楚：解析模块负责 Markdown → AST，渲染模块负责 AST → HTML。可以回答用户了。' },
  { type: 'text', text: '你的项目结构如下：**MD 阅读器**由「解析」与「渲染」两个模块组成——解析模块负责把 Markdown 转成 AST，渲染模块再把 AST 输出为 HTML。整体职责清晰，扩展新格式时只需新增解析器即可。' }
]

// —— 方案 C 的分组逻辑：按 step-start 切块，最终答案 = 最后一段 text（留在气泡），其余归链 ——
type Node =
  | { kind: 'thinking'; key: string; text: string }
  | {
      kind: 'tool'
      key: string
      partType: `tool-${string}`
      state: MockToolState
      title: string
      input: unknown
      output: unknown
      errorText?: string
    }
  | { kind: 'text'; key: string; text: string }

function buildStepGroups(): Node[][] {
  const groups: Node[][] = []
  let cur: Node[] = []
  let key = 0
  const textParts = mockParts.filter((p): p is Extract<MockPart, { type: 'text' }> => p.type === 'text')
  const lastTextPart = textParts[textParts.length - 1]
  for (const part of mockParts) {
    if (part.type === 'step-start') {
      groups.push(cur)
      cur = []
      continue
    }
    if (part.type === 'reasoning' && part.text.trim()) {
      cur.push({ kind: 'thinking', key: `r-${key++}`, text: part.text })
    } else if ('toolCallId' in part) {
      cur.push({
        kind: 'tool',
        key: `t-${key++}`,
        partType: part.type,
        state: part.state,
        title: part.title,
        input: part.input,
        output: part.output,
        errorText: part.errorText
      })
    } else if (part.type === 'text' && part !== lastTextPart && part.text.trim()) {
      cur.push({ kind: 'text', key: `x-${key++}`, text: part.text })
    }
  }
  groups.push(cur)
  return groups.filter((g) => g.length > 0)
}

const stepGroups = buildStepGroups()

// —— 长思考折叠：思考超过阈值高度默认截断 + 「展开全部」按钮，可手动展开/收起 ——
/** 思考折叠阈值高度（px） */
const THINK_COLLAPSE_THRESHOLD = 160

/** 每个思考容器对应的 DOM 引用（用于测量实际内容高度） */
const thinkEls = new Map<string, HTMLDivElement>()
/** 被判定为「长思考」的节点 key 集合 */
const longThinks = reactive(new Set<string>())
/** 用户已手动展开的思考节点 key 集合 */
const expandedThinks = reactive(new Set<string>())

/** 生成 ref 收集函数：元素挂载写入 Map，卸载移除 */
function makeCollectRef(els: Map<string, HTMLDivElement>): (key: string) => (el: unknown) => void {
  return (key: string) => (el: unknown) => {
    if (el) els.set(key, el as HTMLDivElement)
    else els.delete(key)
  }
}

const collectThinkRef = makeCollectRef(thinkEls)

/** 重新测量所有已渲染思考容器：超过阈值标记为「长思考」（已展开/已标记的跳过） */
function measureThinks(): void {
  for (const [key, el] of thinkEls) {
    if (expandedThinks.has(key) || longThinks.has(key)) continue
    // 测量时容器未加 max-h（未标记），scrollHeight 即全文高度
    if (el.scrollHeight > THINK_COLLAPSE_THRESHOLD) longThinks.add(key)
  }
}

onMounted(() => {
  void nextTick(() => {
    measureThinks()
    measureTexts()
  })
})

/** 该思考是否处于折叠态（长思考且未展开） */
function isThinkCollapsed(key: string): boolean {
  return longThinks.has(key) && !expandedThinks.has(key)
}

/** 切换长思考的展开/收起 */
function toggleThink(key: string): void {
  if (expandedThinks.has(key)) expandedThinks.delete(key)
  else expandedThinks.add(key)
}

// —— 中间正文折叠：与思考一致，超过阈值截断 + 「展开全部」 ——
/** 中间正文容器引用 */
const textEls = new Map<string, HTMLDivElement>()
/** 被判定为「长中间正文」的节点 key 集合 */
const longTexts = reactive(new Set<string>())
/** 用户已手动展开的中间正文节点 key 集合 */
const expandedTexts = reactive(new Set<string>())

const collectTextRef = makeCollectRef(textEls)

/** 重新测量所有已渲染中间正文容器：超过阈值标记为「长内容」（已展开/已标记的跳过） */
function measureTexts(): void {
  for (const [key, el] of textEls) {
    if (expandedTexts.has(key) || longTexts.has(key)) continue
    if (el.scrollHeight > THINK_COLLAPSE_THRESHOLD) longTexts.add(key)
  }
}

/** 该中间正文是否处于折叠态（长内容且未展开） */
function isTextCollapsed(key: string): boolean {
  return longTexts.has(key) && !expandedTexts.has(key)
}

/** 切换中间正文的展开/收起 */
function toggleText(key: string): void {
  if (expandedTexts.has(key)) expandedTexts.delete(key)
  else expandedTexts.add(key)
}

// —— 前端 mock 流式输出：把链上节点展平成流式序列，逐 tick 打字机推进 ——
interface StreamTool {
  partType: `tool-${string}`
  state: MockToolState
  title: string
  input: unknown
  output: unknown
  errorText?: string
}
interface StreamNode {
  key: string
  kind: 'thinking' | 'tool' | 'text' | 'continue'
  /** 文本类节点的全文（thinking/text） */
  text?: string
  /** 流式总长度：文本类为文本长度，工具/继续流程为 1（到达即完整） */
  len: number
  /** 已流式的字符数 */
  chars: number
  /** 工具节点展示数据 */
  tool?: StreamTool
}

/** 把 step 分组展平为流式节点序列（step 边界处插入「继续流程」节点） */
function buildStreamNodes(): StreamNode[] {
  const nodes: StreamNode[] = []
  stepGroups.forEach((group, gi) => {
    if (gi > 0) nodes.push({ key: `c-${gi}`, kind: 'continue', len: 1, chars: 0 })
    for (const node of group) {
      if (node.kind === 'thinking') {
        nodes.push({ key: node.key, kind: 'thinking', text: node.text, len: node.text.length, chars: 0 })
      } else if (node.kind === 'tool') {
        nodes.push({
          key: node.key,
          kind: 'tool',
          len: 1,
          chars: 0,
          tool: {
            partType: node.partType,
            state: node.state,
            title: node.title,
            input: node.input,
            output: node.output,
            errorText: node.errorText
          }
        })
      } else {
        nodes.push({ key: node.key, kind: 'text', text: node.text, len: node.text.length, chars: 0 })
      }
    }
  })
  return nodes
}

const streamNodes = reactive(buildStreamNodes())
// 初始默认完整显示（模拟「已生成完」），点「模拟流式」才从头打字机播放
for (const n of streamNodes) n.chars = n.len

const STREAM_TICK_MS = 30
const STREAM_CHARS_PER_TICK = 3
const streaming = ref(false)
let streamTimer: ReturnType<typeof setInterval> | undefined

/** 从头开始模拟流式：重置全部节点进度与折叠状态，逐 tick 打字机推进 */
function playStream(): void {
  for (const n of streamNodes) n.chars = 0
  longThinks.clear()
  expandedThinks.clear()
  longTexts.clear()
  expandedTexts.clear()
  if (streamTimer !== undefined) clearInterval(streamTimer)
  streaming.value = true
  streamTimer = setInterval(() => {
    const next = streamNodes.find((n) => n.chars < n.len)
    if (!next) {
      stopStream()
      return
    }
    next.chars = Math.min(next.len, next.chars + STREAM_CHARS_PER_TICK)
  }, STREAM_TICK_MS)
}

function stopStream(): void {
  if (streamTimer !== undefined) {
    clearInterval(streamTimer)
    streamTimer = undefined
  }
  streaming.value = false
}

onUnmounted(stopStream)

// 流式推进导致思考 / 中间正文文本变长 → 重新测量是否超阈值折叠
watch(
  streamNodes,
  () => {
    void nextTick(() => {
      measureThinks()
      measureTexts()
    })
  },
  { deep: true }
)

// 最终答案：整条消息最后一段 text（方案 C 中即最后一个 step 的最后正文）
const finalText = (() => {
  const texts = mockParts.filter((p): p is Extract<MockPart, { type: 'text' }> => p.type === 'text')
  return texts.length ? texts[texts.length - 1].text : ''
})()

/** 工具步骤状态 → ChainOfThoughtStep 步骤状态（入参流式生成中视为 active，其余视为完成） */
function stepStatus(state: MockToolState): 'complete' | 'active' {
  return state === 'input-streaming' ? 'active' : 'complete'
}
</script>

<template>
  <section class="ui-test-panel">
    <div class="min-h-0 flex-1 overflow-y-auto scroll-gap p-6">
      <div class="mx-auto max-w-2xl space-y-4">
        <div>
          <h2 class="text-lg font-semibold">UI 测试 · 方案 C</h2>
          <p class="mt-1 text-xs text-muted-foreground">
            单层折叠 + 内部按 step 分组（「第 N 步」小标题分隔）· 全部为 mock 数据
          </p>
          <button
            type="button"
            class="mt-3 rounded-md border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
            @click="playStream"
          >
            {{ streaming ? '流式中…' : '▶ 模拟流式' }}
          </button>
        </div>

        <!-- 模拟对话：用户消息 -->
        <ui-message :from="'user'" class="max-w-full">
          <ui-message-content>介绍一下这个项目的结构</ui-message-content>
        </ui-message>

        <!-- 模拟对话：assistant 消息（方案 C 渲染） -->
        <div class="flex flex-col items-start gap-1.5">
          <ui-chain-of-thought :default-open="true" class="w-full min-w-0">
            <ui-chain-of-thought-header>思考过程</ui-chain-of-thought-header>
            <ui-chain-of-thought-content class="pl-4">
              <template v-for="node in streamNodes" :key="node.key">
                <!-- step 边界「继续流程」节点（流式到达后淡入） -->
                <ui-chain-of-thought-step
                  v-if="node.kind === 'continue' && node.chars > 0"
                  label="继续流程"
                  class="w-full min-w-0"
                >
                  <template #icon>
                    <ui-chevrons-down class="size-4 shrink-0 text-muted-foreground" />
                  </template>
                  <div class="text-sm leading-relaxed text-muted-foreground">接下来继续分析</div>
                </ui-chain-of-thought-step>
                <!-- 思考节点 -->
                <ui-chain-of-thought-step
                  v-else-if="node.kind === 'thinking' && node.chars > 0"
                  label="思考"
                  class="w-full min-w-0"
                >
                  <template #icon>
                    <ui-brain class="size-4 shrink-0 text-muted-foreground" />
                  </template>
                  <!-- 长思考折叠：超过阈值高度的思考截断 + 底部淡出遮罩 + 「展开全部」；短思考直接全文显示 -->
                  <div
                    :ref="collectThinkRef(node.key)"
                    :class="[
                      'relative w-fit min-w-0 max-w-full',
                      isThinkCollapsed(node.key) ? 'max-h-40 overflow-hidden' : '',
                    ]"
                  >
                    <ui-message-response
                      :content="node.text!.slice(0, node.chars)"
                      class="text-sm leading-relaxed text-muted-foreground/70! [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5 [&_li]:my-1 [&_p]:my-1 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0"
                    />
                    <!-- 折叠遮罩：底部淡出，营造内容被「盖住」的效果 -->
                    <div
                      v-if="isThinkCollapsed(node.key)"
                      class="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-background from-40% to-transparent"
                    />
                  </div>
                  <button
                    v-if="longThinks.has(node.key)"
                    type="button"
                    class="mt-1 inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs text-foreground transition-colors hover:bg-muted/70"
                    @click="toggleThink(node.key)"
                  >
                    {{ expandedThinks.has(node.key) ? '收起' : '展开全部' }}
                  </button>
                </ui-chain-of-thought-step>
                <!-- 工具调用节点 -->
                <ui-chain-of-thought-step
                  v-else-if="node.kind === 'tool' && node.chars > 0"
                  :label="node.tool!.title"
                  :status="stepStatus(node.tool!.state)"
                  class="w-full min-w-0"
                >
                  <template #icon>
                    <ui-loader-circle
                      v-if="node.tool!.state === 'input-streaming'"
                      class="size-4 shrink-0 animate-spin text-muted-foreground"
                    />
                    <ui-circle-x
                      v-else-if="node.tool!.errorText"
                      class="size-4 shrink-0 text-destructive"
                    />
                    <ui-circle-check v-else class="size-4 shrink-0 text-green-600" />
                  </template>
                  <!-- 工具调用节点：用 Tool 自带折叠（header 点击展开/收起），默认收起，展开后全文 -->
                  <ui-tool class="min-w-0" :default-open="false">
                    <ui-tool-header
                      :type="node.tool!.partType"
                      :state="node.tool!.state"
                      :title="node.tool!.title"
                    />
                    <!-- max-h-none 覆盖默认 max-h-80：展开后显示全部高度 -->
                    <ui-tool-content class="max-h-none min-w-0">
                      <ui-tool-input v-if="node.tool!.input != null" :input="node.tool!.input" />
                      <ui-tool-output :output="node.tool!.output" :error-text="node.tool!.errorText" />
                    </ui-tool-content>
                  </ui-tool>
                </ui-chain-of-thought-step>
                <!-- 中间轮正文节点（说明）：与思考一致的折叠（无边框，160px 截断 + 遮罩 + 「展开全部」） -->
                <ui-chain-of-thought-step
                  v-else-if="node.kind === 'text' && node.chars > 0"
                  label="说明"
                  class="w-full min-w-0"
                >
                  <template #icon>
                    <ui-file-text class="size-4 shrink-0 text-muted-foreground" />
                  </template>
                  <div
                    :ref="collectTextRef(node.key)"
                    :class="[
                      'relative w-fit min-w-0 max-w-full',
                      isTextCollapsed(node.key) ? 'max-h-40 overflow-hidden' : '',
                    ]"
                  >
                    <ui-message-response
                      :content="node.text!.slice(0, node.chars)"
                      class="text-sm leading-relaxed text-muted-foreground/70! [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5 [&_li]:my-1 [&_p]:my-1 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0"
                    />
                    <!-- 折叠遮罩：底部淡出，营造内容被「盖住」的效果 -->
                    <div
                      v-if="isTextCollapsed(node.key)"
                      class="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-background from-40% to-transparent"
                    />
                  </div>
                  <button
                    v-if="longTexts.has(node.key)"
                    type="button"
                    class="mt-1 inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs text-foreground transition-colors hover:bg-muted/70"
                    @click="toggleText(node.key)"
                  >
                    {{ expandedTexts.has(node.key) ? '收起' : '展开全部' }}
                  </button>
                </ui-chain-of-thought-step>
              </template>
            </ui-chain-of-thought-content>
          </ui-chain-of-thought>
          <!-- 最终答案气泡 -->
          <ui-message :from="'assistant'" class="max-w-full">
            <ui-message-content>
              <ui-message-response
                :content="finalText"
                class="text-sm leading-relaxed [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5 [&_li]:my-1 [&_p]:my-1"
              />
            </ui-message-content>
          </ui-message>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped lang="less">
// 与设置/开发者面板一致：撑满 tab-content（tab-content 为 relative），否则内部滚动区高度为 auto 无法滚动。
// 必须带 flex 列布局：内部滚动区依赖 flex-1 撑满剩余高度，缺 display:flex 时滚动区高度=内容高度、无法滚动。
.ui-test-panel {
  position: absolute;
  inset: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
</style>
