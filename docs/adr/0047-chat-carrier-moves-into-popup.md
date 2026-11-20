# 0047. 对话载体从网页浮层搬进 popup 的「当前页面」卡

日期: 2026-11-20
状态: 已接受（P0 / P1 已落地；浮层下线在 P2，届时取代 0010 / 0011）
代码落点: packages/ui/src/components/ChatHost.vue、packages/popup/src/components/PopupChat.vue、packages/ui/src/lib/chat-draft.ts、packages/service-worker/src/userscripts/pending-pick.ts

## 背景

对话原先只活在网页浮层里（floatpanel.html ← 浮层宿主件挂的 iframe）。那套形态的每一项复杂
都源自「它得挤进别人的页面」：shadow DOM 隔离、iframe 抗 CSP、拖拽把手落在父页、拾取期间整块
让位、CSP 拦载时的降级文案。

用户拍板：**浮层下线、不走 sidePanel、元素拾取必须保住**。popup 成为对话的唯一载体。

popup 与浮层的差别只有一条，但它是结构性的：**popup 一失焦就被浏览器销毁**。凡是「状态住在
文档里、等用户去点页面才能推进」的东西都会随文档一起没（拾取就是这一类）。

## 决策

- **载体上提**：对话的公共部分（数据接线 + 消息区 + 输入区 + 孤儿横幅）收进
  `packages/ui` 的 `ChatHost`，头行与载体专属能力（收起、遮罩、跳转）由载体经 slot / 事件
  接管。popup 与浮层共用**同一个** `useChat` 实例来源，避免同一会话被两条流同时回放。
- **位置**：对话挂在 popup 的「当前页面」卡里（`PopupChat`），不另起一屏 —— 这张卡本来就在
  回答「这一页现在什么情况」，对话就是这一页的对话（归属按标签页）。
- **不用 iframe**：popup 本身是扩展页，页面样式进不来、不受站点 CSP 约束，那层隔离是浮层的
  历史包袱；带过来只多付一次文档冷启动。
- **归属**：`useGlobalConversation` 接受显式 `tabId`。真实 popup 用 `resolveActiveTabId()`
  并在挂载前解析好（异步现查会让首条消息抢在归属落地前发出，落成「不绑定」）；
  `popup.html?tab=<id>` 为显式注入通道，服务 e2e 与深链 —— 那种打开方式下 active 是它自己
  那个扩展页，现查会把会话绑到一个读不了页面的对象上。
- **草稿**：输入框文本按 tabId 存 `chrome.storage.session`，**每次输入即落盘、不防抖**，发送成功即删。
  不防抖是被真机推翻过一次的设计：popup 点外面是硬拆文档，`pagehide` 里那句异步写不保证跑完，
  防抖窗口内关窗就是「敲完就点页面 = 一个字都没存」。串行链保证后写覆盖先写。
  popup 关窗丢文档，没有这份存储就等于「写到一半去点页面看一眼」必然丢字。
- **高度**：popup 上限 600px，对话是主角，故脚本列表与其他页面卡默认收起，点开才铺。
- **宽 380**：对话卡嵌在「当前页面」卡里，两层内边距后输入区还要并排放附件 / 拾取 / 模型。

## 备选与否决

- **sidePanel**：不随失焦关闭、拾取免改造，但要新增 `sidePanel` 权限、宽度把页面挤窄，
  且用户明确不走这条。
- **popup 上下分栏（对话 + 配置）**：配置面板单独就要 400px+，同屏两者都变成半截。
- **popup 只留对话、配置搬去工作台**：「这页在跑什么 / 记录开没开」这条快路径就没了。
- **iframe 承载对话**：见上，隔离在扩展页里没有对象可隔离。

## 代价与后果

- **拾取不在 popup 文档内闭环**（P1 已落地）：`picker:start` 只下发、立即返回，结论按标签页
  暂存在 `chrome.storage.session`（`pending-pick.ts`），popup 重开时 `picker:state` 取回，
  chip 消失（× / 发送后）才 `picker:clear`。SW 侧**不挂**等待中的 Promise —— popup 关掉是常态，
  SW 自己也会空闲回收，两头都不适合「有人等着」；超时改成读取时按 `startedAt` 判，不设定时器。
- **生成期页面遮罩只剩浮层有**：popup 不报 busy。浮层下线后需另定方案（当前默认是「什么都不
  盖」，见 P2）。
- 浮层下线（P2）时删 float-host 件、float-bridge、四个 `float:*` 命令、floatpanel 入口，
  e2e 的对话用例全部切到 `popup.html?tab=`。
