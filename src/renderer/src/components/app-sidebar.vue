<script setup lang="ts">
import { ListTodo, MessageCircle, Settings, User } from '@lucide/vue'

interface NavItem {
  id: string
  label: string
  icon: typeof MessageCircle
}

const navItems: NavItem[] = [
  { id: 'chat', label: '对话', icon: MessageCircle },
  { id: 'tasks', label: '任务', icon: ListTodo },
  { id: 'settings', label: '设置', icon: Settings }
]
</script>

<template>
  <nav
    class="flex h-full w-12 flex-col items-center border-r border-border bg-muted/30 py-3"
    aria-label="主导航"
  >
    <div
      class="-webkit-app-region: drag mb-2 flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground"
      aria-hidden="true"
    >
      <svg viewBox="0 0 24 24" fill="none" class="size-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    </div>

    <ul class="flex flex-1 flex-col items-center gap-1">
      <li v-for="item in navItems" :key="item.id" class="group relative">
        <button
          class="no-drag flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          :class="{ 'bg-accent text-foreground': item.id === 'chat' }"
          :title="item.label"
          type="button"
        >
          <component :is="item.icon" class="size-[18px]" />
        </button>
      </li>
    </ul>

    <div class="mt-auto">
      <div class="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-muted-foreground" aria-hidden="true">
        <User class="size-4" />
      </div>
    </div>
  </nav>
</template>
