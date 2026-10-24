import { defineConfig } from 'vitest/config'

// SW 进程包：源码直出（exports 指 src，编译收敛到消费方 —— WXT 主包把本包源码连同
// @duoling/shared 一起打进 background 产物）；唯一例外是 GM 包装注入体（dist 产物，?raw 消费）；本配置只喂单测。
// 中继件本体不在本包：user-scripts 的 src/builtin/relay/{entry,install}.ts 由那边 build.mjs
// 打成 IIFE 产物 dist/relay.iife.js（不入库），本包 sync.ts 经 `?raw` 取其字符串内嵌，随源码一起被主包编译进产物。
// 测试经相对路径 import 直取源码 —— 测试永远测的是源码真相。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
