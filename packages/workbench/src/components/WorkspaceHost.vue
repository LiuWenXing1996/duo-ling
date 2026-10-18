<script setup lang="ts">
// 工作区多标签宿主：渲染开着的标签页（标签种类见 types/tab 的 WorkspaceTabKind）。
import { computed, ref } from 'vue'
import { AlertTriangle as UiAlertTriangle } from '@lucide/vue'
import SettingsPanel from './SettingsPanel.vue'
import GuidePanel from './GuidePanel.vue'
import HelpPanel from './HelpPanel.vue'
import WorkspaceTabs from './WorkspaceTabs.vue'
import UserscriptListPanel from './userscript/UserscriptListPanel.vue'
import UserscriptEditorPanel from './userscript/UserscriptEditorPanel.vue'
import LfsBrowserPanel from './userscript/LfsBrowserPanel.vue'
import UserscriptHistoryPanel from './userscript/UserscriptHistoryPanel.vue'
import ConfirmDialog from './ConfirmDialog.vue'
import SessionHistoryTab from './SessionHistoryTab.vue'
import AgentToolsPanel from './AgentToolsPanel.vue'
import GmApiPanel from './GmApiPanel.vue'
import TabActivityPanel from './TabActivityPanel.vue'
import type { WorkspaceTab } from '../types/tab'
import type { WorkspaceTabKind } from '../types/tab'
import {
  Tabs as UiTabs,
  TabsContent as UiTabsContent
} from '@duoling/ui/components/ui/tabs'

// 默认标签页：脚本列表（脚本管理唯一入口）。该基础标签不可关闭，保证工作台始终有落点。
const LIST_TAB_ID = 'userscript-list'
const DEFAULT_TAB: WorkspaceTab = { kind: 'userscript-list', id: LIST_TAB_ID, title: '脚本列表' }
const openTabs = ref<WorkspaceTab[]>([DEFAULT_TAB])
const activeTabId = ref(LIST_TAB_ID)

function activate(id: string): void {
  activeTabId.value = id
}

/** 编辑器标签的未保存状态（key = 标签 id）。编辑器内容区不自带关闭按钮，关闭统一走标签栏，
 *  因此「有未保存改动」的确认挪到这里，由编辑器通过 @dirty 上报。 */
const dirtyTabs = ref<Record<string, boolean>>({})

/** 编辑器标签 id 前缀（`us-edit:<uuid>`）：宿主内多处按 id 反查，集中一处免得手写前缀漂移 */
const EDITOR_TAB_PREFIX = 'us-edit:'
function editorTabId(uuid: string): string {
  return `${EDITOR_TAB_PREFIX}${uuid}`
}

/** 有未保存改动的标签 id：标签栏据此在标题后点红点（切到别的标签也看得见） */
const dirtyTabIds = computed(() => Object.keys(dirtyTabs.value).filter((id) => dirtyTabs.value[id]))

/** 编辑器里有未保存改动的脚本 uuid：列表页删脚本、历史面板恢复之前据此示警 */
const dirtyEditorUuids = computed(() =>
  dirtyTabIds.value
    .filter((id) => id.startsWith(EDITOR_TAB_PREFIX))
    .map((id) => id.slice(EDITOR_TAB_PREFIX.length)),
)

/** 某脚本的编辑器标签是否有未保存改动 */
function isEditorDirty(uuid: string): boolean {
  return !!dirtyTabs.value[editorTabId(uuid)]
}

/** 编辑器实例（按脚本 uuid）：关标签之前要能代它保存（「保存并关闭」） */
type EditorHandle = { save: () => Promise<boolean> }
const editorRefs = new Map<string, EditorHandle>()

/** 函数式 ref：恢复后编辑器会换 key 重建，旧实例以 null 回填一次，故两个方向都要处理 */
function setEditorRef(uuid: string, el: unknown): void {
  if (el) editorRefs.set(uuid, el as EditorHandle)
  else editorRefs.delete(uuid)
}

/** 关闭前确认弹窗（有未保存改动的标签先弹，确认后才真正关闭） */
const closeConfirmOpen = ref(false)
const pendingCloseId = ref('')

function closeTab(id: string): void {
  // 基础标签（脚本列表）始终保留，不可关闭
  if (id === LIST_TAB_ID) return
  // 有未保存改动：先弹确认弹窗，确认后才关闭
  if (dirtyTabs.value[id]) {
    pendingCloseId.value = id
    closeConfirmOpen.value = true
    return
  }
  doCloseTab(id)
}

