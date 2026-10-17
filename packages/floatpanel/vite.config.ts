import { isAbsolute } from 'node:path'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// 与 ui 包同一份构建口径（见 ../ui/vite.config.ts 的说明），差异只有入口。
const externalDeps = (id: string): boolean =>
  !id.startsWith('\0') && !id.startsWith('.') && !isAbsolute(id)

export default defineConfig({
  plugins: [vue()],
  build: {
    lib: { entry: 'src/index.ts', formats: ['es'], fileName: () => 'index.mjs' },
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
