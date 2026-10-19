# 0046. 浮层的自控指令改走 iframe 直连，不再绕 SW

日期: 2026-10-20
状态: 已接受
代码落点: packages/shared/src/float-host.ts、packages/floatpanel/src/ChatApp.vue 的 `postToHost`、packages/user-scripts/src/builtin/float-host/install.ts 的 message 监听

## 背景

浮层宿主的四条动作里，`collapse`（收起）与 `busy`（页面遮罩）的发起方**只有一处** —— 跑在
iframe 里的对话界面（`ChatApp.vue`）。它们当时走的是 `float:collapse` / `float:busy` 两条
RuntimeRequest → SW → `float.cmd` 事件帧 → 件的链路，也就是绕了整整一圈回到同一个页面上。

绕这一圈是有来历的。旧的 `ARCHITECTURE.md` 写着「刻意不用 `postMessage`」，理由是：宿主网页的
脚本挂在父 window 上，既能监听 message，也能用 `iframe.contentWindow.postMessage` 伪造来源，
那等于把「关掉扩展界面」开放给被注入的页面。

这条论证有一个没有验证过的前提：**页面脚本本来关不掉浮层**。事实不是这样。

## 决策

- **`collapse` / `busy` 改由 iframe 直接 `postMessage` 给父页的件**，不经过 SW。
  信封 `{ __dlFloatHost: true, cmd, busy? }`，形状与标记的唯一真相源是
  `packages/shared/src/float-host.ts`。
- **来源校验只认 `event.source === iframe.contentWindow`**：比 origin 字符串更硬（不依赖扩展
  origin 字面量，也不受扩展 id 变化影响），且天然排除页面自己发的同标签 message。
- **两条 RuntimeRequest（`float:collapse` / `float:busy`）与 SW 侧的两个下发函数一并删除**。
  留着就是双通道，迟早有人走错那条。
- **`float.cmd` 只剩 open 与 ping**：open 的发送方是握有 tabId 的宿主，ping 的结算在 SW
  （reqId 配对），二者都不具备「父页就在旁边」这个条件。

## 为什么不防伪

「防止被注入页面关掉浮层」这件事，在件选 `world: 'MAIN'` 的那天起就不可能成立：

- 件的 shadow root 是 `mode: 'open'`，容器 `#duoling-float-root` 就挂在页面 body 里 ——
  页面脚本一行 `document.getElementById('duoling-float-root').remove()` 就能删掉整块。
- 件与页面脚本共享同一个 JS 世界（MAIN 世界注入的定义就是这个）。DOM 对页面完全开放，
  我们只能管自己的闭包变量。
- 伪造一条 `postMessage` 比直接删 DOM **更麻烦**。一条防护只堵住麻烦的做法、堵不住简单的做法，
  收益是零，成本是每次收起都要绕四跳、要读一个可能为空的 `?tab=`。

顺带说清剩下的攻击面：伪造 `collapse` 的效果 = 浮层被收起来，用户可以再从 popup / 右键菜单
打开；伪造 `busy` 的效果 = 遮罩被关掉，与用户自己点「停止」的后果同级。两者都不涉及数据越权。

## 让出的确定性

- **不再有「来源可验」这层**：扩展命令通道的帧带 digest 签名，页面伪造不了；`postMessage`
  没有。接受，理由见上。
- **失去 tabId 这一层的显式归属**：直连不需要它 —— 谁创建的这个 iframe，指令就只作用于谁。
  这比「从 `?tab=` 读出来再发出去」更不可能出错（读不到时那条旧实现是静默丢弃）。
- **`busy` 与「浮层是否还活着」绑定得更紧**：iframe 被页面删掉后，`postMessage` 无处可去，
  与「件不在位」本来就是一回事。旧链路在这种情况下会走到 SW 再发现推不到，结果相同。

## 未采纳

| 方案 | 为什么不 |
| --- | --- |
| 维持经 SW 的 `float:collapse` / `float:busy` | 每次收起绕四跳、要读 `?tab=`、SW 回收期间会静默丢帧；换来的防伪在实际攻击面下等于零 |
| 用 `MessageChannel` 把 port 直传给 iframe | 首发仍要走 `postMessage`，而 `event.ports` 在父页的 message 事件里对页面脚本同样可见，不解决伪造 |
| 件改 `attachShadow({ mode: 'closed' })` | 只能挡住 shadow 内部，宿主元素 `#duoling-float-root` 仍在 body 里，`remove()` 一样有效 |
| 再叠一层 HMAC 校验 | 密钥必须能到 iframe（扩展页），也就必须经过页面可见的通道；页面拿得到一份就能伪造，纯属自欺 |
