<script setup lang="ts">
// 生成工具的执行页（PRD §6 生成期）：把 LLM 生成的「完整组件」编译成真实 Vue 组件并渲染。
//
// LLM 产出 { name, title, description, template, setup }：
//   - template 是 Vue 3 模板字符串；setup 是组件逻辑源码（export default function setup() { ... return { ... } }）。
//   - 运行时用 @vue/compiler-dom 的 compile(template, { mode: 'function' }) 得到渲染函数，
//     再把 setup 源码放进 new Function 中执行（注入 Vue 与 cap），与 render 组合成 defineComponent 渲染。
//   - cap.run('能力id', 参数) 是能力调用入口（内部走渲染层 runCapability，按运行域分派）。

import { computed, onMounted, shallowRef, type Component } from 'vue'
import * as Vue from 'vue'
import { compile } from '@vue/compiler-dom'
import { Sparkles as UiSparkles } from '@lucide/vue'
import { runCapability } from '@/lib/capability-runner'
import type { GeneratedToolDef } from '@/lib/tool-generator'

const props = defineProps<{ def: GeneratedToolDef }>()

// cap 运行时上下文：cap.run 包装 runCapability，失败则抛错（中断后续逻辑）
function makeContext(): { run: (id: string, args: unknown) => Promise<unknown> } {
  return {
    run: async (id: string, args: unknown) => {
      const res = await runCapability(id, args)
      if (!res.ok) throw new Error(res.error)
      return res.result
    }
  }
}

/**
 * 把 setup 源码（含 export default function setup）转成无参绑定函数。
 * 注入 Vue（解构 ref/computed 等常用 API 供生成代码直接使用）与 cap。
 * 生成代码里 cap.run('id', args) 里的 cap 由工厂形参闭包提供，无需再传参。
 */
function buildSetupFactory(setupSource: string): (() => Record<string, unknown> | void) | null {
  try {
    const body = setupSource.replace(/export\s+default\s+function\s+setup/i, 'function setup')
    const factory = new Function(
      'Vue',
      'cap',
      `"use strict";\nconst { ref, computed, reactive, watch, onMounted, onUnmounted, onBeforeUnmount } = Vue;\n${body}\nreturn setup;`
    )
    return factory(Vue, makeContext())
  } catch {
    return null
  }
}

/** 编译出一段真实 Vue 组件：render（模板编译）+ setup（逻辑） */
function buildGeneratedComponent(def: GeneratedToolDef): {
  component: Component | null
  error: string | null
} {
  try {
    const { code } = compile(def.template, { mode: 'function' })
    const render = new Function('Vue', code)(Vue) as ((ctx: unknown) => unknown) & {
      _rc?: boolean
    }
    // @vue/compiler-dom 的 function 产物用 with(_ctx) 访问渲染上下文。
    // 标记 _rc 让 Vue 为其创建 withProxy（RuntimeCompiledPublicInstanceProxyHandlers），
    // 以正确处理 Symbol.unscopables，避免「Property undefined was accessed during render」告警。
    render._rc = true
    const setupFn = buildSetupFactory(def.setup)
    if (!setupFn) throw new Error('setup 解析失败')
    const component = Vue.markRaw(
      Vue.defineComponent({
        setup: () => setupFn(),
        render
      })
    )
    return { component, error: null }
  } catch (error) {
    return { component: null, error: error instanceof Error ? error.message : String(error) }
  }
}

const built = shallowRef<{ component: Component | null; error: string | null }>({
  component: null,
  error: null
})
const errorText = computed(() => built.value.error)

onMounted(() => {
  built.value = buildGeneratedComponent(props.def)
})
</script>

<template>
  <section class="panel tool-generated">
    <header class="panel-header flex items-center justify-between gap-2">
      <h2 class="panel-title flex items-center gap-2">
        <ui-sparkles class="size-4 text-primary" />
        {{ def.title }}
      </h2>
      <span class="rounded border border-border bg-muted px-1.5 font-mono text-[10px] text-muted-foreground">
        生成工具
      </span>
    </header>

    <div class="min-h-0 flex-1 overflow-y-auto scroll-gap p-4">
      <p class="text-xs text-muted-foreground">{{ def.description }}</p>

      <p v-if="errorText" class="mt-4 text-xs text-red-500">组件编译失败：{{ errorText }}</p>
      <component :is="built.component" v-else />
    </div>
  </section>
</template>

<style scoped lang="less">
.tool-generated {
  height: 100%;
}
</style>
