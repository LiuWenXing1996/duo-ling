import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MODEL_FILENAME, getModelDirCandidates, resolveModelDir, type ModelDirOptions } from './model-path'

const tmpRoots: string[] = []

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'model-path-'))
  tmpRoots.push(dir)
  return dir
}

function makeModelIn(dir: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, MODEL_FILENAME), '')
}

function makeOptions(overrides: Partial<ModelDirOptions> = {}): ModelDirOptions {
  return {
    envModels: undefined,
    isPackaged: false,
    userData: '/fake/user-data',
    appPath: '/fake/app-path',
    ...overrides
  }
}

afterEach(() => {
  for (const root of tmpRoots) {
    if (existsSync(root)) {
      rmSync(root, { recursive: true, force: true })
    }
  }
  tmpRoots.length = 0
})

describe('getModelDirCandidates', () => {
  it('未设置 $LLM_MODELS 时，开发模式候选为 <项目根>/llm-models', () => {
    const dirs = getModelDirCandidates(makeOptions({ appPath: '/proj', isPackaged: false }))
    expect(dirs).toEqual(['/proj/llm-models'])
  })

  it('未设置 $LLM_MODELS 时，打包模式候选为 <userData>/models', () => {
    const dirs = getModelDirCandidates(makeOptions({ userData: '/ud', isPackaged: true }))
    expect(dirs).toEqual(['/ud/models'])
  })

  it('设置 $LLM_MODELS 时，其目录排在候选最前面', () => {
    const dirs = getModelDirCandidates(makeOptions({ envModels: '/env/models' }))
    expect(dirs).toEqual(['/env/models', '/fake/app-path/llm-models'])
  })
})

describe('resolveModelDir', () => {
  it('$LLM_MODELS 目录下有模型时优先使用它', () => {
    const envDir = makeTmpDir()
    makeModelIn(envDir)
    const appDir = makeTmpDir()
    makeModelIn(appDir)

    const result = resolveModelDir(
      makeOptions({ envModels: envDir, appPath: appDir })
    )
    expect(result).toBe(envDir)
  })

  it('$LLM_MODELS 目录下无模型时回退到开发模式 llm-models 目录', () => {
    const envDir = makeTmpDir()
    const appDir = makeTmpDir()
    // 开发模式的候选目录是 <项目根>/llm-models
    makeModelIn(join(appDir, 'llm-models'))

    const result = resolveModelDir(
      makeOptions({ envModels: envDir, appPath: appDir })
    )
    expect(result).toBe(join(appDir, 'llm-models'))
  })

  it('所有候选都无模型时返回最高优先级候选（$LLM_MODELS）', () => {
    const envDir = makeTmpDir()
    const appDir = makeTmpDir()

    const result = resolveModelDir(
      makeOptions({ envModels: envDir, appPath: appDir })
    )
    expect(result).toBe(envDir)
  })

  it('未设置 $LLM_MODELS 时直接使用原有目录', () => {
    const appDir = makeTmpDir()
    makeModelIn(join(appDir, 'llm-models'))

    const result = resolveModelDir(makeOptions({ appPath: appDir }))
    expect(result).toBe(join(appDir, 'llm-models'))
  })
})
