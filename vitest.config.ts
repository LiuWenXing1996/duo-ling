import { defineConfig } from 'vitest/config'
import { WxtVitest } from 'wxt/testing/vitest-plugin'

export default defineConfig({
  // WxtVitest() 提供：@ 别名解析、#imports 虚拟模块、chrome.* → fakeBrowser 桩
  // （测试计划 docs/testing-plan.md「基础设施」）。
  plugins: [WxtVitest()],
  test: {
    // 协议 / 纯逻辑测试不需要 DOM；需要 DOM 的层（组件测试）届时按文件覆盖
    environment: 'node',
    // *.test.ts 与源码同目录（测试计划约定），从 src 下递归收集
    include: ['src/**/*.test.ts'],
  },
})
