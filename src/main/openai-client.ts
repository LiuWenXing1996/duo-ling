// 在线模型网络请求：拉取 /models 列表 + 连通性测试（非流式 chat）。
// 职责边界：只做底层 fetch 请求，配置来源统一走 model-store 的 getActiveConfig / 外部入参。

import { getActiveConfig } from './model-store'

/**
 * 拉取服务商可用模型列表（GET /models），失败抛错由调用方包装。
 * overrides 提供时用其测试（不落盘），否则用当前默认模型配置。
 */
export async function listModels(overrides?: {
  baseUrl?: string
  apiKey?: string
}): Promise<string[]> {
  const saved = getActiveConfig()
  const baseUrl = (overrides?.baseUrl ?? saved.baseUrl).trim().replace(/\/+$/, '')
  const apiKey = overrides?.apiKey?.trim() || saved.apiKey
  if (!baseUrl) throw new Error('请先填写接口地址（baseUrl）')
  if (!apiKey) throw new Error('请先填写 API Key')

  const res = await fetch(`${baseUrl}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  })
  if (!res.ok) {
    throw new Error(`获取模型列表失败（${res.status}）：${(await res.text()).slice(0, 200)}`)
  }
  const body = (await res.json()) as { data?: Array<{ id: string }> }
  return (body.data ?? []).map((m) => m.id).filter(Boolean)
}

/**
 * 连通性测试：用传入的配置发一次「最小」chat 请求（非流式），验证地址/Key/模型是否可用。
 * 会消耗极少量 Token，超时默认 15s。失败会抛错，由调用方包装为友好提示。
 */
export async function testChatConnection(config: {
  baseUrl: string
  apiKey?: string
  model: string
  useFullUrl?: boolean
}): Promise<void> {
  const baseUrl = config.baseUrl.trim().replace(/\/+$/, '')
  const apiKey = config.apiKey?.trim() ?? ''
  const model = config.model.trim()
  if (!baseUrl) throw new Error('请先填写接口地址（baseUrl）')
  if (!apiKey) throw new Error('请先填写 API Key')
  if (!model) throw new Error('请先填写模型 ID')

  const url = config.useFullUrl ? baseUrl : `${baseUrl}/chat/completions`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        stream: false,
        max_tokens: 8
      }),
      signal: controller.signal
    })
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300)
      throw new Error(`连接失败（${res.status}）：${text || res.statusText}`)
    }
    const body = (await res.json()) as { choices?: unknown[] }
    if (!body.choices?.length) {
      throw new Error('请求成功但未返回内容，请检查模型是否正确')
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('连通性测试超时，请检查网络或接口地址')
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}
