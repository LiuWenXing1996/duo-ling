// bridge.ts 单测：digest 输出是协议的一部分（中继件按它验 proof），金标值由独立实现（Python 对拍）生成，防随实现漂移。
import { describe, expect, it } from 'vitest'
import { bridgeDigest } from './bridge'

describe('bridgeDigest', () => {
  it('金标输入逐字节命中（含空值、长串与非 ASCII）', () => {
    const cases: Array<[string, string, string]> = [
      ['test-secret-0123456789abcdef', 'uuid-1111-2222:1', 'e2bb400f'],
      ['', 'x:0', '6aacaf8d'],
      ['s', 'u:4294967296', '3142b3bd'],
      ['密钥含中文', 'u:7', '32358d13'],
      [
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'u:9007199254740991',
        'fa0a5cf8',
      ],
    ]
    for (const [secret, challenge, golden] of cases) {
      expect(bridgeDigest(secret, challenge)).toBe(golden)
    }
  })

  it('输出恒为 8 位十六进制（proof 的形状是协议的一部分，不能随输入变化）', () => {
    for (const challenge of ['u:1', 'u:4294967295', 'u:999999999999']) {
      expect(bridgeDigest('secret', challenge)).toMatch(/^[0-9a-f]{8}$/)
    }
  })
})
