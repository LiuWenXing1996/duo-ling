// 主进程侧：管理 capability-worker 生命周期 + 统一 backend 能力调用入口（PRD §8.3）
//
// 前端不能直接 fork 子进程，只能经 IPC 走到这一层再转发给 utilityProcess。
// 所有传入参数先做 IPC 净化（JSON 序列化），规避 Vue 响应式 Proxy 无法被结构
// 化克隆序列化导致的报错（PRD §8.3「IPC 净化」）。

import { utilityProcess, type UtilityProcess } from 'electron'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  listCapabilities,
  type Capability,
  type CapabilityRunRequest,
  type CapabilityRunResult
} from './capability-registry'

// worker 编译产物与主进程入口同目录（out/main），扩展名须与当前入口一致
const WORKER_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  `capability-worker${extname(import.meta.url)}`
)

let worker: UtilityProcess | null = null
const pending = new Map<string, { resolve: (value: unknown) => void; reject: (err: Error) => void }>()

function handleMessage(message: CapabilityRunResult): void {
  const entry = pending.get(message.requestId)
  if (!entry) return
  pending.delete(message.requestId)
  if (message.ok) entry.resolve(message.result)
  else entry.reject(new Error(message.error))
}

function ensureWorker(): UtilityProcess {
  if (worker) return worker

  const proc = utilityProcess.fork(WORKER_PATH)
  proc.on('message', (message: unknown) => handleMessage(message as CapabilityRunResult))
  proc.on('exit', () => {
    worker = null
    // 进程退出时拒绝所有仍在等待的回执，避免调用方永久挂起
    for (const [requestId, entry] of pending) {
      entry.reject(new Error('能力执行进程已退出'))
      pending.delete(requestId)
    }
  })

  worker = proc
  return proc
}

/** 净化参数：经 JSON 序列化剥离 Vue 响应式 Proxy 等不可克隆特性 */
function clean<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** 渲染层查询能力清单：返回两个分域合并后的全部契约 */
export function listCapabilitiesHandler(): Capability[] {
  return listCapabilities()
}

/** 执行 backend 能力：转发给 capability-worker，等待回执 */
export function runBackendCapability(id: string, args: unknown): Promise<unknown> {
  const proc = ensureWorker()
  const request: CapabilityRunRequest = {
    requestId: `${Date.now()}-${Math.random()}`,
    id,
    args: clean(args)
  }
  return new Promise((resolve, reject) => {
    pending.set(request.requestId, { resolve, reject })
    proc.postMessage(request)
  })
}
