// update-check.ts 单测（logic project）：版本比较、tag 解析、release 挑选、载荷裁剪。
// 四者都是纯函数，网络出口（fetchReleases）不经这些路径，故本文件不碰网络。
import { describe, expect, it } from 'vitest'
import {
  compareVersions,
  isValidVersion,
  parseTag,
  pickLatestRelease,
  toReleaseLite,
  type ReleaseLite,
} from './update-check'

describe('parseTag', () => {
  it('去掉 v 前缀', () => {
    expect(parseTag('v0.2.0-alpha.1')).toBe('0.2.0-alpha.1')
  })

  it('没有前缀时原样返回', () => {
    expect(parseTag('0.2.0')).toBe('0.2.0')
  })
})

describe('compareVersions', () => {
  it('按主次修订三段比较', () => {
    expect(compareVersions('0.2.0', '0.1.9')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0', '0.9.9')).toBeGreaterThan(0)
  })

  it('数字段按数值比，不是字典序', () => {
    expect(compareVersions('0.1.10', '0.1.9')).toBeGreaterThan(0)
  })

  it('相同版本为 0', () => {
    expect(compareVersions('0.2.0-alpha.1', '0.2.0-alpha.1')).toBe(0)
  })

  it('预发布 stage 顺序：alpha < beta < rc', () => {
    expect(compareVersions('0.2.0-alpha.1', '0.2.0-beta.1')).toBeLessThan(0)
    expect(compareVersions('0.2.0-beta.1', '0.2.0-rc.1')).toBeLessThan(0)
  })

  it('同 stage 比递增序号', () => {
    expect(compareVersions('0.2.0-alpha.1', '0.2.0-alpha.2')).toBeLessThan(0)
    expect(compareVersions('0.2.0-alpha.10', '0.2.0-alpha.9')).toBeGreaterThan(0)
  })

  it('稳定版大于同 base 的预发布版', () => {
    expect(compareVersions('0.2.0-rc.1', '0.2.0')).toBeLessThan(0)
    expect(compareVersions('0.2.0', '0.2.0-rc.1')).toBeGreaterThan(0)
    // 这条是本模块存在的理由：字符串比较方向正好相反，所以实现绝不能拿字符串比
    expect('0.2.0-alpha.1' > '0.2.0').toBe(true)
    expect(compareVersions('0.2.0-alpha.1', '0.2.0')).toBeLessThan(0)
  })

  it('预发布段数少的较小', () => {
    expect(compareVersions('0.2.0-alpha', '0.2.0-alpha.1')).toBeLessThan(0)
  })

  it('非法版本串抛错（不静默当作相等）', () => {
    expect(() => compareVersions('v0.2.0', '0.1.0')).toThrow()
    expect(() => compareVersions('0.1.0', 'latest')).toThrow()
  })
})

describe('isValidVersion', () => {
  it('认三段数字与可选预发布后缀', () => {
    expect(isValidVersion('0.2.0')).toBe(true)
    expect(isValidVersion('0.2.0-alpha.1')).toBe(true)
  })

  it('前缀、两段、空串都不认', () => {
    expect(isValidVersion('v0.2.0')).toBe(false)
    expect(isValidVersion('0.2')).toBe(false)
    expect(isValidVersion('')).toBe(false)
  })
})

/** 构造一条裁剪视图（测什么补什么） */
function rel(tag: string, extra: Partial<ReleaseLite> = {}): ReleaseLite {
  return { tag, prerelease: false, draft: false, htmlUrl: '', ...extra }
}

describe('pickLatestRelease', () => {
  it('按版本挑最高，不按列表顺序', () => {
    expect(pickLatestRelease([rel('v0.1.0'), rel('v0.3.0'), rel('v0.2.0')])?.tag).toBe('v0.3.0')
  })

  it('筛掉 draft', () => {
    expect(pickLatestRelease([rel('v0.2.0', { draft: true }), rel('v0.1.0')])?.tag).toBe('v0.1.0')
  })

  it('保留 prerelease —— 版本线长期是预发布，排除掉就永远查不到新版', () => {
    expect(pickLatestRelease([rel('v0.2.0-alpha.2', { prerelease: true }), rel('v0.1.0')])?.tag).toBe(
      'v0.2.0-alpha.2',
    )
  })

  it('跳过版本串无法解析的 tag', () => {
    expect(pickLatestRelease([rel('nightly'), rel('v0.1.0')])?.tag).toBe('v0.1.0')
  })

  it('空列表返回 null', () => {
    expect(pickLatestRelease([])).toBeNull()
  })

  it('全是 draft / 非法 tag 时返回 null', () => {
    expect(pickLatestRelease([rel('v0.1.0', { draft: true }), rel('nightly')])).toBeNull()
  })
})

describe('toReleaseLite（外部载荷的形状守卫）', () => {
  it('非对象返回 null', () => {
    expect(toReleaseLite(null)).toBeNull()
    expect(toReleaseLite(undefined)).toBeNull()
    expect(toReleaseLite('x')).toBeNull()
    expect(toReleaseLite(42)).toBeNull()
  })

  it('缺 / 空 / 非字符串 tag_name 返回 null', () => {
    expect(toReleaseLite({})).toBeNull()
    expect(toReleaseLite({ tag_name: 123 })).toBeNull()
    expect(toReleaseLite({ tag_name: '' })).toBeNull()
  })

  it('取出 tag / html_url / draft / prerelease', () => {
    expect(
      toReleaseLite({
        tag_name: 'v0.2.0',
        html_url: 'https://example.com/r',
        prerelease: true,
      }),
    ).toEqual({
      tag: 'v0.2.0',
      prerelease: true,
      draft: false,
      htmlUrl: 'https://example.com/r',
    })
  })

  it('html_url 缺失或非字符串时给空串（展示层不拿 undefined）', () => {
    expect(toReleaseLite({ tag_name: 'v0.2.0' })?.htmlUrl).toBe('')
    expect(toReleaseLite({ tag_name: 'v0.2.0', html_url: 42 })?.htmlUrl).toBe('')
  })

  it('draft / prerelease 只认布尔真值，不认真值字符串', () => {
    expect(toReleaseLite({ tag_name: 'v0.2.0', draft: 'yes' })?.draft).toBe(false)
    expect(toReleaseLite({ tag_name: 'v0.2.0', prerelease: true })?.prerelease).toBe(true)
  })
})
