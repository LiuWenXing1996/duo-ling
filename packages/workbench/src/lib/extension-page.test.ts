// 「引导开权限」公共模块的单测：只覆盖纯逻辑（版本分支选 URL / 选步骤文案、UA 解析、参数透传）。
// chrome.tabs.create 对 chrome://extensions（含 ?id= 深链）的真实可达性由无头探针实测确认，
// 见模块头注释；此处用 stub 只验证「拼对了 URL、传对了参数」。
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getChromeMajorVersion,
  openOwnExtensionPage,
  ownExtensionPageUrl,
  userScriptsGuideSteps
} from './extension-page'

const ID = 'abcdefghijklmnopabcdefghijklmnop'

describe('ownExtensionPageUrl（按版本选目标页）', () => {
  it('Chrome ≥138：直达该扩展详情页深链（逐扩展「允许运行用户脚本」开关在这一页）', () => {
    expect(ownExtensionPageUrl(ID, 138)).toBe(`chrome://extensions/?id=${ID}`)
    expect(ownExtensionPageUrl(ID, 142)).toBe(`chrome://extensions/?id=${ID}`)
  })

  it('Chrome <138：退到扩展列表页（要开的是整页右上角的全局「开发者模式」）', () => {
    expect(ownExtensionPageUrl(ID, 137)).toBe('chrome://extensions/')
    expect(ownExtensionPageUrl(ID, 0)).toBe('chrome://extensions/')
  })
})

describe('getChromeMajorVersion（UA 解析）', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('解析 UA 里的 Chrome 主版本号', () => {
    vi.stubGlobal('navigator', {
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
    })
    expect(getChromeMajorVersion()).toBe(142)
  })

  it('Firefox 等非 Chrome：返回 0（落到列表页分支，且 UI 侧据此不给入口）', () => {
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:130.0) Gecko/20100101 Firefox/130.0',
    })
    expect(getChromeMajorVersion()).toBe(0)
  })
})

describe('openOwnExtensionPage（新标签打开）', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('用本扩展 id + 当前 UA 版本拼出 URL 交给 chrome.tabs.create', async () => {
    const create = vi.fn(async () => undefined)
    vi.stubGlobal('chrome', { runtime: { id: 'EXTID' }, tabs: { create } })
    vi.stubGlobal('navigator', { userAgent: 'Chrome/142.0.0.0' })
    await openOwnExtensionPage()
    expect(create).toHaveBeenCalledWith({ url: 'chrome://extensions/?id=EXTID' })
  })

  it('显式传入版本号时以其为准（横幅用 availability.chromeMajor，与 guideText 同判据）', async () => {
    const create = vi.fn(async () => undefined)
    vi.stubGlobal('chrome', { runtime: { id: 'EXTID' }, tabs: { create } })
    await openOwnExtensionPage(120)
    expect(create).toHaveBeenCalledWith({ url: 'chrome://extensions/' })
  })
})

describe('userScriptsGuideSteps（分步指引按浏览器 / 版本选分支）', () => {
  it('Chrome ≥138：步骤指向扩展详情页的「允许运行用户脚本」开关', () => {
    const steps = userScriptsGuideSteps({ isFirefox: false, chromeMajor: 142 })
    expect(steps).toHaveLength(3)
    expect(steps.map((s) => s.title).join(' ')).toContain('允许运行用户脚本')
    // 该版本不要提「开发者模式」为主步骤——它只在找不到开关时才是兜底
    expect(steps[1].detail).toContain('开发者模式')
  })

  it('Chrome <138：主步骤是全局「开发者模式」，不提逐扩展开关', () => {
    const steps = userScriptsGuideSteps({ isFirefox: false, chromeMajor: 137 })
    expect(steps.map((s) => s.title).join(' ')).toContain('开发者模式')
    expect(steps.map((s) => s.title).join(' ')).not.toContain('允许运行用户脚本')
  })

  it('版本号解析不到（非 Chrome）时走 <138 分支，不是空数组', () => {
    expect(userScriptsGuideSteps({ isFirefox: false, chromeMajor: 0 })).toHaveLength(3)
  })

  it('Firefox：走 about:addons 授权分支（tabs.create 打不开特权页，故文案里给手动路径）', () => {
    const steps = userScriptsGuideSteps({ isFirefox: true, chromeMajor: 0 })
    expect(steps[0].detail).toContain('about:addons')
    expect(steps.map((s) => s.title).join(' ')).toContain('User Scripts')
  })

  it('每步都有标题（引导页按序号逐条渲染，空标题会渲染出裸序号）', () => {
    for (const browser of [
      { isFirefox: true, chromeMajor: 0 },
      { isFirefox: false, chromeMajor: 142 },
      { isFirefox: false, chromeMajor: 120 }
    ]) {
      for (const step of userScriptsGuideSteps(browser)) {
        expect(step.title.trim()).not.toBe('')
      }
    }
  })
})
