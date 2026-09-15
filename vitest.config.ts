import { defineConfig } from 'vitest/config'
import { WxtVitest } from 'wxt/testing/vitest-plugin'

// 测试基建（docs/testing-plan.md「基础设施」）：
// - WxtVitest() 负责 `@` 别名解析（tsconfig paths）、chrome.* mock（extensionApiMock）、
//   wxt 全局 auto-import；不要在此手配 alias
// - 环境固定 node（层 1/2/3 都是纯逻辑测试，不碰 DOM；组件测试层 4 届时再换 happy-dom）
// - 只收集 src/ 下跟源码同目录的 *.test.ts，不扫 legacy/
export default defineConfig({
  plugins: [WxtVitest()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
