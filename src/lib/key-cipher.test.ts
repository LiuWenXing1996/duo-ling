// key-cipher.ts 单测：加解密往返 + 密文载荷判别。
// DEK 落 duoling-app 库：fake-indexeddb/auto 供 IDB（Node 22 自带 crypto.subtle / btoa / atob）。
import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { decryptApiKey, encryptApiKey, isEncPayload } from './key-cipher'
import { get as appGet } from './app-db'

describe('encryptApiKey / decryptApiKey 往返', () => {
  it('ASCII 明文往返一致', async () => {
    const payload = await encryptApiKey('sk-abc123')
    expect(payload.iv).toBeTruthy()
    expect(payload.ct).toBeTruthy()
    await expect(decryptApiKey(payload)).resolves.toBe('sk-abc123')
  })

  it('含中文 / emoji 的明文往返一致', async () => {
    const plain = '密钥-key🔐中文'
    const payload = await encryptApiKey(plain)
    await expect(decryptApiKey(payload)).resolves.toBe(plain)
  })

  it('空字符串往返一致', async () => {
    const payload = await encryptApiKey('')
    await expect(decryptApiKey(payload)).resolves.toBe('')
  })

  it('长明文往返一致', async () => {
    const plain = 'x'.repeat(10_000)
    const payload = await encryptApiKey(plain)
    await expect(decryptApiKey(payload)).resolves.toBe(plain)
  })

  it('同一明文两次加密产生不同 iv 与密文（随机 iv）', async () => {
    const a = await encryptApiKey('same')
    const b = await encryptApiKey('same')
    expect(a.iv).not.toBe(b.iv)
    expect(a.ct).not.toBe(b.ct)
  })

  it('密文被篡改后解密必须失败（不静默返回垃圾）', async () => {
    const payload = await encryptApiKey('secret')
    // base64 尾字节翻转一个字符，构造无效密文
    const flipped = payload.ct.endsWith('A') ? payload.ct.slice(0, -1) + 'B' : payload.ct.slice(0, -1) + 'A'
    await expect(decryptApiKey({ ...payload, ct: flipped })).rejects.toThrow()
  })
})

describe('DEK 持久化', () => {
  it('首次加密后密钥落 duoling-app 库（明文 Key 不出现在存储）', async () => {
    await encryptApiKey('probe')
    const stored = await appGet<string>('apiKeyDek')
    // 存的是 base64 的原始密钥字节（本来就非明文 API Key），关键是不存在明文 key 值
    expect(typeof stored).toBe('string')
    expect(stored).not.toContain('sk-')
  })
})

describe('isEncPayload 判别', () => {
  it('合法载荷为 true', () => {
    expect(isEncPayload({ iv: 'a', ct: 'b' })).toBe(true)
  })

  it.each([
    ['空对象', {}],
    ['缺 ct', { iv: 'a' }],
    ['缺 iv', { ct: 'b' }],
    ['iv 非字符串', { iv: 1, ct: 'b' }],
  ])('%s 为 false', (_label, input) => {
    expect(isEncPayload(input)).toBe(false)
  })

  it.each<[unknown, string]>([
    [null, 'null'],
    [undefined, 'undefined'],
    ['str', '字符串'],
    [42, '数字'],
  ])('非对象输入（%s）为 false', (_label, input) => {
    expect(isEncPayload(input)).toBe(false)
  })
})
