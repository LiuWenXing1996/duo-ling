# 0019. 对话资源引用：data-asset part，模型永远看不到图片字节

日期: 2026-10-18
状态: 已接受
代码落点: packages/shared/src/chat-assets.ts（文件头指针指回本文件）

## 背景

消息里怎么表达「这条消息带了一张图」，且这个表达会被三个消费点各自读。

## 决策

- 引用形状（`data-asset` part）在本文件**唯一定义**：纯数据 + 纯函数，只吃 `ai` 的类型（面板与 offscreen 都能 import）。
- **不用 file part 装这张图**：file part 的 `url` 只要不是 `data:` 开头，会被原样写进请求体的 `image_url.url` 交给服务端（见 @ai-sdk/openai-compatible 的消息转换），服务端够不到本机的 duoling-fs。改用自定义 `data-*` part 后，chat-host 送模型前过一道 messagesForModel 天然把它拦在模型之外、换成一行文字引用——**模型永远看不到图片字节，但知道这条消息带了图**。

## 三个消费点（口径都取自本文件，别再各写一份）

- 面板（ChatPanel）：挑出 part，按 id 取回 data URL → 显示 / 预览 / 下载；
- 发送侧（chat-host.messagesForModel）：换成 assetPlaceholderText 的一行文字；
- 会话库预览（conversation-store.previewOf）：正文为空时显示「[图片]」。
