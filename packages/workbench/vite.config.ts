import { isAbsolute } from 'node:path'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// 与 ui 包同一份构建口径（见 ../ui/vite.config.ts 的说明），差异只有入口与样式产物名。
const externalDeps = (id: string): boolean =>
  !id.startsWith('\0') && !id.startsWith('.') && !isAbsolute(id)

export default defineConfig({
  plugins: [vue()],
  build: {
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
      fileName: () => 'index.mjs',
      // 包内 4 个 SFC 带 <style> 块（两个 lang="less"）：钉住产物名，宿主入口按 `@duoling/workbench/style.css` 引入
      cssFileName: 'style',
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
