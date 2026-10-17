# 0023. 生成中止：落盘「已经生成出来的那部分」

日期: 2026-10-18
状态: 已接受
代码落点: packages/offscreen-document/src/chat/chat-host.ts（persistPartial JSDoc 指回本文件）

## 背景

用户按停止、或关掉那个标签页，只是不要后续了——已经吐出来的文字仍然是他要的东西。

## 决策

- 中止时落盘已生成的半截：照样走同一条投影链（`buildFinalMessageFromChunks` 不依赖 finish chunk），额外附一个 `data-interrupted` 标记，让界面与会话历史能标出「这条没说完」。
- 两条刻意不做：
  - **不落产物**（半截脚本没有意义，落盘反而让人以为生成完了）；
  - **不留没有结果的工具调用**（见 isPendingToolUIPart——否则历史里是一串转不完的卡片）。
- 真正没内容可落时（除标记外一个 part 都没有）整条跳过，不写空消息。

## 备选与否决

- **整条丢掉**：用户丢掉的是他确实要的内容。
