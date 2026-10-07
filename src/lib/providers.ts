// 在线大模型服务商预设表：服务商与接口地址平移自桌面版原实现，
// 各家的预置模型 ID 按官方文档现行版本维护（旧 ID 会随发版改名或下线）。
// 统一按 OpenAI Chat Completions 兼容接口建模：
// - supported=true：用 Bearer 鉴权即可直接使用的服务商，一键添加
// - supported=false：如 AWS Bedrock 走 Signature V4 鉴权，当前暂不支持一键添加（网格中置灰提示）
//
// 维护提示：这张表是「数据」，改动要逐个字段核对 —— 漏过一次：少了 7 个服务商
// （海外 MiniMax / Kimi、小米 MiMo、BytePlus、AWS、ModelArk、PPIO），且 bigmodel /
// alibaba / tencent 的展示名不一致。预置模型 ID 换新时，下方 KNOWN_VISION_MODELS 同步维护。
import type { ModelProvider } from '../shared/types'

const PROVIDERS: ModelProvider[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    supported: true,
  },
  {
    id: 'volcengine',
    name: '火山引擎',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    keyUrl: 'https://console.volcengine.com/ark',
    models: [
      'doubao-seed-2-1-pro-260915',
      'doubao-seed-2-1-lite-260915',
      'doubao-seed-2-1-turbo-260628'
    ],
    supported: true,
  },
  {
    id: 'minimax-cn',
    name: 'MiniMax CN',
    baseUrl: 'https://api.minimaxi.com/v1',
    keyUrl: 'https://platform.minimaxi.com',
    models: ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.7-highspeed'],
    supported: true,
  },
  {
    id: 'minimax-global',
    name: 'MiniMax Global',
    baseUrl: 'https://api.minimax.io/v1',
    keyUrl: 'https://platform.minimaxi.com',
    models: ['MiniMax-M3', 'MiniMax-M2.7'],
    supported: true,
  },
  {
    id: 'bigmodel',
    name: 'Bigmodel',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    models: ['glm-5.3', 'glm-5.3-flash', 'glm-4.7'],
    supported: true,
  },
  {
    id: 'alibaba',
    name: '阿里云',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    keyUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
    models: ['qwen3.8-max', 'qwen3.8-flash', 'qwen3.7-plus'],
    supported: true,
  },
  {
    id: 'xiaomi-mimo',
    name: 'Xiaomi MIMO',
    baseUrl: 'https://api-inference.modelscope.cn/v1',
    keyUrl: 'https://platform.mimo.xiaomi.com',
    models: ['mimo-v2.6-pro', 'mimo-v2.6-flash'],
    supported: true,
  },
  {
    id: 'siliconflow',
    name: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    models: ['deepseek-ai/DeepSeek-V4-Pro', 'deepseek-ai/DeepSeek-V4-Flash', 'zai-org/GLM-5.3'],
    supported: true,
  },
  {
    id: 'zai',
    name: 'Z.ai',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    keyUrl: 'https://z.ai/console',
    models: ['glm-5.3', 'glm-5.3-flash'],
    supported: true,
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyUrl: 'https://openrouter.ai/keys',
    models: ['openai/gpt-5.6-sol', 'anthropic/claude-sonnet-5', 'google/gemini-3.8-flash'],
    supported: true,
  },
  {
    id: 'kimi-cn',
    name: 'Kimi CN',
    baseUrl: 'https://api.moonshot.cn/v1',
    keyUrl: 'https://platform.moonshot.cn/console',
    models: ['kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6'],
    supported: true,
  },
  {
    id: 'kimi-global',
    name: 'Kimi Global',
    baseUrl: 'https://api.moonshot.ai/v1',
    keyUrl: 'https://platform.moonshot.ai',
    models: ['kimi-k3', 'kimi-k2.7-code'],
    supported: true,
  },
  {
    id: 'byteplus',
    name: 'BytePlus',
    baseUrl: 'https://ark.bytepluses.com/api/v3',
    keyUrl: 'https://console.bytepluses.com/ark',
    models: ['dola-seed-2-1-turbo-260628', 'seed-2-0-pro-260328'],
    supported: true,
  },
  {
    id: 'aws',
    name: 'AWS',
    baseUrl: '',
    keyUrl: 'https://us-east-1.console.aws.amazon.com/bedrock',
    models: [],
    supported: false,
  },
  {
    id: 'tencent',
    name: '腾讯云',
    baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    keyUrl: 'https://console.cloud.tencent.com/hunyuan',
    models: ['hy4-preview', 'hy3'],
    supported: true,
  },
  {
    id: 'modelark',
    name: '模力方舟',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    keyUrl: 'https://console.volcengine.com/ark',
    models: ['doubao-seed-2-1-lite-260915'],
    supported: true,
  },
  {
    id: 'ppio',
    name: 'PPIO',
    baseUrl: 'https://api.ppio.ai/v1',
    keyUrl: 'https://www.ppio.ai',
    models: ['deepseek/deepseek-v4-pro-0813', 'minimax/minimax-m3', 'zai-org/glm-5.3'],
    supported: true,
  },
]

export function getProviders(): ModelProvider[] {
  return PROVIDERS
}

/**
 * 预设模型里**明确已知支持图片输入**的子集，供模型表单预置「支持图片」的默认值。
 *
 * 保守白名单：只收名字自带出处、或业界公认的多模态模型。拿不准的一律不收 ——
 * 预置错了比不预置更坏（图片发给读不了图的模型会请求失败，见 shared/types 的
 * ModelProfile.vision），而漏了只是让用户手勾一下。补预设模型时按同样口径维护。
 */
const KNOWN_VISION_MODELS = new Set([
  // 取自上面 PROVIDERS 的预设，按上述口径筛选（统一小写）
  'deepseek-flash',
  'qwen3.8-max',
  'qwen3.8-flash',
  'qwen3.7-plus',
  'glm-5.3-flash',
  'minimax-m3',
  'minimax/minimax-m3',
  'kimi-k3',
  'kimi-k2.6',
  'mimo-v2.6-pro',
  'mimo-v2.6-flash',
  'anthropic/claude-sonnet-5',
  'google/gemini-3.8-flash',
])

/** 该模型是否已知支持图片输入（首尾空白与大小写不敏感） */
export function isKnownVisionModel(model: string): boolean {
  return KNOWN_VISION_MODELS.has(model.trim().toLowerCase())
}

/**
 * 在线模型请求所需的 host 权限来源：由预设 baseUrl 推导 origin 通配。
 * 用于生成 manifest 的 host_permissions，避免上架时申请过度权限。
 * 只取 supported 的预设：不支持一键添加的服务商（如 AWS）用户也选不出来，
 * 没必要为它申请权限（自定义接口地址走 optional_host_permissions，见 README）。
 */
export function providerOrigins(): string[] {
  const origins = new Set<string>()
  for (const p of PROVIDERS) {
    if (!p.supported || !p.baseUrl) continue
    try {
      const url = new URL(p.baseUrl)
      origins.add(`${url.protocol}//${url.host}/*`)
    } catch {
      /* 非法地址跳过 */
    }
  }
  return [...origins]
}
