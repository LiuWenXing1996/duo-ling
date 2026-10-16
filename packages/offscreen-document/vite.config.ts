import { isAbsolute } from 'node:path'
import dts from 'vite-plugin-dts'
import { defineConfig } from 'vitest/config'

// 外置一切 bare specifier（第三方 + @duoling/* + node:*）：产物只留 import，解析交给消费方；
// 排除 \0 开头的虚拟模块与相对 / 绝对路径 —— 那些必须内联。
const externalDeps = (id: string): boolean =>
  !id.startsWith('\0') && !id.startsWith('.') && !isAbsolute(id)

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
    passWithNoTests: true,
  },
})
