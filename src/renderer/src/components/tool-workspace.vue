<script setup lang="ts">
import { computed, ref, type Component } from 'vue'
import { Button as UiButton } from '@/components/ui/button'
import {
  FileCode as UiFileCode,
  FileText as UiFileText,
  Gem as UiGem,
  Globe as UiGlobe,
  PenLine as UiPenLine,
  Plus as UiPlus,
  Search as UiSearch,
  Settings as UiSettings,
  Table as UiTable,
  X as UiX
} from '@lucide/vue'
import ToolPage, { type Tool } from './tool-page.vue'

// 工具 id → 图标
const TOOL_ICON: Record<string, Component> = {
  pdf: UiFileText,
  clean: UiTable,
  rename: UiPenLine,
  web: UiGlobe,
  doc: UiFileCode
}

// 占位数据：真实实现会从后端注册表 / 会话历史加载
const TOOLS: Record<string, Tool> = {
  pdf: {
    id: 'pdf',
    name: 'PDF 合并器',
    taskLabel: '生成期 · 任务 T-1024',
    status: '就绪',
    costTime: '5s',
    costMode: 'local',
    modelName: 'deepseek-v4-flash',
    inputTitle: '将文件拖到这里，或点击选择',
    inputHint: '支持 .pdf · 可多选 · 按顺序合并',
    files: [
      { name: '周报_08.pdf', size: '2.1 MB', done: true },
      { name: '周报_15.pdf', size: '1.9 MB', done: true },
      { name: '周报_22.pdf', size: '——（待添加）', done: false }
    ],
    optLabel: '合并模式',
    optOptions: ['整份合并', '抽页合并'],
    optActive: '抽页合并',
    outputLabel: '输出目录',
    outputValue: '~/桌面/合并输出/',
    sessions: [
      { id: 's1', status: 'doing', title: '新增抽页合并', meta: '分支 feat/extract-page · 3 次 commit' },
      { id: 's2', status: 'done', title: '抽页合并 v1.3', meta: '标签 v1.3 · 08-20' },
      { id: 's3', status: 'rollback', title: '排序规则优化', meta: '分支已丢弃 · 08-12' },
      { id: 's4', status: 'done', title: '初版合并器 v1.0', meta: '标签 v1.0 · 07-30' }
    ],
    chat: [
      { id: 'a1', role: 'ai', content: '已识别意图：把若干 PDF 的第 3 页抽出来，再合并成一个新 PDF。', meta: 'via scenario: pdf.extract+merge' },
      { id: 'u1', role: 'user', content: '对，整份的不要，我要每个都抽第 3 页。' },
      { id: 'a2', role: 'ai', content: '明白。已在分支 feat/extract-page 上调好后端编排，并补上前端「抽页合并」选项。要我把这版固化为 v1.4 吗？' }
    ],
    capabilities: ['local.file.choose', 'pdf.extract_page', 'pdf.merge', 'local.file.save'],
    previewText: '合并完成 · merged.pdf · 12 页 · 一键下载',
    costNote: '该能力含联网 / 耗 token 步骤，需提前展示并确认'
  },
  clean: {
    id: 'clean',
    name: '表格清洗',
    taskLabel: '维护期 · 任务 T-1031',
    status: '就绪',
    costTime: '10s',
    costMode: 'local',
    modelName: 'deepseek-v4-flash',
    inputTitle: '拖入 CSV / xlsx 进行清洗',
    inputHint: '可多选 · 自动识别表头',
    sessions: [
      { id: 'c1', status: 'doing', title: '修复列去重误删', meta: '分支 fix/dedup · 2 次 commit' },
      { id: 'c2', status: 'done', title: '去重规则 v0.9', meta: '标签 v0.9 · 08-18' }
    ],
    chat: [
      { id: 'a1', role: 'ai', content: '已定位：去重逻辑把「完全相同的行」也当成重复删掉了。是在分支 fix/dedup 上调策略，还是先看影响样本？', meta: 'via scenario: data.clean' },
      { id: 'u1', role: 'user', content: '先看样本。' },
      { id: 'a2', role: 'ai', content: '已列出 23 行去重记录，其中 7 行可能是误删。要我按「非空列全相等才算重复」收紧吗？' }
    ],
    capabilities: ['local.file.choose', 'data.load', 'data.clean'],
    previewText: '清洗预览 · 去重 23 行'
  },
  rename: {
    id: 'rename',
    name: '批量重命名',
    taskLabel: '生成期 · 任务 T-1040',
    status: '就绪',
    costTime: '3s',
    costMode: 'local',
    modelName: 'deepseek-v4-flash',
    inputTitle: '选择文件夹进行批量重命名',
    inputHint: '支持正则表达式',
    sessions: [
      { id: 'r1', status: 'done', title: '支持正则 v2.1', meta: '标签 v2.1 · 08-15' },
      { id: 'r2', status: 'doing', title: '预览结果导出', meta: '分支 feat/preview · 进行中' }
    ],
    chat: [
      { id: 'a1', role: 'ai', content: '当前规则会重命名 23 个文件，其中 4 个会覆盖同名文件。需要我先给出覆盖清单吗？', meta: 'via scenario: fs.rename' },
      { id: 'u1', role: 'user', content: '要，列出来我确认。' },
      { id: 'a2', role: 'ai', content: '好——已列出 4 个冲突文件，等你确认后再写盘。这版要不要固化成 v2.2？' }
    ],
    capabilities: ['local.folder.choose', 'fs.match', 'fs.preview'],
    previewText: '规则预览 · 23 个文件将被重命名'
  },
  md: {
    id: 'md',
    name: 'Markdown 渲染器',
    taskLabel: '使用期 · 实时预览',
    status: '就绪',
    costTime: '<1s',
    costMode: 'local',
    modelName: '—',
    inputTitle: '输入 Markdown 内容',
    inputHint: '实时渲染为 HTML 预览 · 支持标题 / 列表 / 代码块',
    sessions: [
      { id: 'm1', status: 'doing', title: '初始草稿', meta: '本机 · 实时渲染' }
    ],
    chat: [],
    capabilities: ['docs.markdown.render'],
    previewText: '在左侧输入 Markdown，点「运行」查看实时渲染结果',
    costNote: '纯本机渲染，不联网、不耗 token',
    mdSource: '# 小班 · Markdown 渲染器\n\n输入 Markdown，点右下角「运行」查看 HTML 预览。\n\n## 能力演示\n\n- 一二三级标题\n- 无序列表\n- **粗体** · *斜体* · `行内代码`\n\n```\n// 代码块\nconst hello = "小班"\n```'
  }
}

