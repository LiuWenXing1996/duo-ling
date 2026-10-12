// env-snapshot 的单测：重点是**降级路径**与「不猜」原则。
//
// 最要紧的一条：Apple Silicon 上 Chrome 的 UA 里写着 `Intel Mac OS X`，没有 UA-CH 时必须把架构
// 留空 —— 报「Intel」是错值，比空值更坏（模型会据此写出错的判断，且无从怀疑）。
import { describe, expect, it } from 'vitest'
import { collectEnvSnapshot, platformFromUa, type EnvSnapshotDeps } from './env-snapshot'

/** Apple Silicon 上 Chrome 的真实 UA 形态：平台写着 Mac，架构写着 Intel（都不是架构真相） */
const MAC_ARM_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.7390.54 Safari/537.36'

/** Windows 上的 Edge：UA 里同时含 `Chrome/`，判浏览器名时不许把它读成 Chrome */
const WINDOWS_EDGE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0'

function deps(over: Partial<EnvSnapshotDeps> = {}): EnvSnapshotDeps {
  return {
    nav: { userAgent: MAC_ARM_UA },
    screen: { width: 1512, height: 982, availWidth: 1512, availHeight: 944, colorDepth: 30 },
    devicePixelRatio: 2,
    matchMedia: () => ({ matches: false }),
    timeZone: () => 'Asia/Shanghai',
    extension: () => ({ version: '0.10.0', dev: false }),
    ...over,
  }
}

