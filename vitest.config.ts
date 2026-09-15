import { defineConfig } from 'vitest/config'
import { WxtVitest } from 'wxt/testing/vitest-plugin'

// WxtVitest() 已内置：@ 别名解析（tsconfig paths）、chrome.*/browser.* mock
// （extensionApiMock：全局 stub 成 @webext-core/fake-browser 的 fakeBrowser）、
// globals 自动导入。不要在此手配 alias。
export default defineConfig({
  plugins: [WxtVitest()],
  test: {
    // 只收扩展工程的测试（跟源码同目录）；legacy/ 是归档只读区，其 spec 不参与
    include: ['src/**/*.test.ts'],
  },
})
