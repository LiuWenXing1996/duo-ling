import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { getLlama, type Llama, type LlamaModel } from 'node-llama-cpp'

export const MODEL_FILENAME = 'MiniCPM5-1B-Q8_0.gguf'

export interface LlamaStatus {
  state: 'idle' | 'loading' | 'ready' | 'error'
  modelPath: string | null
  modelExists: boolean
  gpu?: string
  error?: string
}

// 模型目录：开发模式读项目根 llm-models/，打包后读 <userData>/models
function getModelDir(): string {
  return app.isPackaged
    ? join(app.getPath('userData'), 'models')
    : join(app.getAppPath(), 'llm-models')
}

export function getModelPath(): string {
  return join(getModelDir(), MODEL_FILENAME)
}

let llama: Llama | undefined
let model: LlamaModel | undefined
let status: LlamaStatus = { state: 'idle', modelPath: null, modelExists: false }

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
