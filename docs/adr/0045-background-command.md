# 0045. 后台命令：脚本登记、宿主按三元组寻址

日期: 2026-10-20
状态: 已接受
代码落点: packages/dl-core/src/service/command-service.ts、packages/dl-core/src/messaging/service-worker-messenger.ts 的 `onPortClosed`、packages/dl-core/src/dl.ts 的 `registerBackgroundCommand`、packages/dl-core/src/runtime.ts 的 `listBackgroundCommands` / `invokeBackgroundCommand`

## 背景

脚本需要能对「后台」暴露一个**有名字的入口**，让宿主（侧栏 / popup / 命令面板 / AI 工具）在
未来某个时刻按需调用它。现有的 `onRequest(type, handler)`（当时经 `DL.onRequest` 暴露，现已收为
内核内部）做不到这件事：它只有 type 没有名字，
外部无从枚举；也不知道该 handler 挂在哪个 tab 的哪个脚本上，调用方拿不到寻址信息。

`GM_registerMenuCommand` 那类「注册给 UI 的入口」是同一族需求，但入口是浏览器右键菜单，不是
可编程的调用面。这条 ADR 只解决后者。

## 决策

- **三元组寻址 `(tabId, scriptId, name)`**：不做「按名字全局查找」。同名命令可以同时存在于多个
  tab 的同名脚本上，它们是不同的命令 —— 调用方必须自己指明要哪一个。这也是「命令挂在某个标签页的
  某个脚本上」这个模型的直接结果。
- **表在 SW，脚本页面是执行端**：`service/command-service.ts` 维护
  `Map<'${tabId}:${scriptId}', Map<name, { title?, at }>>`，key 与 messenger 的 `#ports` 同一个约定。
  表只用于枚举与快速失败，handler 始终在注册它的页面里跑。
- **脚本侧只有一个方法**：`DL.registerBackgroundCommand(name, handler, { title? })`，返回注销函数。
  内部两步：先 `MainWorldMessenger.onRequest('command.' + name, handler)`（同步生效），再经服务
  `command` 记账；第二步失败就撤掉 handler 再吞掉 —— 宁可命令不生效，也不留「页面能接、后台不知道」的半截状态。
- **没有脚本侧调用面**：MAIN 世界拿不到自己的 `tabId`（没有 `chrome.tabs`），跨 tab 更是任何 tabId
  都无从得知。唯一能完整给出三元组的是宿主，所以 `runBackgroundCommand` 这类 API 不提供；脚本间
  协调也走命令面 —— `onRequest` 已收为 `DL` 内部实现，脚本侧接请求只有这一条路。
- **宿主侧两个方法**（`DLRuntime`）：`listBackgroundCommands(tabId, scriptId)` 同步返回（表就在内存里），
  `invokeBackgroundCommand(tabId, scriptId, name, arg)` 走 `ServiceWorkerMessenger.sendToScript`。
  两者不进消息面，服务 handler 与 `DLRuntime` 调的是 `command-service.ts` 里同一份实现。
- **命令类型前缀 `command.`**：常量与拼接函数放在 `messaging/protocol.ts`，不放 command-service ——
  注入产物（`mount-dl` → `dl.ts`）只需要这个前缀，放错地方会把 SW 侧的 messenger 与 `chrome.*`
  一起拉进内核 bundle，撞 `build.mts` 的产物守卫。
- **`exported` 与 `PERMISSION` 都不加**：它们只为「脚本 A 调脚本 B 的非公开命令」存在。脚本侧没有
  调用面之后，跨脚本调用不存在，调用方只剩扩展自己 —— 没有需要区分的权限主体。错误码仍是
  `TRANSPORT | NO_HANDLER | PROTOCOL` 三个。
- **生命周期跟着那条消息线**：`ServiceWorkerMessenger.onPortClosed` 在 `port.onDisconnect` 里回调
  `(tabId, scriptId)`，命令服务收到即删整键。导航、关 tab、页面崩溃、扩展重载都被这一条覆盖，
  所以不需要 `tabs.onRemoved`，也不会出现「命令列得出来、其实接不通」的幽灵项。
- **表是唯一真相源，不做降级**：`invoke` 查不到就回 `NO_HANDLER`，不转发、不重试、不落盘。

## 让出的确定性

- **SW 空闲回收即失表**：SW 被回收后表清空，宿主拿到 `NO_HANDLER`，直到脚本重新注册 —— 而脚本
  的注册发生在页面加载时，页面不重载就不会再注册。也就是说，长时间停留的页面上的命令，在 SW
  重启之后会「消失」。本轮明确接受这个代价，不做反向 sync、不做 `storage.session` 持久化。
- **注册与可调用之间有一个窗口**：`registerBackgroundCommand` 的记账是异步请求，脚本刚注册完
  立刻被调用可能还没到账（`NO_HANDLER`）。页面侧的 handler 是同步装好的，所以这个窗口只会
  造成「早一步调用失败」，不会造成「调到了但没人接」。
- **`scriptId` 仍可伪造**：登记时 `scriptId` 取自帧，页面能冒充。与消息通道的信任模型一致，
  见 `docs/adr/0043-script-messaging-channel.md` 的安全边界段。

## 未采纳

| 方案 | 为什么不 |
| --- | --- |
| 命令体跑在 SW 里 | MV3 的 SW CSP 禁 `eval` / `new Function`，`importScripts(blob:)` 也被 `script-src 'self'` 挡，函数跨不了进程。脚本代码只能在页面里执行 |
| 按名字全局查（只给 name） | 同名命令在多个 tab 上并存时无法选出唯一目标；自动「全投」等于隐式广播，误伤面太大 |
| `storage.session` 持久化表 | 多一份要跟页面真相对账的副本；本轮既然接受 SW 回收丢表，就不引入这层 |
| SW 冷启动反向拉命令清单 | 只在「表丢了但页面还活着」时有价值；代价是一条新的反向同步协议 + 中继件重连重发 ping，本轮不做 |
