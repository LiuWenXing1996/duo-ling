// offscreen 容器的能力约定：SW 侧建文档时要声明的 reason 集。
//
// 为什么住本包：唯一消费方是 SW 侧（建文档的人），而 reason 值本身带 chrome.offscreen
// 的类型 —— 放 @duoling/shared 会破它「零 chrome.*」的铁律（那边的 types 是空数组）。
//
// 三项都与实际用到的能力对齐，且都不带自动关闭（只有 AUDIO_PLAYBACK 有 30s 无声自关），
// 故容器可长活：
//   · BLOBS     —— URL.createObjectURL（对话 agent loop 的流式数据通道；SW 里没有）
//   · WORKERS   —— 派生子 worker（ai SDK 的分词 / 嵌入等子任务）
//   · CLIPBOARD —— GM_setClipboard 在 offscreen 内写剪贴板（免用户手势 + 富文本）

/** offscreen 文档的 reason 集（建文档时原样交给 chrome.offscreen.createDocument） */
export const GM_OFFSCREEN_REASONS: `${chrome.offscreen.Reason}`[] = ['BLOBS', 'WORKERS', 'CLIPBOARD']
