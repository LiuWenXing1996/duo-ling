import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const MODEL_FILENAME = 'MiniCPM5-1B-Q8_0.gguf'

export interface ModelDirOptions {
  /** 全局环境变量 $LLM_MODELS 指定的目录（可能未设置） */
  envModels?: string
  isPackaged: boolean
  userData: string
  appPath: string
}

/**
 * 候选模型目录，按优先级排列：
 * 1. 全局环境变量 $LLM_MODELS（若已设置）
 * 2. 打包后 <userData>/models，开发时 <项目根>/llm-models
 */
export function getModelDirCandidates(options: ModelDirOptions): string[] {
  const dirs: string[] = []
  if (options.envModels) {
    dirs.push(options.envModels)
  }
  dirs.push(
    options.isPackaged
      ? join(options.userData, 'models')
      : join(options.appPath, 'llm-models')
  )
  return dirs
}

/**
 * 解析模型目录：返回首个存在模型文件的候选目录；
 * 全部候选都不存在时，返回最高优先级候选（$LLM_MODELS）。
 */
export function resolveModelDir(options: ModelDirOptions): string {
  const dirs = getModelDirCandidates(options)
  return dirs.find((dir) => existsSync(join(dir, MODEL_FILENAME))) ?? dirs[0]
}
