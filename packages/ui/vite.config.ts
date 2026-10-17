import { readdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// 外置一切 bare specifier（第三方 + @duoling/* + node:*）：产物只留 import，解析交给消费方
// （WXT 的 Vite）。排除 \0 开头的虚拟模块与相对 / 绝对路径 —— 那些必须内联。
const externalDeps = (id: string): boolean =>
  !id.startsWith('\0') && !id.startsWith('.') && !isAbsolute(id)

// 子路径导出（./lib/*、./composables/*、./components/*）各自要有独立入口。
// preserveModules 只输出「入口可达」的模块，纯重导出的 index.ts 会被折叠进引用方，
// dist 里就没有对应文件 —— exports 指向空气，消费方一 import 就解析失败。
// 递归：`./lib/*` 的 * 允许带斜杠，子目录也在导出面内
const tsFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return tsFiles(p)
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [p] : []
  })

const barrels = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return barrels(p)
    return e.name === 'index.ts' ? [p] : []
  })

// 页面包（ui / workbench / floatpanel / popup）共用这份构建口径，四份配置只差 entry。
//
// preserveModules 是这里唯一与进程包不同的地方：单文件产物下 `sideEffects: false` 只在
// 文件粒度生效，而整包就是一个文件 —— popup 只借三个原语也会把 ChatPanel 那棵树拉进来。
// 一个源文件对一个产物文件之后，摇树才按页面实际引用生效。
export default defineConfig({
  plugins: [vue()],
  build: {
    lib: {
      // 产物名由下面的 entryFileNames 按模块路径推出，故不设 fileName
      entry: [
        'src/index.ts',
        ...tsFiles('src/lib'),
        ...tsFiles('src/composables'),
        ...barrels('src/components'),
      ],
      formats: ['es'],
    },
    rolldownOptions: {
      external: externalDeps,
      output: {
        preserveModules: true,
        preserveModulesRoot: 'src',
        entryFileNames: '[name].mjs',
        chunkFileNames: '[name].mjs',
      },
    },
    sourcemap: true,
  },
})
