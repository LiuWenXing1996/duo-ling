// 把 gm-runtime 的产物拷进扩展的 src/public/gm-runtime/（wxt 的 publicDir = src/public，
// 构建时原样带入扩展）。由根 package.json 的 build 脚本在
// `pnpm --filter @duoling/gm-runtime build:runtime` 之后调用。
import { copyFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const dist = join(root, 'packages/gm-runtime/dist')
const dest = join(root, 'src/public/gm-runtime')
const files = ['sw/sw.js', 'injected/injected.js', 'injected-web/injected-web.js', 'offscreen/offscreen.js']

mkdirSync(dest, { recursive: true })
for (const rel of files) {
  const src = join(dist, rel)
  try {
    copyFileSync(src, join(dest, rel.split('/')[1]))
  } catch (e) {
    console.error(`[copy-gm-runtime] 缺产物 ${rel} —— 先跑 pnpm --filter @duoling/gm-runtime build:runtime`)
    throw e
  }
}
console.log(`[copy-gm-runtime] ${files.length} 个产物 → public/gm-runtime/`)
