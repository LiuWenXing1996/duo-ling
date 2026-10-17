import { isAbsolute } from 'node:path'
import dts from 'vite-plugin-dts'
import { defineConfig } from 'vitest/config'

// SW 进程包：一份 vite.config 同时喂构建（lib 模式）与单测（vitest）。
//
// 产物（与 package.json 的 exports 对齐）：dist/index.mjs（ESM-only）+ dist/*.d.ts
// （类型出口，index.d.ts 为入口）。单格式是刻意：全仓没有 cjs 消费方（SW / offscreen /
// 扩展页都经打包器），与其余基础设施包口径一致 —— 要 cjs 得先有第二个消费方。
//
// 中继件不在这里：src/relay/entry.ts 由 build-relay.mjs 前置打成 IIFE 源码串内嵌进产物
// （`{ code }` 注册，无公共资产文件），见该脚本头部。
//
// 外置一切 bare specifier（第三方 + @duoling/* + node:*）：产物只留 import，解析交给消费方；
// 排除 \0 开头的虚拟模块与相对 / 绝对路径 —— 那些必须内联。
//
// 例外：@duoling/builtin-scripts 必须内联。它的 exports 直指 .ts 源码（件本体不可
// re-export，见包内 index.ts），不是可被 Node 解析的运行时包 —— 外置会让产物 import
// 一份源码，WXT 在 Node 下加载 entrypoint 时解析其无扩展相对路径即失败。
const inlineDep = (id: string): boolean => id.startsWith('@duoling/builtin-scripts')

const externalDeps = (id: string): boolean =>
  !inlineDep(id) && !id.startsWith('\0') && !id.startsWith('.') && !isAbsolute(id)

export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
      fileName: () => 'index.mjs',
    },
    rolldownOptions: {
      external: externalDeps,
    },
    sourcemap: true,
  },
  plugins: [
    dts({ include: ['src'], exclude: ['src/**/*.test.ts'] }),
  ],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
