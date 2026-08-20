<script setup lang="ts">
import { computed } from 'vue'

/**
 * 基于 JSON Schema 自动生成的表单（递归支持嵌套 object）。
 * 支持：string / number / integer / boolean / enum / array(string|number) / object。
 */

export interface JsonSchema {
  type?: string
  properties?: Record<string, JsonSchema>
  items?: JsonSchema
  required?: string[]
  enum?: unknown[]
  description?: string
  minimum?: number
  maximum?: number
  [key: string]: unknown
}

const props = defineProps<{
  schema: JsonSchema
  modelValue: Record<string, unknown>
}>()

const emit = defineEmits<{ 'update:modelValue': [value: Record<string, unknown>] }>()

const fields = computed(() => {
  const properties = props.schema.properties ?? {}
  const required = new Set(props.schema.required ?? [])
  return Object.entries(properties).map(([key, subSchema]) => ({
    key,
    schema: subSchema,
    required: required.has(key)
  }))
})

function fieldValue(key: string): unknown {
  return props.modelValue[key]
}

function updateField(key: string, value: unknown): void {
  emit('update:modelValue', { ...props.modelValue, [key]: value })
}

function isEnum(schema: JsonSchema): boolean {
  return Array.isArray(schema.enum) && schema.enum.length > 0
}

function isArray(schema: JsonSchema): boolean {
  return schema.type === 'array'
}

function isObject(schema: JsonSchema): boolean {
  return schema.type === 'object' && !!schema.properties
}

function arrayText(key: string): string {
  const value = props.modelValue[key]
  return Array.isArray(value) ? value.join(', ') : ''
}

function updateArray(key: string, text: string): void {
  const parts = text
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
  updateField(
    key,
    props.schema.properties?.[key]?.items?.type === 'number'
      ? parts.map((part) => Number(part))
      : parts
  )
}
</script>

<template>
  <div class="schema-form">
    <div v-for="field in fields" :key="field.key" class="schema-field">
      <label class="schema-label" :for="`field-${field.key}`">
        {{ field.key }}
        <span v-if="!field.required" class="schema-optional">可选</span>
      </label>
      <p v-if="field.schema.description" class="schema-desc">{{ field.schema.description }}</p>

      <!-- 枚举：下拉选择 -->
      <select
        v-if="isEnum(field.schema)"
        :id="`field-${field.key}`"
        class="schema-control"
        :value="(fieldValue(field.key) as string) ?? ''"
        @change="updateField(field.key, ($event.target as HTMLSelectElement).value)"
      >
        <option value="" disabled>{{ field.required ? '请选择…' : '（不填）' }}</option>
        <option v-for="opt in field.schema.enum" :key="String(opt)" :value="String(opt)">
          {{ String(opt) }}
        </option>
      </select>

      <!-- 布尔：开关 -->
      <input
        v-else-if="field.schema.type === 'boolean'"
        :id="`field-${field.key}`"
        class="schema-checkbox"
        type="checkbox"
        :checked="Boolean(fieldValue(field.key))"
        @change="updateField(field.key, ($event.target as HTMLInputElement).checked)"
      />

      <!-- 数组：逗号分隔文本框 -->
      <textarea
        v-else-if="isArray(field.schema)"
        :id="`field-${field.key}`"
        class="schema-control schema-textarea"
        :value="arrayText(field.key)"
        rows="2"
        placeholder="逗号分隔多个值"
        @input="updateArray(field.key, ($event.target as HTMLTextAreaElement).value)"
      />

      <!-- 嵌套对象：递归渲染 -->
      <schema-form
        v-else-if="isObject(field.schema)"
        :schema="field.schema"
        :model-value="(fieldValue(field.key) as Record<string, unknown>) ?? {}"
        @update:model-value="updateField(field.key, $event)"
      />

      <!-- 数字 / 整数 -->
      <input
        v-else-if="field.schema.type === 'number' || field.schema.type === 'integer'"
        :id="`field-${field.key}`"
        class="schema-control"
        type="number"
        :min="field.schema.minimum"
        :max="field.schema.maximum"
        :value="(fieldValue(field.key) as number | undefined) ?? ''"
        @input="
          updateField(field.key, ($event.target as HTMLInputElement).value === '' ? '' : Number(($event.target as HTMLInputElement).value))
        "
      />

      <!-- 字符串 / 默认文本 -->
      <input
        v-else
        :id="`field-${field.key}`"
        class="schema-control"
        type="text"
        :value="(fieldValue(field.key) as string | undefined) ?? ''"
        @input="updateField(field.key, ($event.target as HTMLInputElement).value)"
      />
    </div>
  </div>
</template>

<style scoped>
.schema-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.schema-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.schema-label {
  font-size: 13px;
  font-weight: 500;
}

.schema-optional {
  margin-left: 6px;
  font-size: 11px;
  font-weight: 400;
  color: var(--muted-foreground);
}

.schema-desc {
  font-size: 12px;
  color: var(--muted-foreground);
}

.schema-control {
  width: 100%;
  height: 32px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background-color: transparent;
  padding: 0 10px;
  font-size: 13px;
  outline: none;
  transition:
    border-color 0.15s,
    box-shadow 0.15s;

  &:focus-visible {
    border-color: var(--ring);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--ring) 50%, transparent);
  }
}

.schema-textarea {
  height: auto;
  padding: 6px 10px;
  resize: vertical;
}

.schema-checkbox {
  width: 16px;
  height: 16px;
  accent-color: var(--ring);
}
</style>
