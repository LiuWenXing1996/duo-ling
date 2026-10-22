// 生成任务的运行时状态（IndexedDB `duoling-chat` 库的 tasks store）。
//
// 这不是 git 提交，只是任务运行时状态的 JSON——目的是「宿主被杀后有东西可继续」：
//   · 每步把文件树快照进任务记录（覆盖写、只留最新一份，历史由对话 tool parts 承载，不双份存）；
//   · 心跳由 chat-host 定时刷新；status=running 且心跳过期 = 孤儿（宿主被杀），
//     对话界面据此提示「继续 / 丢弃」；
//   · 任务正常收尾 / 用户中止时记录即删除——孤儿判定只认 running。
//
// 宿主差异说明：与会话同库——同域同写方
// （都归 offscreen），纯粹少开一个库。写只发生在 offscreen（对话链路的宿主），SW 与扩展页
import { getChatDexie, type ChatTaskRecord, type ChatTaskStatus } from '@duoling/shared'

export type { ChatTaskRecord, ChatTaskStatus }

/** 读一条任务记录；不存在返回 undefined */
export async function getTask(taskId: string): Promise<ChatTaskRecord | undefined> {
  return getChatDexie().tasks.get(taskId)
}

/** 写入 / 覆盖一条任务记录（覆盖写，只留最新一份） */
export async function putTask(record: ChatTaskRecord): Promise<void> {
  await getChatDexie().tasks.put(record)
}

/** 删除一条任务记录（任务收尾 / 用户丢弃时） */
export async function removeTask(taskId: string): Promise<void> {
  await getChatDexie().tasks.delete(taskId)
}

/** 全部 running 任务记录（孤儿判定由调用方按心跳过滤） */
export async function listRunningTasks(): Promise<ChatTaskRecord[]> {
  const all = await getChatDexie().tasks.toArray()
  return all.filter((r) => r.status === 'running')
}
