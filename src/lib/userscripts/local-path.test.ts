// 单测：本地路径 → file:// URL 的归一与校验（local-path.ts）。
// 覆盖四类坑：URL 形态前缀、`~` 不可展开、相对路径无基准、`#`/`?`/空格 的 URL 特殊含义。
import { describe, expect, it } from 'vitest'
import { looksLikeZip, toFileUrl } from './local-path'

/** 便捷：只取成功分支的 url（失败时断言消息更直观） */
function urlOf(input: string): string {
  const r = toFileUrl(input)
  if (!r.ok) throw new Error(`期望成功，实际被拒：${r.reason}`)
  return r.url
}

/** 便捷：只取失败分支的 reason */
function reasonOf(input: string): string {
  const r = toFileUrl(input)
  if (r.ok) throw new Error(`期望被拒，实际得到：${r.url}`)
  return r.reason
}

describe('toFileUrl 接受形态', () => {
  it('裸绝对路径', () => {
    expect(urlOf('/Users/me/duo.zip')).toBe('file:///Users/me/duo.zip')
  })

  it('urlOf 返回的 URL 协议是 file:', () => {
    expect(new URL(urlOf('/a/b.zip')).protocol).toBe('file:')
  })

  it('file:/// 形态（从别处复制来的 URL）', () => {
    expect(urlOf('file:///Users/me/duo.zip')).toBe('file:///Users/me/duo.zip')
  })

  it('file:/ 单斜杠形态', () => {
    expect(urlOf('file:/Users/me/duo.zip')).toBe('file:///Users/me/duo.zip')
  })

  it('file://localhost/ 形态', () => {
    expect(urlOf('file://localhost/Users/me/duo.zip')).toBe('file:///Users/me/duo.zip')
  })

  it('大小写不敏感（FILE://）', () => {
    expect(urlOf('FILE:///Users/me/duo.zip')).toBe('file:///Users/me/duo.zip')
  })

  it('前后空白被裁掉（粘贴常带）', () => {
    expect(urlOf('  /Users/me/duo.zip\n')).toBe('file:///Users/me/duo.zip')
  })

  it('返回的 path 是未编码的原始文件系统路径（供展示）', () => {
    const r = toFileUrl('/Users/me/my scripts/a b.zip')
    expect(r).toEqual({ ok: true, url: 'file:///Users/me/my%20scripts/a%20b.zip', path: '/Users/me/my scripts/a b.zip' })
  })

  it('Windows 盘符：反斜杠归一 + 补前导 /（盘符不能当 URL 主机）', () => {
    expect(urlOf(String.raw`C:\work\out.zip`)).toBe('file:///C:/work/out.zip')
    expect(urlOf('D:/work/out.zip')).toBe('file:///D:/work/out.zip')
  })
})

describe('toFileUrl 的 URL 特殊字符（不编码会被当 fragment / query 丢掉）', () => {
  it('# 被编码，不会截断成去读另一个文件', () => {
    expect(urlOf('/tmp/a#b.zip')).toBe('file:///tmp/a%23b.zip')
  })

  it('? 被编码', () => {
    expect(urlOf('/tmp/a?b.zip')).toBe('file:///tmp/a%3Fb.zip')
  })

  it('空格被编码为 %20', () => {
    expect(urlOf('/tmp/my pack.zip')).toBe('file:///tmp/my%20pack.zip')
  })

  it('分隔符 / 与已有 % 的段保持原样（不二次编码）', () => {
    expect(urlOf('/tmp/a%20b/c.zip')).toBe('file:///tmp/a%2520b/c.zip')
  })

  it('中文路径被编码（逐段）', () => {
    expect(urlOf('/tmp/脚本 包.zip')).toBe('file:///tmp/%E8%84%9A%E6%9C%AC%20%E5%8C%85.zip')
  })
})

describe('toFileUrl 拒绝并给人话原因', () => {
  it('空输入', () => {
    expect(reasonOf('   ')).toContain('请填写文件路径')
  })

  it('~ 无法展开（扩展里没有 HOME）', () => {
    expect(reasonOf('~/Downloads/a.zip')).toBe('~ 无法展开，请填绝对路径（以 / 开头）')
  })

  it('相对路径（没有基准目录可锚定）', () => {
    expect(reasonOf('tmp/a.zip')).toBe('请填绝对路径（以 / 开头）')
    expect(reasonOf('./a.zip')).toBe('请填绝对路径（以 / 开头）')
  })

  it('http(s) 网络地址：本期不做，不静默当本地路径', () => {
    expect(reasonOf('https://example.com/a.zip')).toContain('网络地址')
    expect(reasonOf('http://example.com/a.zip')).toContain('网络地址')
  })

  it('非 .zip 后缀（与文件选择器的筛选一致）', () => {
    expect(reasonOf('/Users/me/a.js')).toContain('只支持 .zip')
    expect(reasonOf('/Users/me/scripts')).toContain('只支持 .zip')
  })

  it('后缀大小写不敏感（.ZIP 放行）', () => {
    expect(urlOf('/Users/me/a.ZIP')).toBe('file:///Users/me/a.ZIP')
  })

  // 「无法转成 URL 的字符」这条兜底**不是死代码**（别顺手删）：路径逐段 encodeURIComponent 之后
  // 几乎什么都能编码，唯独**孤立代理项**（粘贴了半个 emoji / 截断的 UTF-8）会让 new URL 抛。
  // 实测（2026-09-19）：NUL 字符、超长路径都能过，只有孤立代理项走这条。
  it('孤立代理项（半个 emoji / 损坏的 UTF-8）→ 明确拦下，不静默变成别的错', () => {
    expect(reasonOf('/tmp/\ud83dx.zip')).toContain('无法转成 URL')
  })
})

describe('zip 魔数自检', () => {
  const bytes = (...v: number[]) => new Uint8Array(v)

  it('PK\\x03\\x04（普通 zip）通过', () => {
    expect(looksLikeZip(bytes(0x50, 0x4b, 0x03, 0x04, 0x00))).toBe(true)
  })

  it('PK\\x05\\x06（空 zip）通过', () => {
    expect(looksLikeZip(bytes(0x50, 0x4b, 0x05, 0x06))).toBe(true)
  })

  it('文本 / HTML / 过短内容被拦（后缀骗人时挡在解码层之前）', () => {
    expect(looksLikeZip(bytes(0x68, 0x65, 0x6c, 0x6c))).toBe(false)
    expect(looksLikeZip(bytes(0x3c, 0x21, 0x44, 0x4f))).toBe(false)
    expect(looksLikeZip(bytes(0x50, 0x4b))).toBe(false)
    expect(looksLikeZip(new Uint8Array())).toBe(false)
  })
})
