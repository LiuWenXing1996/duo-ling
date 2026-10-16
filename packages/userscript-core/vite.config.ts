import dts from 'vite-plugin-dts'
import { defineConfig } from 'vitest/config'

// GM 语义与存储内核包：一份 vite.config 同时喂构建（lib 模式）与单测（vitest）。
//
// 产物（与 package.json 的 exports 对齐）：dist/index.mjs（ESM）/ dist/index.cjs（CJS）/
// dist/*.d.ts（类型出口，index.d.ts 为入口）。
// @duoling/shared 外部化：它自身是 Vite lib 构建包，依赖走标准 npm 语义
// （package.json 的 workspace:* 链接 + 消费方按 exports 解析），不打进产物。
// 测试经相对路径 import 直取源码，不经过 dist —— 测试永远测的是源码真相。
export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.ts',
      formats: ['es', 'cjs'],
      // 文件名与 exports 钉死：ESM → index.mjs，CJS → index.cjs（type: module 下默认扩展名会漂）
      fileName: (format) => `index.${format === 'es' ? 'mjs' : 'cjs'}`,
    },
    rollupOptions: {
      external: ['@duoling/shared'],
    },
    sourcemap: true,
  },
  plugins: [
    // d.ts 按源码结构落 dist/；测试文件不进类型面
    dts({ include: ['src'], exclude: ['src/**/*.test.ts'] }),
  ],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