describe('collectEnvSnapshot：三层取数', () => {
  it('UA-CH 可用时给架构、平台版本与完整版本（架构只有这条路能拿到）', async () => {
    const snap = await collectEnvSnapshot(
      deps({
        nav: {
          userAgent: MAC_ARM_UA,
          language: 'zh-CN',
          languages: ['zh-CN', 'zh'],
          hardwareConcurrency: 8,
          deviceMemory: 8,
          maxTouchPoints: 0,
          userAgentData: {
            platform: 'macOS',
            getHighEntropyValues: async () => ({
              architecture: 'arm',
              bitness: '64',
              platform: 'macOS',
              platformVersion: '15.1.0',
              fullVersionList: [
                { brand: 'Not)A;Brand', version: '99.0.0.0' },
                { brand: 'Chromium', version: '141.0.7390.54' },
                { brand: 'Google Chrome', version: '141.0.7390.54' },
              ],
            }),
          },
        },
      }),
    )
    expect(snap.os).toEqual({ platform: 'macOS', version: '15.1.0', arch: 'arm', bitness: '64' })
    expect(snap.browser).toEqual({ name: 'Chrome', version: '141.0.7390.54', ua: MAC_ARM_UA })
    expect(snap.cpu).toEqual({ cores: 8, memoryGB: 8 })
  })

  it('没有 UA-CH 时架构与平台版本留空——不从 UA 里那个 Intel 字样推', async () => {
    const snap = await collectEnvSnapshot(deps())
    expect(snap.os.platform).toBe('macOS')
    expect(snap.os.arch).toBe('')
    expect(snap.os.bitness).toBe('')
    // UA 里的 macOS 版本被浏览器冻结在 10_15_7，是假值，同样不兜底
    expect(snap.os.version).toBe('')
    // 浏览器版本可以信 UA（那是真值）
    expect(snap.browser.version).toBe('141.0.7390.54')
  })

  it('高熵值查询被拒时退化为 UA 兜底，其余字段不受牵连', async () => {
    const snap = await collectEnvSnapshot(
      deps({
        nav: {
          userAgent: MAC_ARM_UA,
          userAgentData: {
            platform: 'macOS',
            getHighEntropyValues: async () => {
              throw new Error('高熵值不可取')
            },
          },
        },
      }),
    )
    expect(snap.os.platform).toBe('macOS')
    expect(snap.os.arch).toBe('')
    expect(snap.display.width).toBe(1512)
    expect(snap.locale.timeZone).toBe('Asia/Shanghai')
  })

  it('高熵值返回空对象时，平台名仍从低熵值取到', async () => {
    const snap = await collectEnvSnapshot(
      deps({
        nav: {
          userAgent: MAC_ARM_UA,
          userAgentData: { platform: 'macOS', getHighEntropyValues: async () => ({}) },
        },
      }),
    )
    expect(snap.os.platform).toBe('macOS')
    expect(snap.os.arch).toBe('')
  })

  it('平台名判序：先 UA-CH 高熵、再低熵、最后 UA 解析', async () => {
    const fromLowEntropy = await collectEnvSnapshot(
      deps({
        nav: {
          userAgent: WINDOWS_EDGE_UA,
          userAgentData: { platform: 'Windows', getHighEntropyValues: async () => ({}) },
        },
      }),
    )
    // UA 说是 Windows、高熵值没给，取低熵的 Windows
    expect(fromLowEntropy.os.platform).toBe('Windows')

    const fromUa = await collectEnvSnapshot(deps({ nav: { userAgent: WINDOWS_EDGE_UA } }))
    expect(fromUa.os.platform).toBe('Windows')
  })

  it('UA 里含 Chrome 字样的 Edge 认成 Edge（判序即优先级）', async () => {
    const snap = await collectEnvSnapshot(deps({ nav: { userAgent: WINDOWS_EDGE_UA } }))
    expect(snap.browser.name).toBe('Edge')
  })

  it('单项缺席只影响该项：screen / matchMedia / timeZone 全无时其余照常', async () => {
    const snap = await collectEnvSnapshot(
      deps({
        screen: {},
        devicePixelRatio: undefined,
        matchMedia: undefined,
        timeZone: undefined,
      }),
    )
    expect(snap.display).toEqual({
      width: null,
      height: null,
      availWidth: null,
      availHeight: null,
      colorDepth: null,
      dpr: null,
    })
    expect(snap.prefs.darkMode).toBeNull()
    expect(snap.prefs.reducedMotion).toBeNull()
    expect(snap.locale.timeZone).toBe('')
    expect(snap.extension.version).toBe('0.10.0')
    expect(snap.browser.name).toBe('Chrome')
  })

  it('扩展版本与 dev 标识来自注入（manifest 的 version 装不下预发布标签）', async () => {
    const snap = await collectEnvSnapshot(
      deps({ extension: () => ({ version: '0.10.0-beta.1', dev: true }) }),
    )
    expect(snap.extension).toEqual({ version: '0.10.0-beta.1', dev: true })
  })

  it('系统偏好走 matchMedia，触摸点数走 navigator', async () => {
    const snap = await collectEnvSnapshot(
      deps({
        nav: { userAgent: MAC_ARM_UA, maxTouchPoints: 0 },
        matchMedia: (q) => ({ matches: q.includes('dark') }),
      }),
    )
    expect(snap.prefs.darkMode).toBe(true)
    expect(snap.prefs.reducedMotion).toBe(false)
    expect(snap.prefs.touchPoints).toBe(0)
  })

  it('matchMedia 抛错时该偏好为 null，不炸整份', async () => {
    const snap = await collectEnvSnapshot(
      deps({
        matchMedia: () => {
          throw new Error('不支持该查询')
        },
      }),
    )
    expect(snap.prefs.darkMode).toBeNull()
    expect(snap.extension.version).toBe('0.10.0')
  })
})

describe('platformFromUa', () => {
  it.each([
    [MAC_ARM_UA, 'macOS'],
    [WINDOWS_EDGE_UA, 'Windows'],
    ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36', 'Linux'],
    ['Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36', 'Android'],
    ['Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36', 'Chrome OS'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15', 'iOS'],
    ['', ''],
    ['完全认不出的串', ''],
  ])('%s → %s', (ua, expected) => {
    expect(platformFromUa(ua)).toBe(expected)
  })
})
