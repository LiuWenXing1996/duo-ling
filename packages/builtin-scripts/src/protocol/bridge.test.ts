// protocol/bridge.ts 单测：两版 digest（可 import 的函数版 / 供字符串拼装的片段版）必须同源。
//
// 为什么两版并存：中继件是真 TS 模块（直接 import），而 MAIN 侧的脚本桥要被拼进 GM 包装的
// 源码字符串（整条 code 里不能有 import），只能拿片段。两版一旦漂移，桥会静默不认对方的握手 ——
// 症状是「所有 GM 调用都超时」，从表面上完全看不出是哈希不一致。故用同一批输入对跑两版。
import { describe, expect, it } from 'vitest'
import { BRIDGE_DIGEST_SNIPPET, bridgeDigest } from './bridge'

/** 在独立作用域里求值片段，取出它声明的 __dlBridgeDigest（片段用法就是插进另一段源码） */
function snippetDigest(): (secret: string, challenge: string) => string {
  return new Function(`${BRIDGE_DIGEST_SNIPPET}\nreturn __dlBridgeDigest`)() as (
    secret: string,
    challenge: string,
  ) => string
}

describe('bridgeDigest 与源码片段版一致', () => {
  it('同一批输入两版结果逐字节相同（含空值、长串与非 ASCII）', () => {
    const fromSnippet = snippetDigest()
    const cases: Array<[string, string]> = [
      ['test-secret-0123456789abcdef', 'uuid-1111-2222:1'],
      ['', 'x:0'],
      ['s', 'u:4294967296'],
      ['密钥含中文', 'u:7'],
      ['a'.repeat(64), 'u:9007199254740991'],
    ]
    for (const [secret, challenge] of cases) {
      expect(bridgeDigest(secret, challenge)).toBe(fromSnippet(secret, challenge))
    }
  })

  it('输出恒为 8 位十六进制（proof 的形状是协议的一部分，不能随输入变化）', () => {
    for (const challenge of ['u:1', 'u:4294967295', 'u:999999999999']) {
      expect(bridgeDigest('secret', challenge)).toMatch(/^[0-9a-f]{8}$/)
    }
  })
})
