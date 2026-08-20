import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  getLlama,
  LlamaChatSession,
  ChatMLChatWrapper,
  type Llama,
  type LlamaModel
} from 'node-llama-cpp'
import { MODEL_FILENAME, resolveModelDir } from './model-path'
import type { ChatMessage } from './chat-store'

export interface LlamaStatus {
  state: 'idle' | 'loading' | 'ready' | 'error'
  modelPath: string | null
  modelExists: boolean
  gpu?: string
  error?: string
}

// 模型目录解析：优先使用全局环境变量 $LLM_MODELS，其次回退到
// 开发模式项目根 llm-models/、打包后 <userData>/models（详见 model-path.ts）
function getModelDir(): string {
  return resolveModelDir({
    envModels: process.env['LLM_MODELS'],
    isPackaged: app.isPackaged,
    userData: app.getPath('userData'),
    appPath: app.getAppPath()
  })
}

export function getModelPath(): string {
  return join(getModelDir(), MODEL_FILENAME)
}

let llama: Llama | undefined
let model: LlamaModel | undefined
let status: LlamaStatus = { state: 'idle', modelPath: null, modelExists: false }

export function isModelReady(): boolean {
  return status.state === 'ready'
}

export function checkModelExists(): { exists: boolean; path: string } {
  const modelPath = getModelPath()
  return { exists: existsSync(modelPath), path: modelPath }
}

export function getModelStatus(): LlamaStatus {
  return status
}

export async function initModel(): Promise<LlamaStatus> {
  if (status.state === 'ready' || status.state === 'loading') {
    return status
  }

  const modelPath = getModelPath()
  if (!existsSync(modelPath)) {
    status = {
      state: 'error',
      modelPath,
      modelExists: false,
      error: `未找到模型文件，请将 ${MODEL_FILENAME} 放入 ${getModelDir()} 目录`
    }
    return status
  }

  status = { state: 'loading', modelPath, modelExists: true }
  try {
    llama ??= await getLlama()
    model ??= await llama.loadModel({ modelPath })
    status = {
      state: 'ready',
      modelPath,
      modelExists: true,
      gpu: typeof llama.gpu === 'string' ? llama.gpu : undefined
    }
  } catch (error) {
    status = {
      state: 'error',
      modelPath,
      modelExists: true,
      error: error instanceof Error ? error.message : String(error)
    }
  }
  return status
}

let chatSession: LlamaChatSession | undefined

async function getChatSession(): Promise<LlamaChatSession> {
  if (!model) {
    throw new Error('模型尚未加载，请先点击「加载模型」')
  }
  if (!chatSession) {
    // MiniCPM 的 GGUF 自带 Jinja 模板与 JinjaTemplateChatWrapper 不兼容（渲染出的历史为空），
    // 其模板本质是 ChatML 格式，因此改用内置 ChatMLChatWrapper
    const context = await model.createContext({ contextSize: 4096 })
    chatSession = new LlamaChatSession({
      contextSequence: context.getSequence(),
      chatWrapper: new ChatMLChatWrapper(),
      systemPrompt: '你是 Duo Ling 的本地 AI 助手，请用中文回答。'
    })
  }
  return chatSession
}

/**
 * 生成回复。history 为当前用户消息之前的历史，流式回调 onToken 逐段输出。
 * signal 中止时 prompt 会抛错（signal.reason）。
 */
export async function generateChatReply(
  history: ChatMessage[],
  userText: string,
  onToken: (text: string) => void,
  signal: AbortSignal
): Promise<string> {
  const session = await getChatSession()
  // node-llama-cpp v3 的历史格式：user 用 { type:'user', text }，assistant 用 { type:'model', response }
  session.setChatHistory(
    history.map((m) =>
      m.role === 'user'
        ? { type: 'user' as const, text: m.content }
        : { type: 'model' as const, response: [m.content] }
    )
  )
  return await session.prompt(userText, {
    maxTokens: 2048,
    onTextChunk: onToken,
    signal
  })
}
