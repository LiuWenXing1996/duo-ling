import { isAbsolute } from 'node:path'
import dts from 'vite-plugin-dts'
import { defineConfig } from 'vitest/config'

// 共享层包（跨世界契约 + 共享实现）：一份 vite.config 同时喂构建（lib 模式）与单测（vitest）。
//
// 产物两件套（与 package.json 的 exports 两个条件对齐）：
//   dist/index.mjs（ESM，入口）/ dist/*.d.ts（类型出口，index.d.ts 为入口）。
// 单格式是刻意：全仓没有 cjs 消费方（SW / offscreen / 扩展页都经打包器），与其余基础设施包
// 口径一致 —— 要 cjs 得先有第二个消费方。
// 外置一切 bare specifier（第三方 + node:*）：产物只留 import，解析交给消费方；
// 排除 \0 开头的虚拟模块与相对 / 绝对路径 —— 那些必须内联。
const externalDeps = (id: string): boolean =>
  !id.startsWith('\0') && !id.startsWith('.') && !isAbsolute(id)

// 测试经相对路径 import 直取源码，不经过 dist —— 测试永远测的是源码真相。
export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
      // 文件名与 exports 钉死：type: module 下默认扩展名会漂成 index.js，与 exports 对不上
      fileName: () => 'index.mjs',
    },
    rolldownOptions: {
      external: externalDeps,
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
