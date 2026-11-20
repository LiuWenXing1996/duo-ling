<script setup lang="ts">
// 对话宿主：一份对话的数据接线 + 消息区 + 输入区；头行与载体专属能力由载体经 slot / 事件接管（见 ADR 0047）。
import { computed, onMounted, watch } from 'vue'
import { TriangleAlert as UiTriangleAlert } from '@lucide/vue'
import { EXTENSION_NAME } from '@duoling/shared'
import { Button as UiButton } from '@duoling/ui/components/ui/button'
import ChatPanel from './ChatPanel.vue'
import { useGlobalConversation } from '../composables/use-global-conversation'

const props = defineProps<{
  tabId?: number | null
}>()

const emit = defineEmits<{
  streamingChange: [busy: boolean]
  openSettings: []
  openGuide: []
  pickStarted: []
}>()

const {
  conversations,
  activeConversationId,
  messages,
  usageByMessageId,
  orphanTasks,
  chatError,
  streaming,
  loadConversations,
  resolveOrphan,
  send,
  stopGeneration,
} = useGlobalConversation({ tabId: props.tabId })

const title = computed(
  () =>
    conversations.value.find((c) => c.id === activeConversationId.value)?.title || EXTENSION_NAME,
)

watch(streaming, (busy) => emit('streamingChange', busy), { immediate: true })

onMounted(() => {
  void loadConversations()
})
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-background text-foreground">
    <slot name="header" :title="title" :streaming="streaming" />

    <div
      v-if="orphanTasks.length"
      class="shrink-0 border-b border-border bg-amber-500/10 px-3 py-2 text-xs text-foreground"
      data-testid="orphan-banner"
    >
      <div v-for="task in orphanTasks" :key="task.taskId" class="flex items-center gap-2 py-0.5">
        <ui-triangle-alert class="size-3.5 shrink-0 text-amber-600" />
        <span class="min-w-0 flex-1 truncate">
          上次脚本生成中断在第 {{ task.step }} 步，产物尚未保存
        </span>
        <ui-button
          size="xs"
          variant="outline"
          :disabled="streaming"
          @click="void resolveOrphan(task.taskId, 'continue')"
        >
          继续
        </ui-button>
        <ui-button
          size="xs"
          variant="ghost"
          class="text-destructive hover:text-destructive"
          @click="void resolveOrphan(task.taskId, 'discard')"
        >
          丢弃
        </ui-button>
      </div>
    </div>

    <slot name="overlay" />

    <chat-panel
      class="min-h-0 flex-1"
      :messages="messages"
      :usage-by-message-id="usageByMessageId"
      :streaming="streaming"
      :error-text="chatError"
      :page-tab-id="tabId"
      @send="send"
      @stop="stopGeneration"
      @open-settings="emit('openSettings')"
      @open-guide="emit('openGuide')"
      @pick-started="emit('pickStarted')"
    />
  </div>
</template>
