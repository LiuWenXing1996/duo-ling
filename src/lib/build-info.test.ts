// 逻辑测试：构建信息取数（src/lib/build-info.ts）。
//
// 页面侧读的是 define 注入的裸标识符 —— vitest 里没有该注入，正好覆盖「缺失时走 null 兜底」；
// SW 侧走 chrome.runtime.sendMessage，此处 stub 通道，覆盖「一次成功 / 抖动后重试成功 /
// 重试耗尽 / lastError」四条路径（该重试逻辑原先埋在 WorkspaceTabs 组件里、无测试）。
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fetchSwBuildStamp,
  fmtBuildTime,
  readInjectedBuildInfo,
  readPageBuildStamp,
} from './build-info'

/** 用本地时区构造 ISO，避免断言受运行环境 TZ 影响 */
const isoOf = (...args: [number, number, number, number, number, number]): string =>
  new Date(...args).toISOString()

function stubChrome(
  sendMessage: (msg: unknown, cb: (r: unknown) => void) => void,
  lastError?: { message?: string }
): void {
  vi.stubGlobal('chrome', { runtime: { sendMessage, lastError } })
}

afterEach(() => vi.unstubAllGlobals())

describe('fmtBuildTime', () => {
  it('格式化为 MM-DD HH:mm:ss，月/日/时分秒补零', () => {
    expect(fmtBuildTime(isoOf(2026, 8, 20, 5, 4, 3))).toBe('09-20 05:04:03')
  })
})

describe('readInjectedBuildInfo / readPageBuildStamp', () => {
  it('未应用 define 的环境里返回 null（typeof 守卫，不抛 ReferenceError）', () => {
    expect(readInjectedBuildInfo()).toBeNull()
    expect(readPageBuildStamp()).toBeNull()
  })
})

describe('fetchSwBuildStamp', () => {
  it('一次成功：返回格式化好的标记', async () => {
    stubChrome((_m, cb) => cb({ ok: true, data: { time: isoOf(2026, 8, 20, 5, 4, 3), branch: 'feat/x' } }))
    await expect(fetchSwBuildStamp(3, 0)).resolves.toEqual({ branch: 'feat/x', time: '09-20 05:04:03' })
  })

  it('首次无应答、次次成功：重试后返回标记（不因单次抖动判死）', async () => {
    let calls = 0
    stubChrome((_m, cb) => {
      calls++
      // 首次无应答 = 旧 SW 已死、新 SW 监听器未注册完的窗口
      if (calls === 1) return cb(undefined)
      cb({ ok: true, data: { time: isoOf(2026, 8, 20, 5, 4, 3), branch: 'feat/x' } })
    })
    await expect(fetchSwBuildStamp(3, 0)).resolves.toEqual({ branch: 'feat/x', time: '09-20 05:04:03' })
    expect(calls).toBe(2)
  })

  it('重试耗尽仍无应答：返回 null 而非抛出（调用方据此显示「未响应」）', async () => {
    let calls = 0
    stubChrome((_m, cb) => {
      calls++
      cb(undefined)
    })
    await expect(fetchSwBuildStamp(3, 0)).resolves.toBeNull()
    expect(calls).toBe(3)
  })

  it('runtime.lastError（如无接收端）同样计入失败并按次数重试', async () => {
    let calls = 0
    stubChrome(
      (_m, cb) => {
        calls++
        cb(undefined)
      },
      { message: 'Could not establish connection. Receiving end does not exist.' }
    )
    await expect(fetchSwBuildStamp(2, 0)).resolves.toBeNull()
    expect(calls).toBe(2)
  })
})