function doCloseTab(id: string): void {
  const idx = openTabs.value.findIndex((t) => t.id === id)
  if (idx === -1) return
  openTabs.value = openTabs.value.filter((t) => t.id !== id)
  delete dirtyTabs.value[id]
  if (activeTabId.value === id) {
    const next = openTabs.value[Math.max(0, idx - 1)] ?? openTabs.value[0]
    activeTabId.value = next?.id ?? ''
  }
}

function confirmCloseTab(): void {
  if (pendingCloseId.value) doCloseTab(pendingCloseId.value)
}

/**
 * 保存并关闭：把改动交给该脚本的编辑器自己保存（草稿只在它手里），落盘成功才关标签。
 * 保存失败（写盘 / IPC 报错）就停在编辑器上——错误条在那里，把标签关掉反而看不见原因。
 */
async function saveAndCloseTab(): Promise<void> {
  const id = pendingCloseId.value
  pendingCloseId.value = ''
  if (!id) return
  const uuid = openTabs.value.find((t) => t.id === id)?.userscriptId ?? ''
  const handle = uuid ? editorRefs.get(uuid) : undefined
  // 拿不到实例（异常路径：标签已不在 / 组件未挂载）时按普通关闭执行——用户在这个弹窗里
  // 已经明确要关了，再弹一次确认只是打转
  if (!handle || (await handle.save())) doCloseTab(id)
}

// 打开引导标签页：若已打开则激活，否则新开一个（全局仅一个）。
// 这是「需要开权限」类提示的统一去处——脚本列表横幅、编辑器保存警告、对话界面错误条都指向它，
// 完整步骤与「打开扩展管理页」按钮只此一份（文案见 lib/extension-page.ts）。
function openGuideTab(): void {
  if (!openTabs.value.some((t) => t.kind === 'guide')) {
    openTabs.value.push({ kind: 'guide', id: 'guide', title: '引导' })
  }
  activate('guide')
}

// 打开帮助标签页：内置使用说明（全局仅一个）。左侧导航的「帮助」按钮与 `#/help` 深链都到这里。
// 正文与目录都在包内（lib/help/），离线可读 —— 不依赖任何远程文档。
function openHelpTab(): void {
  if (!openTabs.value.some((t) => t.kind === 'help')) {
    openTabs.value.push({ kind: 'help', id: 'help', title: '帮助' })
  }
  activate('help')
}

// 打开设置标签页：若已打开则激活，否则新开一个
function openSettingsTab(): void {
  if (!openTabs.value.some((t) => t.kind === 'settings')) {
    openTabs.value.push({ kind: 'settings', id: 'settings', title: '设置' })
  }
  activate('settings')
}

// 打开某调试面板标签页：全局仅一个，已打开则激活。入口只在「设置 · 开发者」分区里给，
// 不占左侧导航 —— 面板清单与标题见 DevModeSection（title 由它一并传来）。
function openDevTab(kind: WorkspaceTabKind, title: string): void {
  if (!openTabs.value.some((t) => t.kind === kind)) {
    openTabs.value.push({ kind, id: kind, title })
  }
  activate(kind)
}

// 打开脚本列表标签页：若已打开则激活，否则新开一个。
function openUserscriptListTab(): void {
  if (!openTabs.value.some((t) => t.kind === 'userscript-list')) {
    openTabs.value.push({ kind: 'userscript-list', id: 'userscript-list', title: '脚本列表' })
  }
  activate('userscript-list')
}

// 打开会话历史标签页：回看/管理历史会话（列表 + 回放 / 原始数据双视图），全局仅一个。
// 对话界面（网页浮层）的会话归属由标签页决定，历史会话的入口收在这里。
function openSessionHistoryTab(): void {
  if (!openTabs.value.some((t) => t.kind === 'session-history')) {
    openTabs.value.push({ kind: 'session-history', id: 'session-history', title: '会话历史' })
  }
  activate('session-history')
}

// 打开活动历史标签页：以**标签页**为主线的历史视图（左栏标签页列表 + 右栏该页活动时间线），
// 全局仅一个。运行与错误的唯一 UI 落点 —— 没开活动记录的页归「未知标签页」那一档。
function openTabActivityTab(): void {
  if (!openTabs.value.some((t) => t.kind === 'tab-activity')) {
    openTabs.value.push({ kind: 'tab-activity', id: 'tab-activity', title: '活动历史' })
  }
  activate('tab-activity')
}

