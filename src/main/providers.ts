/**
 * 在线大模型服务商预设表。
 * 统一按 OpenAI Chat Completions 兼容接口建模：
 * - supported=true：用 Bearer 鉴权即可直接使用的服务商，一键添加
 * - supported=false：如 AWS Bedrock 走 Signature V4 鉴权，当前暂不支持一键添加（网格中置灰提示）
 */
export interface ModelProvider {
  id: string
  name: string
  /** OpenAI 兼容接口地址（不强制以 /v1 结尾，多数加上 /chat/completions 即可） */
  baseUrl: string
  /** 服务商控制台获取 API Key 的链接 */
  keyUrl: string
  /** 预置常用模型 ID（用户在「模型」下拉中可追加自定义） */
  models: string[]
  /** 是否可直接用 Bearer 鉴权添加 */
  supported: boolean
}

export const PROVIDERS: ModelProvider[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    models: ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp'],
    supported: true
  },
  {
    id: 'volcengine',
    name: '火山引擎',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    keyUrl: 'https://console.volcengine.com/ark',
    models: ['doubao-1-5-pro-32k-250115', 'doubao-1-5-lite-32k-250115'],
    supported: true
  },
  {
    id: 'minimax-cn',
    name: 'MiniMax CN',
    baseUrl: 'https://api.minimaxi.com/v1',
    keyUrl: 'https://platform.minimaxi.com',
    models: ['MiniMax-Text-01', 'abab6.5s-chat'],
    supported: true
  },
  {
    id: 'minimax-global',
    name: 'MiniMax Global',
    baseUrl: 'https://api.minimax.io/v1',
    keyUrl: 'https://platform.minimaxi.com',
    models: ['MiniMax-Text-01'],
    supported: true
  },
  {
    id: 'bigmodel',
    name: 'Bigmodel',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    models: ['glm-4-plus', 'glm-4-flash', 'glm-4.5'],
    supported: true
  },
  {
    id: 'alibaba',
    name: '阿里云',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    keyUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
    models: ['qwen-plus', 'qwen-max', 'qwen-turbo'],
    supported: true
  },
  {
    id: 'xiaomi-mimo',
    name: 'Xiaomi MIMO',
    baseUrl: 'https://api-inference.modelscope.cn/v1',
    keyUrl: 'https://platform.mimo.xiaomi.com',
    models: ['MiMo-7B-RL'],
    supported: true
  },
  {
    id: 'siliconflow',
    name: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    models: ['deepseek-ai/DeepSeek-V3', 'deepseek-ai/DeepSeek-R1', 'Qwen/Qwen2.5-72B-Instruct'],
    supported: true
  },
  {
    id: 'zai',
    name: 'Z.ai',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    keyUrl: 'https://z.ai/console',
    models: ['glm-4.5', 'glm-4.5-air'],
    supported: true
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyUrl: 'https://openrouter.ai/keys',
    models: ['openai/gpt-4o-mini', 'anthropic/claude-3.5-sonnet', 'google/gemini-2.0-flash'],
    supported: true
  },
  {
    id: 'kimi-cn',
    name: 'Kimi CN',
    baseUrl: 'https://api.moonshot.cn/v1',
    keyUrl: 'https://platform.moonshot.cn/console',
    models: ['kimi-k2-0711-preview', 'moonshot-v1-8k', 'moonshot-v1-32k'],
    supported: true
  },
  {
    id: 'kimi-global',
    name: 'Kimi Global',
    baseUrl: 'https://api.moonshot.ai/v1',
    keyUrl: 'https://platform.moonshot.ai',
    models: ['kimi-k2-0711-preview'],
    supported: true
  },
  {
    id: 'byteplus',
    name: 'BytePlus',
    baseUrl: 'https://ark.bytepluses.com/api/v3',
    keyUrl: 'https://console.bytepluses.com/ark',
    models: ['doubao-1-5-pro-32k-250115'],
    supported: true
  },
  {
    id: 'aws',
    name: 'AWS',
    baseUrl: '',
    keyUrl: 'https://us-east-1.console.aws.amazon.com/bedrock',
    models: [],
    supported: false
  },
  {
    id: 'tencent',
    name: '腾讯云',
    baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    keyUrl: 'https://console.cloud.tencent.com/hunyuan',
    models: ['hunyuan-turbos-latest', 'hunyuan-standard'],
    supported: true
  },
  {
    id: 'modelark',
    name: '模力方舟',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    keyUrl: 'https://console.volcengine.com/ark',
    models: ['doubao-1-5-pro-32k-250115'],
    supported: true
  },
  {
    id: 'ppio',
    name: 'PPIO',
    baseUrl: 'https://api.ppio.ai/v1',
    keyUrl: 'https://www.ppio.ai',
    models: ['gpt-4o-mini'],
    supported: true
  }
]

export function getProviders(): ModelProvider[] {
  return PROVIDERS
}
