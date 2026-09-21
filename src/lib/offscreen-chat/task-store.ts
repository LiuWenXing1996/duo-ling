// 生成任务的运行时状态（IndexedDB `duoling-chat` 库的 tasks store）。
//
// 这不是 git 提交，只是任务运行时状态的 JSON——目的是「宿主被杀后有东西可继续」：
//   · 每步把文件树快照进任务记录（覆盖写、只留最新一份，历史由对话 tool parts 承载，不双份存）；
//   · 心跳由 chat-host 定时刷新；status=running 且心跳过期 = 孤儿（宿主被杀），
//     对话界面据此提示「继续 / 丢弃」；
//   · 任务正常收尾 / 用户中止时记录即删除——孤儿判定只认 running。
//
// 宿主差异说明：与会话同库（v3 并入，原独立库 duoling-chat-tasks 已废弃）——同域同写方
// （都归 offscreen），纯粹少开一个库。写只发生在 offscreen（对话链路的宿主），SW 与扩展页
// 没有写入路径；库版本与 upgrade 由本模块与 conversation-store.ts 共同防御（都做 contains 检查）。
import { DB_VERSION, TASKS } from '../conversation-store'

/** 任务状态：running = 循环进行中（唯一参与孤儿判定的状态） */
export type ChatTaskStatus = 'running'

/** 一条生成任务记录（覆盖写：每步保留最新一份） */
export interface ChatTaskRecord {
  taskId: string
  conversationId: string
  status: ChatTaskStatus
  /** 已完成的循环步数（提示「中断在第 N 步」） */
  step: number
  /** 连续 apply 失败次数（script_apply 维护） */
  applyFailures: number
  /** 内存源码快照（最近一次 script_apply 成功后的内容；null = 尚未写过） */
  code: string | null
  /** 首条需求摘要（用户消息），「继续」时回给模型 */
  prompt: string
  /** 页面上下文（档 0 + 可选档 2，chat:start 随指令带来；形状见 extension-ipc.PageContextInfo） */
  pageContext?: import('@/shared/extension-ipc').PageContextInfo
  createdAt: number
  updatedAt: number
  /** 心跳（ms 时间戳），chat-host 每 5s 刷新；过期 = 孤儿 */
  heartbeat: number
}

const DB_NAME = 'duoling-chat'
const STORE = TASKS

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      // 只管自己的 store：conversations/messages/meta 的创建归 conversation-store 的 upgrade
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'taskId' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('本地数据读取失败'))
  })
}

/** 读一条任务记录；不存在返回 undefined */
export async function getTask(taskId: string): Promise<ChatTaskRecord | undefined> {
  const db = await openDb()
  const tx = db.transaction(STORE, 'readonly')
  return request(tx.objectStore(STORE).get(taskId))
}

/** 写入 / 覆盖一条任务记录（覆盖写，只留最新一份） */
export async function putTask(record: ChatTaskRecord): Promise<void> {
  const db = await openDb()
  const tx = db.transaction(STORE, 'readwrite')
  await request(tx.objectStore(STORE).put(record))
}

/** 删除一条任务记录（任务收尾 / 用户丢弃时） */
export async function removeTask(taskId: string): Promise<void> {
  const db = await openDb()
  const tx = db.transaction(STORE, 'readwrite')
  await request(tx.objectStore(STORE).delete(taskId))
}

/** 全部 running 任务记录（孤儿判定由调用方按心跳过滤） */
export async function listRunningTasks(): Promise<ChatTaskRecord[]> {
  const db = await openDb()
  const tx = db.transaction(STORE, 'readonly')
  const all = await request<ChatTaskRecord[]>(tx.objectStore(STORE).getAll())
  return (all ?? []).filter((r) => r.status === 'running')
}
