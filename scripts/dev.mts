#!/usr/bin/env node
// `pnpm run dev` 的入口：先把靶站起在随机端口上，再起本机假模型，最后启动 WXT 开发模式。
//
// 为什么 dev 自带靶站：webExt.startUrls 打开的就是靶站探针页（地址由本脚本经环境变量注入，
// 见 wxt.config.ts），靶站不在跑那个地址就是死的。不跑 dev 的场景（加载已构建的 .output 产物
// 做手测）用 `pnpm run probe:serve` 单起靶站。
//
// 端口用 0（随机）：本地可能同时开着别的靶站实例或 worktree，固定端口会撞。
//
// 为什么 dev 也起假模型：开发时想验对话链路（思考过程 / 工具卡 / 多步 agent loop）不必接真模型、
// 不必花真 Key。模型配置里存的是**完整端点地址**，所以这里用固定端口 —— 随机端口会让已保存的
// 配置每次重启都失效。地址打印在下面，在「设置 → 添加模型 → 服务商选自定义」里填一次即可长期复用。

import { spawn, spawnSync } from 'node:child_process'
import { startProbeTarget } from './probe-target.mts'
import { DEFAULT_PORT, startModelStub } from './model-stub.mts'

/** 假模型的固定端口（可经 DL_MODEL_STUB_PORT 覆盖）；被占则退回随机端口并提示重填地址 */
const MODEL_STUB_PORT = Number(process.env.DL_MODEL_STUB_PORT || DEFAULT_PORT)

const target = await startProbeTarget({ port: 0 })
console.log(`[dev] 靶站已就绪：${target.base}`)
console.log(`[dev] 探针页（浏览器会自动打开）：${target.url}`)

let model
try {
  model = await startModelStub({ port: MODEL_STUB_PORT })
} catch {
  model = await startModelStub({ port: 0 })
  console.warn(`[dev] 端口 ${MODEL_STUB_PORT} 被占用，假模型改用随机端口；已保存的模型地址需重新填写`)
}
console.log(`[dev] 假模型已就绪：${model.stub.baseUrl}`)
console.log('[dev] 手测对话链路：设置 → 添加模型 → 服务商选「自定义」→ 填入上面的地址（密钥可留空）')

// 参数原样转给 wxt（如 `pnpm run dev popup`），靶站只负责提供出网目标

// 仍需自建的子包产物必须先进各自 dist/：内置件包（wxt.config.ts 的 build:publicAssets
// 钩子取进扩展产物，缺了注册指向不存在的文件）。
// shared / service-worker / offscreen-document 与页面包（含并入 ui 的 shadcn 组件）源码
// 直出，不在此列 —— WXT dev 编译时直取 src（SW 的 build 只生成中继件源码模块，不产 dist）。
// `pnpm -r build` 按 workspace 依赖拓扑保证先后；dev 下**只构建一次** —— 自建包的源码
// 改动后重跑本命令生效，长跑用包内 `dev` watch。
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const built = spawnSync(pnpm, ['-r', 'build'], { stdio: 'inherit' })
if (built.status !== 0) {
  console.error('[dev] 子包构建失败，先修好它再起 dev')
  process.exit(built.status ?? 1)
}

const bin = process.platform === 'win32' ? 'wxt.cmd' : 'wxt'
const child = spawn(bin, process.argv.slice(2), {
  stdio: 'inherit',
  env: { ...process.env, DL_PROBE_URL: target.url },
})

const stop = () => child.kill('SIGINT')
process.on('SIGINT', stop)
process.on('SIGTERM', stop)

child.on('exit', (code) => {
  const modelServer = model.server
  const closeModel = new Promise((resolve) => modelServer.close(resolve))
  Promise.all([target.close(), closeModel]).finally(() => process.exit(code ?? 0))
})
