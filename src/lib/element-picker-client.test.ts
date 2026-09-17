// 元素拾取发起侧封装的纯函数测试（docs/proposals/done/element-picker.md 验收：
// 「拾取期间用户关闭 / 导航页面 → 60 秒超时视为取消并明确提示（超时逻辑单测覆盖）」）。
// chrome.* 相关分支依赖真机环境，不在 node 单测覆盖（前置探针 tmp/probe-v4.mjs 已实机验证）。
import { describe, expect, it } from 'vitest'
import {
  userScriptsUnavailableMessage,
  withTimeout
} from './element-picker-client'

describe('withTimeout（超时兜底）', () => {
  it('先于超时完成：返回原值', async () => {
    const v = await withTimeout(Promise.resolve('ok'), 1000, '超时')
    expect(v).toBe('ok')
  })

  it('永不结算：按文案超时拒绝（页面关掉后注入 Promise 挂死的兜底）', async () => {
    await expect(withTimeout(new Promise(() => {}), 20, '拾取已取消：超时')).rejects.toThrow(
      '拾取已取消：超时',
    )
  })

  it('底层先失败：透传原始错误', async () => {
    await expect(
      withTimeout(Promise.reject(new Error('注入失败')), 1000, '超时'),
    ).rejects.toThrow('注入失败')
  })

  it('非 Error 的底层拒绝值：包装为 Error 透传', async () => {
    await expect(withTimeout(Promise.reject('boom'), 1000, '超时')).rejects.toThrow('boom')
  })
})

describe('userScripts 不可用引导文案', () => {
  it('给出用户可执行的指引（138+ 逐扩展开关）', () => {
    const msg = userScriptsUnavailableMessage()
    expect(msg).toContain('允许运行用户脚本')
    expect(msg).toContain('开发者模式')
  })
})
