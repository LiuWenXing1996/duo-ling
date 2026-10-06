#!/usr/bin/env node
// `npm run dev` 的入口：先把靶站起在随机端口上，再启动 WXT 开发模式。
//
// 为什么 dev 自带靶站：webExt.startUrls 打开的就是靶站探针页（地址由本脚本经环境变量注入，
// 见 wxt.config.ts），靶站不在跑那个地址就是死的。不跑 dev 的场景（加载已构建的 .output 产物
// 做手测）用 `npm run probe:serve` 单起靶站。
//
// 端口用 0（随机）：本地可能同时开着别的靶站实例或 worktree，固定端口会撞。

import { spawn } from 'node:child_process'
import { startProbeTarget } from './probe-target.mjs'

const target = await startProbeTarget({ port: 0 })
console.log(`[dev] 靶站已就绪：${target.base}`)
console.log(`[dev] 探针页（浏览器会自动打开）：${target.url}`)

// 参数原样转给 wxt（如 `npm run dev -- popup`），靶站只负责提供出网目标
const bin = process.platform === 'win32' ? 'wxt.cmd' : 'wxt'
const child = spawn(bin, process.argv.slice(2), {
  stdio: 'inherit',
  env: { ...process.env, DL_PROBE_URL: target.url },
})

const stop = () => child.kill('SIGINT')
process.on('SIGINT', stop)
process.on('SIGTERM', stop)

child.on('exit', (code) => {
  target.close().finally(() => process.exit(code ?? 0))
})
