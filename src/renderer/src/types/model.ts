// 模型配置 / 服务商预设：来自主进程 model.list、provider.list 的纯数据模型。
// 作为渲染层内唯一来源，避免 settings-panel 与 model-form-dialog 逐字复制同一 interface。

/** 渲染进程可见的模型配置（apiKey 不回传明文，只暴露是否已设置） */
export interface ModelProfile {
  id: string
  name: string
  providerId: string
  baseUrl: string
  model: string
  enabled: boolean
  useFullUrl: boolean
  apiFormat: 'openai'
  hasApiKey: boolean
  contextOutputToken?: number
  temperature?: number
  topP?: number
  topK?: number
}

/** 在线大模型服务商预设 */
export interface ModelProvider {
  id: string
  name: string
  baseUrl: string
  keyUrl: string
  models: string[]
  supported: boolean
}
