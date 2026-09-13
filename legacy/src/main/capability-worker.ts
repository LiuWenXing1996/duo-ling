// capability-worker：utilityProcess 子进程入口（PRD §8.3 后端运行域）
//
// 由主进程通过 utilityProcess.fork 拉起的独立进程，专门承载 backend 能力执行。
// 崩溃、越权被关在此进程内，不拖垮宿主；主进程仅通过 postMessage 与其通信。
// 注意：此文件必须在 electron.vite.config.ts 的 main.build 中注册为独立入口。

import { backendImpls } from './capability-backend'
import type { CapabilityRunRequest, CapabilityRunResult } from './capability-registry'

// Electron utilityProcess 子进程通过 process.parentPort 与父进程双向通信
const parentPort = process.parentPort

parentPort.on('message', (event) => {
  const { requestId, id, args } = event.data as CapabilityRunRequest

  const reply = async (): Promise<CapabilityRunResult> => {
    try {
      const impl = backendImpls[id]
      if (!impl) throw new Error(`未知能力: ${id}`)
      return { requestId, ok: true, result: await impl(args) }
    } catch (error) {
      return {
        requestId,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  void reply().then((message) => parentPort.postMessage(message))
})
