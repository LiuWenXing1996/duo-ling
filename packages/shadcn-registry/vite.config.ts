import { readdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

const externalDeps = (id: string): boolean =>
  !id.startsWith('\0') && !id.startsWith('.') && !isAbsolute(id)

const barrels = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return barrels(p)
    return e.name === 'index.ts' ? [p] : []
  })

const tsFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return tsFiles(p)
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [p] : []
  })

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': join(process.cwd(), 'src'),
    },
  },
  build: {
    lib: {
      entry: [...barrels('src/components'), ...tsFiles('src/lib')],
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
