// 中继件宿主侧注册面单测：并集驱动 / 幂等跳过 / 空并集注销 / 装配段契约。
//
// chrome 整体 stub（vi.stubGlobal）：userScripts 记录注册与注销调用，world 配置返回成功。
// gen 产物（relay-code.gen.ts）由 test 脚本前置的 build-relay.mjs 生成后再跑测试。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BRIDGE_RELAY_BOOT_KEY } from '@duoling/shared'
import type { ScriptProject } from '@duoling/shared'
import { SCRIPT_RELAY_ID, SCRIPT_RELAY_WORLD_ID, buildRelayInit, syncScriptRelay } from './sync'

/** 构造一个启用中的最小项目（matches 来自参数） */
function project(matches: string[]): ScriptProject {
  return {
    v: 2,
    uuid: crypto.randomUUID(),
    name: 'p',
    enabled: true,
    config: { matches, runAt: 'document_end' },
    source: { code: '// x', savedAt: 1 },
    createdAt: 1,
  } as unknown as ScriptProject
}

function setup(opts: { existing?: Array<Record<string, unknown>> } = {}) {
  const register = vi.fn(async (_details?: unknown[]) => {})
  const unregister = vi.fn(async () => {})
  const configureWorld = vi.fn(async () => {})
  const getScripts = vi.fn(async () => opts.existing ?? [])
  vi.stubGlobal('chrome', {
    userScripts: {
      getScripts,
      register,
      unregister,
      configureWorld,
    },
  })
  return { register, unregister, configureWorld, getScripts }
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

describe('syncScriptRelay（中继件注册同步）', () => {
  it('有启用脚本：按匹配并集注册两段（IIFE + 装配段），世界先开 messaging', async () => {
    const { register, configureWorld } = setup()
    await syncScriptRelay([project(['https://a.com/*']), project(['https://b.com/*'])])
    expect(configureWorld).toHaveBeenCalledWith({
      worldId: SCRIPT_RELAY_WORLD_ID,
      messaging: true,
    })
    expect(register).toHaveBeenCalledTimes(1)
    const reg = register.mock.calls[0]![0]![0] as Record<string, unknown>
    expect(reg.id).toBe(SCRIPT_RELAY_ID)
    expect(reg.worldId).toBe(SCRIPT_RELAY_WORLD_ID)
    expect(reg.matches).toEqual(['https://a.com/*', 'https://b.com/*'])
    // 两段：IIFE 在前（装运行器），装配段在后（递密钥）
    const js = reg.js as Array<{ code: string }>
    expect(js).toHaveLength(2)
    expect(js[0]!.code).toContain(BRIDGE_RELAY_BOOT_KEY)
    expect(js[1]!.code).toContain('window')
  })

  it('并集未变且件已在位：跳过重注册（不换注入源码，已加载页面不被打断）', async () => {
    const { register } = setup({
      existing: [{ id: SCRIPT_RELAY_ID, matches: ['https://a.com/*'] }],
    })
    await syncScriptRelay([project(['https://a.com/*'])])
    expect(register).not.toHaveBeenCalled()
  })

  it('没有启用脚本（并集为空）：件在册则注销，不在册则什么都不做', async () => {
    const { unregister } = setup({ existing: [{ id: SCRIPT_RELAY_ID, matches: ['<all_urls>'] }] })
    await syncScriptRelay([])
    expect(unregister).toHaveBeenCalledWith({ ids: [SCRIPT_RELAY_ID] })

    const { unregister: unregister2 } = setup()
    await syncScriptRelay([])
    expect(unregister2).not.toHaveBeenCalled()
  })

  it('getScripts 抛错（引擎不可用）：静默跳过，不注册也不注销', async () => {
    const { register, unregister } = setup()
    vi.mocked(chrome.userScripts.getScripts).mockRejectedValueOnce(new Error('不可用'))
    await syncScriptRelay([project(['https://a.com/*'])])
    expect(register).not.toHaveBeenCalled()
    expect(unregister).not.toHaveBeenCalled()
  })
})

describe('buildRelayInit（中继件装配段）', () => {
  it('按运行器暴露的键名取函数，并把密钥作为字面量递进去', () => {
    const code = buildRelayInit('secret-1')
    expect(code).toContain(BRIDGE_RELAY_BOOT_KEY)
    expect(code).toContain(JSON.stringify('secret-1'))
  })

  it('密钥里的引号 / 反斜杠不会破坏生成的源码', () => {
    const weird = 'a"b\\c\nd'
    const code = buildRelayInit(weird)
    expect(code).toContain(JSON.stringify(weird))
    // 生成的代码本身必须可解析（注入前就会被解析，语法错等于整段静默失效）
    expect(() => new Function(code)).not.toThrow()
  })
})

describe('RELAY_IIFE（中继件 IIFE 产物）', () => {
  it('自包含成一条可解析的 IIFE：含运行器安装逻辑，无 import/export 残留', async () => {
    const { RELAY_IIFE } = await import('./relay-code.gen')
    expect(() => new Function(RELAY_IIFE)).not.toThrow()
    expect(RELAY_IIFE).toContain(BRIDGE_RELAY_BOOT_KEY)
    // 只认语法位，不按关键词扫全文：描述文案里出现「import / export」这类字样是正常的。
    // 动态 import 是合法语法、解析不报错，但在页面里加载不了，故单独拦。
    expect(RELAY_IIFE).not.toMatch(/^\s*(?:import|export)\b/m)
    expect(RELAY_IIFE).not.toMatch(/\bimport\s*\(/)
  })
})