// 打开的工具标签（含未定义的占位工具，如 web）
type OpenTool = { id: string; custom?: boolean }
const openTabs = ref<OpenTool[]>([
  { id: 'pdf' },
  { id: 'clean' },
  { id: 'rename' },
  { id: 'md' }
])
const activeTabId = ref('pdf')

const activeTab = computed<OpenTool>(() => openTabs.value.find((t) => t.id === activeTabId.value) ?? openTabs.value[0])
const activeTool = computed<Tool>(() => TOOLS[activeTab.value.id] ?? (toPlaceholderTool(activeTab.value.id) as Tool))

const emit = defineEmits<{ openSettings: [] }>()

// 未注册（占位）工具的显示名，便于演示
const UNREGISTERED_NAMES: Record<string, string> = { web: '网页快照' }

function toolName(id: string): string {
  return TOOLS[id]?.name ?? UNREGISTERED_NAMES[id] ?? id
}

function isToolDefined(id: string): boolean {
  return Boolean(TOOLS[id])
}

function activate(id: string): void {
  activeTabId.value = id
}

function closeTab(id: string): void {
  if (openTabs.value.length <= 1) return
  const idx = openTabs.value.findIndex((t) => t.id === id)
  if (idx === -1) return
  openTabs.value = openTabs.value.filter((t) => t.id !== id)
  if (activeTabId.value === id) {
    const next = openTabs.value[Math.max(0, idx - 1)] ?? openTabs.value[0]
    activeTabId.value = next?.id ?? ''
  }
}

function addTab(): void {
  if (openTabs.value.some((t) => t.id === 'web')) {
    activate('web')
    return
  }
  openTabs.value.push({ id: 'web', custom: true })
  activate('web')
}

