// registry.ts 单测：声明的产物文件名必须与构建入口表一一对应。
//
// 两处分别决定「注册时引哪个文件」与「构建产出叫什么」—— 漏改一处就是注册时找不到文件，
// 表现为件静默不生效（userScripts 注入一个不存在的 file，页面里什么都不会发生）。
// 这里直接比对两边，把这类改名漏改挡在 CI。
import { describe, expect, it } from 'vitest'
import { ENTRY_POINTS } from '../esbuild.config.mjs'
import { BRIDGE_RELAY_BOOT_KEY } from './protocol/bridge'
import {
  INSPECTOR_HOST_FILE,
  SCRIPT_RELAY_FILE,
  TAB_FORWARDER_FILE,
  TAB_RECORDER_FILE,
  buildRelayInit,
} from './registry'

describe('产物文件名与构建入口表一致', () => {
  it('注册面声明的文件名，正好是构建产物名的全集', () => {
    const built = Object.keys(ENTRY_POINTS)
      .map((key) => `${key}.js`)
      .sort()
    const declared = [
      SCRIPT_RELAY_FILE,
      TAB_FORWARDER_FILE,
      TAB_RECORDER_FILE,
      INSPECTOR_HOST_FILE,
    ].sort()
    expect(declared).toEqual(built)
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
