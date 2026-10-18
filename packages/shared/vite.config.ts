import { defineConfig } from 'vitest/config'

// 共享层包（跨世界契约 + 共享实现）：源码直出（exports 指 src，构建收敛到消费方 ——
// WXT 主包与进程包自建时会把本包源码打进产物），本包不再自建 dist，
// 这份配置只喂单测（vitest）。测试经相对路径 import 直取源码 —— 测试永远测的是源码真相。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
