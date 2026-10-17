// 模型配置的形状：UI 展示态与存储态。
//
// 为什么在契约包：配置由 SW 从 chrome.storage 读出、offscreen 拿它发请求、面板拿它渲染
// —— 三个语境同取一份，放任一侧都会让另两侧反向依赖。

/** 渲染进程可见的模型配置（apiKey 不回传明文，只暴露是否已设置） */
export interface ModelProfile {
  id: string
  /** 模型展示名，如 DeepSeek-V4.1-Flash；未设置时回退为模型 ID */
  name: string
  /** 所属服务商（预设 id），自定义模型为空字符串 */
  providerId: string
  /** 完整的 Chat Completions 端点地址，如 https://api.deepseek.com/chat/completions。
   *  请求时**原样使用**，不再拼接任何路径 —— 填什么用什么，填错由「测试连接」当场暴露 */
  baseUrl: string
  /** 模型 ID，如 deepseek-flash（请求时作为 model 字段） */
  model: string
  /** API 格式，目前仅支持 OpenAI Chat Completions */
  apiFormat: 'openai'
  hasApiKey: boolean
  /** 上下文输出 Token（高级配置，作为请求 max_tokens） */
  contextOutputToken?: number
  /** 采样参数：Temperature（0~2） */
  temperature?: number
  /** 采样参数：Top P（0~1） */
  topP?: number
  /** 采样参数：Top K（1~100） */
  topK?: number
  /** 流式静默超时（秒）：两次回复间隔超过此值即判定服务卡死并中止生成，避免请求长期占用连接触发限流；不填用默认 60 */
  streamIdleTimeoutSec?: number
}

/**
 * 模型配置的内部完整态（含 apiKey 明文）。
 * 只在本扩展的存储层与请求发起方之间流转，不出存储边界；
 * 交给 UI 前一律经 `model-store.toPublic` 剔除 apiKey、换成 hasApiKey。
 */
export type ModelProfileState = ModelProfile & { apiKey: string }