// 打开文件管理标签页：duoling-fs 整库的只读文件树（脚本源码 + 对话图片资源），全局仅一个。
// 它是唯一一个占左侧导航的调试类面板 —— 其余调试面板的入口仍在「设置 · 开发者」里（见 DevModeSection）。
function openLfsTab(): void {
  if (!openTabs.value.some((t) => t.kind === 'lfs-browser')) {
    openTabs.value.push({ kind: 'lfs-browser', id: 'lfs-browser', title: '文件管理' })
  }
  activate('lfs-browser')
}

// 打开某脚本的历史标签页：每脚本一个（id = us-history:<uuid>），已打开则激活复用。
// 编辑器顶栏的历史按钮经 @open-history 走到这里；浏览 + 恢复都在这个标签页里。
function openUserscriptHistoryTab(uuid: string, title: string): void {
  const id = `us-history:${uuid}`
  if (!openTabs.value.some((t) => t.id === id)) {
    openTabs.value.push({
      kind: 'script-history',
      id,
      title: `${title || '脚本'} 历史`,
      userscriptId: uuid
    })
  }
  activate(id)
}

/** 恢复完成后的编辑器/产物页重载序号：key 变更强制 remount，重新拉取已恢复的项目数据 */
const editorReloadTick = ref<Record<string, number>>({})

function onHistoryRestored(uuid: string): void {
  // 先清脏标记再重载 —— 恢复后编辑态里的未保存改动已无意义，不该再弹确认
  // （草稿会丢这件事已在恢复确认弹窗里示警，见 UserscriptHistoryPanel 的 editorDirty）
  delete dirtyTabs.value[editorTabId(uuid)]
  editorReloadTick.value[uuid] = (editorReloadTick.value[uuid] ?? 0) + 1
}

/**
 * 标签标题跟随脚本名更新：脚本可以在别处被改名（列表页「重命名」），编辑器 / 历史标签的
 * 标题不该停在打开时那个旧名。标题一律由宿主拼（面板只回报名字，不各自拼一份）。
 */
function syncScriptTabTitle(tabId: string, name: string): void {
  const tab = openTabs.value.find((t) => t.id === tabId)
  if (!tab || !name) return
  tab.title = tab.kind === 'script-history' ? `${name} 历史` : name
}

/** 打开某脚本的编辑器标签页：每脚本一个（id = us-edit:<uuid>），已打开则激活复用 */
function openUserscriptEditor(uuid: string, title: string): void {
  const id = editorTabId(uuid)
  if (!openTabs.value.some((t) => t.id === id)) {
    openTabs.value.push({
      kind: 'userscript-edit',
      id,
      title: title || '脚本编辑',
      userscriptId: uuid
    })
  }
  activate(id)
}

/**
 * 脚本被删除（列表页广播）：关掉它可能开着的编辑器标签页。
 * 先清脏标记再关 —— 脚本连 git 仓都被删了，未保存的改动已无处可存，不该再弹确认。
 */
function onUserscriptDeleted(uuid: string): void {
  for (const id of [editorTabId(uuid)]) {
    delete dirtyTabs.value[id]
    if (openTabs.value.some((t) => t.id === id)) closeTab(id)
  }
}

// 暴露给根布局：左侧导航栏「设置 / 脚本列表 / 活动历史 / 文件管理 / 会话历史 / 帮助」与脚本管理器的「编辑」入口。
// 其余调试面板不走这里 —— 它们的入口在设置分区里，经 @open-tab 到 openDevTab
defineExpose({ openGuideTab, openHelpTab, openSettingsTab, openUserscriptListTab, openSessionHistoryTab, openTabActivityTab, openLfsTab, openUserscriptEditor })
</script>

