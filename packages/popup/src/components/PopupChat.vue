<script setup lang="ts">
import { History as UiHistory } from '@lucide/vue'
import { ChatHost } from '@duoling/ui'
import { Button as UiButton } from '@duoling/ui/components/ui/button'
import {
  Tooltip as UiTooltip,
  TooltipContent as UiTooltipContent,
  TooltipProvider as UiTooltipProvider,
  TooltipTrigger as UiTooltipTrigger,
} from '@duoling/ui/components/ui/tooltip'

defineProps<{
  tabId: number | null
}>()

function openWorkbench(hash = ''): void {
  void chrome.tabs.create({ url: chrome.runtime.getURL('workbench.html') + hash })
  window.close()
}
</script>

<template>
  <div
    class="flex h-[350px] min-h-0 flex-col overflow-hidden rounded-md border border-border"
    data-testid="popup-chat"
  >
    <chat-host
      :tab-id="tabId"
      class="min-h-0 flex-1"
      @open-settings="openWorkbench('#/settings')"
      @open-guide="openWorkbench('#/guide')"
    >
      <template #header="{ title, streaming }">
        <div class="flex h-[30px] shrink-0 items-center gap-2 border-b border-border px-2.5">
          <span class="shrink-0 text-xs text-muted-foreground">对话</span>
          <span class="min-w-0 flex-1 truncate text-xs font-medium" :title="title">
            {{ title }}
          </span>
          <span
            v-if="streaming"
            class="flex shrink-0 items-center gap-1"
            data-testid="popup-chat-generating"
          >
            <span class="size-1.5 rounded-full bg-primary" />
            <span class="text-[11px] text-muted-foreground">回话中</span>
          </span>
          <ui-tooltip-provider>
            <ui-tooltip>
              <ui-tooltip-trigger as-child>
                <ui-button
                  variant="ghost"
                  size="icon"
                  class="size-6 shrink-0"
                  aria-label="会话历史"
                  data-testid="popup-chat-history"
                  @click="openWorkbench('#/sessions')"
                >
                  <ui-history class="size-3.5" />
                </ui-button>
              </ui-tooltip-trigger>
              <ui-tooltip-content side="top">会话历史</ui-tooltip-content>
            </ui-tooltip>
          </ui-tooltip-provider>
        </div>
      </template>
    </chat-host>
  </div>
</template>
