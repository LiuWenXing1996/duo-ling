// archive-transfer.ts 单测：字节 ↔ base64 往返保真、目录 / 文件名安全化。
// 两边同源是硬要求（offscreen 打包的目录名 == 面板下载的文件名），故规则在此钉死。
import { describe, expect, it } from 'vitest'
import { base64ToBytes, bytesToBase64, sanitizeDirName } from './archive-transfer'

describe('sanitizeDirName', () => {
  it('替换 Windows 保留字符与控制符，去结尾点 / 空白，超长截断', () => {
    expect(sanitizeDirName('a/b:c*d?"<>|')).toBe('a_b_c_d_____')
    expect(sanitizeDirName('  结尾点.  ')).toBe('结尾点')
    expect(sanitizeDirName('///')).toBe('___') // 全部是保留字符：替换后仍可作为目录名
    expect(sanitizeDirName('  ')).toBe('script') // 全空白才兜底
    expect(sanitizeDirName('x'.repeat(100))).toHaveLength(64)
  })
})

describe('base64 往返', () => {
  it('bytesToBase64 / base64ToBytes 逐字节保真（含非 ASCII 字节）', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255, 128])
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes)
  })
})