// 未注册工具的占位实现
function toPlaceholderTool(id: string): Tool {
  return {
    id,
    name: toolName(id),
    taskLabel: '占位',
    status: '待接入',
    costTime: '—',
    costMode: 'local',
    modelName: 'deepseek-v4-flash',
    inputTitle: '工具尚未打开 / 正在加载',
    inputHint: '真实实现将挂载对应的 WebContentsView 界面',
    sessions: [],
    chat: [],
    capabilities: [],
    previewText: '暂无可预览内容'
  }
}
</script>

<template>
  <div class="tool-workspace">
    <!-- 顶栏：作为无边框窗口的拖拽区，可交互元素需 no-drag -->
    <header class="tool-topbar">
      <div class="flex items-baseline gap-2">
        <span class="flex items-center gap-1.5 text-base font-semibold">
          <ui-gem class="size-4 text-primary" />
          小班
        </span>
        <span class="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
          DUO-LING / TOOL-BENCH
        </span>
      </div>

      <div class="no-drag flex max-w-md flex-1 items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-sm text-muted-foreground">
        <ui-search class="size-4 shrink-0" />
        <input
          class="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          placeholder="全局搜索：工具 / 任务 / 版本…"
        />
        <span class="rounded border border-border bg-muted px-1 font-mono text-[10px]">⌘K</span>
      </div>

      <div class="no-drag ml-auto flex items-center gap-2">
        <ui-button size="sm" class="no-drag">
          <ui-plus class="size-4" />新建工具
        </ui-button>
        <ui-button variant="ghost" size="icon" class="no-drag" aria-label="设置" @click="emit('openSettings')">
          <ui-settings class="size-4" />
        </ui-button>
      </div>
    </header>

    <!-- 标签栏 -->
    <nav class="tool-tabbar" aria-label="工具标签">
      <div
        v-for="tab in openTabs"
        :key="tab.id"
        class="tool-tab"
        :class="{ 'tool-tab--active': tab.id === activeTabId }"
        role="tab"
        :aria-selected="tab.id === activeTabId"
        @click="activate(tab.id)"
      >
        <component :is="TOOL_ICON[tab.id] ?? UiFileText" class="size-3.5 shrink-0" :class="tab.id === activeTabId ? 'text-primary' : ''" />
        <span class="truncate">{{ toolName(tab.id) }}</span>
        <span
          v-if="!isToolDefined(tab.id)"
          class="rounded bg-amber-500/15 px-1 text-[9px] text-amber-700"
          title="占位工具"
        >
          占位
        </span>
        <button
          class="no-drag ml-0.5 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          type="button"
          aria-label="关闭标签"
          @click.stop="closeTab(tab.id)"
        >
          <ui-x class="size-3" />
        </button>
      </div>
      <button type="button" class="tool-tab-add" aria-label="添加工具" @click="addTab">
        <ui-plus class="size-4" />
      </button>
    </nav>

    <!-- 当前工具页 -->
    <div class="min-h-0 flex-1">
      <tool-page :key="activeTab.id" :tool="activeTool" />
    </div>
  </div>
</template>

<style scoped lang="less">
.tool-workspace {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--background);
}

.tool-topbar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 16px;
  height: 46px;
  padding: 0 14px;
  border-bottom: 1px solid var(--border);
  -webkit-app-region: drag;
  user-select: none;
}

.tool-tabbar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 2px;
  height: 40px;
  padding: 0 8px;
  overflow-x: auto;
  border-bottom: 1px solid var(--border);
  background: var(--muted);
}

.tool-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
  height: 100%;
  padding: 0 10px 0 12px;
  font-size: 12.5px;
  color: var(--muted-foreground);
  border-right: 1px solid var(--border);
  transition: background-color 0.15s, color 0.15s;

  &--active {
    color: var(--foreground);
    background: var(--card);
  }

  &:hover {
    color: var(--foreground);
  }
}

.tool-tab-add {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: 0 10px;
  color: var(--muted-foreground);
  transition: color 0.15s;

  &:hover {
    color: var(--primary);
  }
}
</style>
