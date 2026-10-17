// registration.ts 单测：纯函数面（校验 / CSP 警告 / 项目构造）+ 密钥存取（经 secretStore 注入）。
//
// 模块生命周期：registration 带模块级密钥缓存，每例经 loadReg（resetModules + 动态 import）
// 重载 —— 与 host.test 同一条纪律。注册动作本身（chrome.userScripts.*）不在此测：
// 那是宿主接线的行为面，由根侧 dl-bridge.test 与真机验证覆盖。
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UserscriptHostConfig } from './host-config'

afterEach(() => {
  vi.unstubAllGlobals()
})

/** 每例重载模块图：先注入配置再动态 import（读口在函数调用期取，加载期不读） */
async function loadReg(cfg: UserscriptHostConfig = {}): Promise<typeof import('./registration')> {
  vi.resetModules()
  const { configureUserscriptRuntime } = await import('./host-config')
  configureUserscriptRuntime(cfg)
  return import('./registration')
}

describe('validateMatchPatterns', () => {
  const config = (matches: string[], excludeMatches?: string[]) => ({
    matches,
    ...(excludeMatches ? { excludeMatches } : {}),
    allFrames: true,
    runAt: 'document_end' as const,
  })

  it('合法规则不抛（通配 / 具体 host / file 无 host / 带端口 / all_urls / 排除规则）', async () => {
    const { validateMatchPatterns } = await loadReg()
    expect(() => validateMatchPatterns(config(['*://*/*']))).not.toThrow()
    expect(() => validateMatchPatterns(config(['https://example.com/foo/*bar']))).not.toThrow()
    expect(() => validateMatchPatterns(config(['file:///foo*']))).not.toThrow()
    expect(() => validateMatchPatterns(config(['http://127.0.0.1:8080/*']))).not.toThrow()
    expect(() => validateMatchPatterns(config(['<all_urls>']))).not.toThrow()
    expect(() => validateMatchPatterns(config(['*://*/*'], ['*://evil.example/*']))).not.toThrow()
  })

  it('非法规则抛错并列出全部不合法项（不拖到 chrome.register 才以英文异常冒出）', async () => {
    const { validateMatchPatterns } = await loadReg()
    for (const bad of [
      'example.com/*',
      'https://example.com',
      'http://foo.*.bar/baz',
      'javascript:alert(1)',
      '',
    ]) {
      expect(() => validateMatchPatterns(config([bad]))).toThrow(/匹配规则不合法/)
    }
    expect(() => validateMatchPatterns(config(['*://*/*', 'bad-rule']))).toThrow(/bad-rule/)
  })

  it('excludeMatches 同样受校验', async () => {
    const { validateMatchPatterns } = await loadReg()
    expect(() => validateMatchPatterns(config(['*://*/*'], ['not-a-pattern']))).toThrow(/not-a-pattern/)
  })
})

describe('collectCspWarnings', () => {
  it('含 eval / new Function 的注入代码给非阻塞警告', async () => {
    const { collectCspWarnings } = await loadReg()
    expect(collectCspWarnings('const f = eval("1+1")')).toHaveLength(1)
    expect(collectCspWarnings('const f = new Function("return 1")')).toHaveLength(1)
  })

  it('干净代码无警告', async () => {
    const { collectCspWarnings } = await loadReg()
    expect(collectCspWarnings('console.log("hello")')).toEqual([])
  })
})

describe('projectFromSource', () => {
  it('源码声明 @name 时采纳（用户尚无命名意图，metadata 是输入）', async () => {
    const { projectFromSource } = await loadReg()
    const p = projectFromSource('// ==UserScript==\n// @name 我的脚本\n// @match https://a.com/*\n// ==/UserScript==\nconsole.log(1)')
    expect(p.name).toBe('我的脚本')
    expect(p.config.matches).toEqual(['https://a.com/*'])
  })

  it('无 metadata 块：默认全站匹配 + 默认名 + enabled=true', async () => {
    const { projectFromSource } = await loadReg()
    const p = projectFromSource('console.log(1)', '直建脚本')
    expect(p.name).toBe('直建脚本')
    expect(p.config.matches).toEqual(['<all_urls>'])
    expect(p.enabled).toBe(true)
  })

  it('源码搬运副本原样保留（无构建流程，注入即源码原文）', async () => {
    const { projectFromSource } = await loadReg()
    const code = '// ==UserScript==\n// @match *://x.test/*\n// ==/UserScript==\nconsole.log(1)'
    const p = projectFromSource(code)
    expect(p.source.code).toBe(code)
    expect(p.source.savedAt).toBeGreaterThan(0)
    expect(p.v).toBe(2)
  })
})

describe('握手密钥（getOrCreatePageSecret / rotatePageSecret）', () => {
  it('注入 secretStore：首次生成并落盘，重启（模块重载）后读回同一把', async () => {
    const backing = new Map<string, string>()
    let reg = await loadReg({
      secretStore: {
        get: async (k) => backing.get(k),
        set: async (k, v) => void backing.set(k, v),
      },
    })
    const first = await reg.getOrCreatePageSecret()
    expect(first).toBeTruthy()
    expect(backing.get('pageSecret')).toBe(first)
    // SW 重启 = 模块重载：缓存归零，从存储读回同一把
    reg = await loadReg({
      secretStore: {
        get: async (k) => backing.get(k),
        set: async (k, v) => void backing.set(k, v),
      },
    })
    expect(await reg.getOrCreatePageSecret()).toBe(first)
  })

  it('不注入 secretStore：一次性密钥（SW 存活期内稳定，重启即换）', async () => {
    const reg = await loadReg()
    const first = await reg.getOrCreatePageSecret()
    expect(await reg.getOrCreatePageSecret()).toBe(first)
  })

  it('rotatePageSecret 换新钥并落盘（重注册即轮换的落点）', async () => {
    const backing = new Map<string, string>()
    const reg = await loadReg({
      secretStore: {
        get: async (k) => backing.get(k),
        set: async (k, v) => void backing.set(k, v),
      },
    })
    const first = await reg.getOrCreatePageSecret()
    await reg.rotatePageSecret()
    const second = await reg.getOrCreatePageSecret()
    expect(second).not.toBe(first)
    expect(backing.get('pageSecret')).toBe(second)
  })
})
