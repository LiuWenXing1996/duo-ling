<script setup lang="ts">
import { ref } from 'vue'
import ToolPanel from '@/components/tool-panel.vue'

// 右侧栏：工具 / 会话详情 两个 tab
type Tab = 'tools' | 'detail'
const activeTab = ref<Tab>('tools')
</script>

<template>
  <section class="panel">
    <header class="panel-header">
      <div class="detail-tabs no-drag" role="tablist" aria-label="右侧栏切换">
        <button
          class="detail-tab"
          :class="{ active: activeTab === 'tools' }"
          role="tab"
          :aria-selected="activeTab === 'tools'"
          @click="activeTab = 'tools'"
        >
          工具
        </button>
        <button
          class="detail-tab"
          :class="{ active: activeTab === 'detail' }"
          role="tab"
          :aria-selected="activeTab === 'detail'"
          @click="activeTab = 'detail'"
        >
          详情
        </button>
      </div>
    </header>
    <div class="detail-body">
      <tool-panel v-if="activeTab === 'tools'" />
      <div v-else class="detail-empty">
        <p class="panel-empty">暂无会话详情</p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.detail-tabs {
  display: flex;
  gap: 4px;
  padding: 3px;
  border-radius: 8px;
  background-color: var(--muted);
}

.detail-tab {
  padding: 4px 14px;
  border: none;
  border-radius: 6px;
  background: transparent;
  font-size: 12px;
  color: var(--muted-foreground);
  cursor: pointer;
  transition:
    background-color 0.15s,
    color 0.15s;

  &:hover {
    color: var(--foreground);
  }

  &.active {
    background-color: var(--background);
    color: var(--foreground);
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.1);
  }
}

.detail-body {
  display: flex;
  flex: 1;
  min-height: 0;
  padding: 12px 16px;
  overflow: hidden;
}

.detail-empty {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
}
</style>
