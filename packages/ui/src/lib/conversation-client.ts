// 会话库的渲染页客户端：读直连、写交 offscreen。
//
// 分流不是随手分的：
//   · 读（list / search / messages）直连 IndexedDB —— 会话库同源共享，且面板首帧
//     不能押在 offscreen 容器活不活着上；
//   · 写（create / rename / delete / deleteAll）必须走 conv:* 命令 —— offscreen 是
//     会话库的唯一写方，双写会让消息落库顺序错乱。
// 写路径统一带「容器未响应就唤起再试一次」：扩展重载 / 崩溃后第一次点击不该直接报错。
import {
  listConversations,
  listMessages,
  searchConversations,
  type Conversation,
  type ConversationSearchHit,
  type Message,
} from '@duoling/shared'
import type { RuntimeRequest } from '@duoling/shared'
import { ipcRequest } from '@duoling/shared'
import { errorText } from './format'

/** 向 offscreen 发一次请求并解包；「容器未响应」类错误先唤起容器再试一次 */
async function sendOffscreen<T>(request: RuntimeRequest): Promise<T> {
  const sendOnce = () => ipcRequest<T>(request)
  try {
    return await sendOnce()
  } catch (e) {
    if (!/port closed|Receiving end does not exist|无响应/.test(errorText(e))) throw e

    await ipcRequest({ kind: 'offscreen:ensure' }).catch(() => {})
    return await sendOnce()
  }
}

export const conversationClient = {
  list: (): Promise<Conversation[]> => listConversations(),
  search: (query: string): Promise<ConversationSearchHit[]> => searchConversations(query),
  messages: (conversationId: string): Promise<Message[]> => listMessages(conversationId),

  create: (): Promise<Conversation> => sendOffscreen({ kind: 'conv:create' }),
  rename: (id: string, title: string): Promise<Conversation | null> =>
    sendOffscreen({ kind: 'conv:rename', id, title }),
  delete: (id: string): Promise<void> => sendOffscreen({ kind: 'conv:delete', id }),
  deleteAll: (): Promise<void> => sendOffscreen({ kind: 'conv:deleteAll' }),
}
