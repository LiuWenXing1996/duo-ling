// registry.ts 单测：声明的产物文件名必须与构建入口表一一对应。
//
// 两处分别决定「注册时引哪个文件」与「构建产出叫什么」—— 漏改一处就是注册时找不到文件，
// 表现为件静默不生效（userScripts 注入一个不存在的 file，页面里什么都不会发生）。
// 这里直接比对两边，把这类改名漏改挡在 CI。
//
// 注意：脚本桥中继件（relay）已随 `@duoling/userscript-runtime` 包内化 —— 它没有公共资产
// 文件（IIFE 以 `{ code }` 注册），也不在本表的比对范围里（它的装配段契约测试在包内
// relay/sync.test.ts）。
import { describe, expect, it, vi } from 'vitest'
import { ENTRY_POINTS } from '../esbuild.config.mjs'
import { FLOAT_HOST_HOOK_KEY } from '@duoling/shared'
import {
  FLOAT_HOST_FILE,
  INSPECTOR_HOST_FILE,
  TAB_FORWARDER_FILE,
  TAB_RECORDER_FILE,
  buildFloatHostInit,
} from './registry'

describe('产物文件名与构建入口表一致', () => {
  it('注册面声明的文件名，正好是构建产物名的全集', () => {
    const built = Object.keys(ENTRY_POINTS)
      .map((key) => `${key}.js`)
      .sort()
    const declared = [
      TAB_FORWARDER_FILE,
      TAB_RECORDER_FILE,
      INSPECTOR_HOST_FILE,
      FLOAT_HOST_FILE,
    ].sort()
    expect(declared).toEqual(built)
  })
})

describe('buildFloatHostInit（浮层宿主件装配段）', () => {
  it('按件暴露的键名取 hook，并把浮层页地址与扩展名作为字面量递进去', () => {
    const code = buildFloatHostInit('chrome-extension://id/floatpanel.html', '测试扩展名')
    expect(code).toContain(FLOAT_HOST_HOOK_KEY)
    expect(code).toContain(JSON.stringify('chrome-extension://id/floatpanel.html'))
    expect(code).toContain(JSON.stringify('测试扩展名'))
  })

  it('地址 / 扩展名里的引号、反斜杠与换行不会破坏生成的源码', () => {
    const weirdUrl = 'chrome-extension://id/float"panel\\x.html\nx'
    const weirdName = 'a"b\\c'
    const code = buildFloatHostInit(weirdUrl, weirdName)
    expect(code).toContain(JSON.stringify(weirdUrl))
    expect(code).toContain(JSON.stringify(weirdName))
    expect(() => new Function(code)).not.toThrow()
  })

  it('件不在场（两段没落在同一世界）时出声，不静默', () => {
    const warns: string[] = []
    const spy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
      warns.push(a.map(String).join(' '))
    })
    try {
      new Function('window', buildFloatHostInit('u', 'n'))({})
    } finally {
      spy.mockRestore()
    }
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('宿主件未装配')
  })

  it('件在场时把两个值原样交给 init', () => {
    const init = vi.fn()
    new Function('window', buildFloatHostInit('u', 'n'))({ [FLOAT_HOST_HOOK_KEY]: { init } })
    expect(init).toHaveBeenCalledWith('u', 'n')
  })
})