<template>
  <div class="workspace-host">
    <!-- 标签栏 + 内容面板：使用 shadcn Tabs（标签种类见 types/tab 的 WorkspaceTabKind） -->
    <ui-tabs
      v-model="activeTabId"
      :default-value="LIST_TAB_ID"
      activation-mode="manual"
      :unmount-on-hide="false"
      class="flex min-h-0 flex-1 flex-col"
    >
      <workspace-tabs
        v-if="openTabs.length"
        :tabs="openTabs"
        :active-id="activeTabId"
        :pinned-tab-id="LIST_TAB_ID"
        :dirty-tab-ids="dirtyTabIds"
        @close="closeTab"
      />

      <ui-tabs-content
        v-for="tab in openTabs"
        :key="tab.id"
        :value="tab.id"
        class="relative mt-0 min-h-0 flex-1"
      >
        <!-- 引导标签：需要用户去浏览器里开权限/开关的说明与直达入口（全局唯一） -->
        <guide-panel v-if="tab.kind === 'guide'" />
        <!-- 帮助标签：内置使用说明，正文与目录都在包内（全局唯一） -->
        <help-panel v-else-if="tab.kind === 'help'" />
        <!-- 设置标签：渲染设置面板；面板里的「引导」与调试面板入口都由宿主接住切标签页 -->
        <settings-panel
          v-else-if="tab.kind === 'settings'"
          @open-guide="openGuideTab"
          @open-tab="openDevTab"
        />
        <!-- 脚本列表：列出全部用户脚本 + 启停；「编辑」开对应的编辑器标签页 -->
        <userscript-list-panel
          v-else-if="tab.kind === 'userscript-list'"
          :dirty-uuids="dirtyEditorUuids"
          @edit="openUserscriptEditor"
          @deleted="onUserscriptDeleted"
          @open-guide="openGuideTab"
        />
        <!-- 用户脚本编辑器：每脚本一个标签页；脏状态上报给 closeTab 做关闭前确认；
             历史按钮请求开历史标签页；恢复完成后 editorReloadTick 变更强制重载编辑态 -->
        <userscript-editor-panel
          v-else-if="tab.kind === 'userscript-edit'"
          :key="tab.id + ':' + (editorReloadTick[tab.userscriptId ?? ''] ?? 0)"
          :ref="(el) => setEditorRef(tab.userscriptId ?? '', el)"
          :uuid="tab.userscriptId ?? ''"
          @dirty="(v: boolean) => (dirtyTabs[tab.id] = v)"
          @open-history="openUserscriptHistoryTab"
          @open-guide="openGuideTab"
          @name-change="(name) => syncScriptTabTitle(tab.id, name)"
        />
        <!-- 文件管理：脚本源码与对话图片的整库只读文件树 -->
        <lfs-browser-panel v-else-if="tab.kind === 'lfs-browser'" />
        <!-- 会话历史：回看历史会话（列表 + 回放 / 原始数据双视图）、改名 / 删除 -->
        <session-history-tab v-else-if="tab.kind === 'session-history'" />
        <!-- AI 工具：agent 工具契约（与模型所见同源）+ 会话库里的真实调用轨迹 -->
        <agent-tools-panel v-else-if="tab.kind === 'agent-tools'" />
        <!-- GM API：脚本作用域里 GM 的能力速查（纯静态目录，与注入真身同源） -->
        <gm-api-panel v-else-if="tab.kind === 'gm-api'" />
        <!-- 活动历史：以标签页为主线的历史视图（左栏标签页列表 + 右栏该页活动时间线，全局仅一个） -->
        <tab-activity-panel v-else-if="tab.kind === 'tab-activity'" />
        <!-- 脚本历史：每脚本一个标签页，浏览 + 恢复；恢复后重载对应编辑器 -->
        <userscript-history-panel
          v-else-if="tab.kind === 'script-history'"
          :key="tab.id"
          :uuid="tab.userscriptId ?? ''"
          :editor-dirty="isEditorDirty(tab.userscriptId ?? '')"
          @restored="onHistoryRestored"
          @name-change="(name) => syncScriptTabTitle(tab.id, name)"
        />
      </ui-tabs-content>
    </ui-tabs>

    <!-- 关闭有未保存改动标签页前的确认弹窗：「会丢」这条做成警示块（与历史恢复弹窗同一处理），
         并多给一条「保存并关闭」—— 否则想留住改动只能取消 → 手点保存 → 再关一次 -->
    <ConfirmDialog
      v-model:open="closeConfirmOpen"
      title="有未保存的修改"
      confirm-text="关闭"
      alternative-text="保存并关闭"
      danger
      @confirm="confirmCloseTab"
      @alternative="saveAndCloseTab"
    >
      <div
        class="mt-3 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
      >
        <ui-alert-triangle class="mt-px size-3.5 shrink-0" />
        <span>关闭后未保存的修改将丢失。</span>
      </div>
    </ConfirmDialog>
  </div>
</template>

<style scoped lang="less">
.workspace-host {
  display: flex;
  flex-direction: column;
  // 作为 .workspace-panel--grow（flex 行容器）的 item，必须 grow 才能填满宽度，
  // 否则宽度会跟随内容：内容变窄时（如 Markdown 页）右侧留白
  flex: 1;
  min-width: 0;
  height: 100%;
  min-height: 0;
  background: var(--background);
}
</style>
