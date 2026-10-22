# 0045 UI → offscreen 一律经 SW 转发；旁路只留广播

## Status

已接受（accepted）。0044 的 P6 落地，并顺带收掉两处冗余：`chat:chunk` 换通道、配置回拉去重。

## 背景

0044 把 **SW ⇄ offscreen** 收敛成一条 Port，但 **UI → offscreen** 还在用三套旧面：

| # | 面 | 底座 | 代价 |
|---|---|---|---|
| 1 | `conv:*` / `chat:*` 命令 | `runtime.sendMessage` 广播 | SW 也会收到再静默让路；需要一张 `OFFSCREEN_KIND_PREFIXES` 与 SW 那张互补 |
| 2 | fs 组 9 处调用（读源码 / git 历史 / lfs / 导出 zip / 写资源） | `@webext-core/proxy-service` | 与链路并存的第二套服务实现（key + register + proxy），UI 与 SW 各一条通路 |
| 3 | `chat:chunk` 流式推送 | `runtime.sendMessage` 广播 | 每条 token 一次广播，**每条都唤醒 SW**，而 SW 对它不做任何事 |

`runtime.connect` 只能连到 SW，扩展页连不到 offscreen —— 这是平台事实，不是设计选择。所以「UI 直连容器」这条路不存在，只剩两个选项：维持广播，或者让 SW 转发。

## 决策

### 1 命令面：SW 转发，容器仍是唯一执行方

`SW_KIND_PREFIXES` 收下 `conv:` / `chat:`，每条 handler 都是同一句 `forwardToOffscreen(msg)`：

```ts
const { kind, ...payload } = msg          // kind 已是帧的 type，载荷不带副本
await ensureLinkReady()                   // 容器没起就先唤起，并等到能应答
link.request(kind, payload)
```

应答沿原路回给 UI。转发层负责两件事：容器未就绪时报明确错误（而不是让调用方看到 port closed）、`TRANSPORT` 错误唤起重试一次（容器刚被销毁是常态）。

语义不变的部分要写清楚：**执行方仍是 offscreen**（会话唯一写方、对话编排宿主），SW 只是门房。所以「会话库写只归 offscreen」这条不变量没有被转发削弱。

### 2 服务调用：`offscreen:call` 一条 kind，不铺 24 条

```ts
| { kind: 'offscreen:call'; method: keyof IOffscreenService; args: unknown[] }
```

`method` 用 `keyof IOffscreenService`，方法名拼错编译期就报；SW 侧只做一次 `apply` 派发。不把 24 个方法铺成 24 条 kind —— 那会让「方法清单」出现第二份真相。

### 3 流式推送：`chat:chunk` 换 BroadcastChannel

新通道 `duoling:chat-chunk`（`chat-chunk-broadcast.ts`），与 `data:changed` 同一套底座：BroadcastChannel 优先、拿不到时降级 `sendMessage`。

收端本来就是「可能多开的对话界面」，扇出语义与广播一致；换掉的是**唤醒 SW 的代价**。顺序由 `seq` 兜住（同一发送实例 FIFO，跨实例各自去重）。

### 4 offscreen 不再挂 onMessage

入口撤 `serveIpc`，`conv:*` / `chat:*` 改为逐条注册到链路（`LINK_KINDS`）；`OFFSCREEN_KIND_PREFIXES` 删除，两张前缀表合成一张。

代价是容器命令面只有一条入口 —— 调试时不能再用 `chrome.runtime.sendMessage` 直接打容器，要在 SW 的控制台里发。

### 5 proxy-service 退场

`createOffscreenService` / `registerOffscreenService` / `OFFSCREEN_SERVICE_KEY` 一并删除，`packages/shared` 因此**零第三方运行依赖**。仓库里最后一条 `@webext-core/proxy-service` 引用随之下线（`pnpm-lock.yaml` 待下一次 `pnpm install` 更新）。

### 6 配置回拉只留广播一条

`model` 域曾有双路：链路事件 `offscreen:configChanged` + `data:changed` 广播。链路那条只在 **SW 自己写**时发，而同样的写也会发广播；写方还可能是设置页直写 IDB（不经过 SW）—— 广播是超集，链路那条是纯冗余，且让一次写触发两次 `model:getActiveProfile`（缓存层不做去重）。故删 `setConfigChangedNotifier` 与对应的链路事件。

## 后果

**收益**

- 路由只剩一张表、一个入口：新增命令不必再想「归 SW 还是归容器」
- 容器零 `onMessage` 监听器：不会再出现「两端都接、抢答丢应答」
- `chat:chunk` 不再唤醒 SW；`model` 写不再拉两遍配置
- 服务代理库整条下线，shared 无运行依赖

**代价**

- 每条 UI → off 命令多一跳（不增加唤醒成本：原先的广播同样会唤醒 SW，只是它醒来后让路）
- SW 成为 UI 触达容器的单点：SW 异常时容器仍活着也用不上
- 转发层的错误语义要维护：容器未就绪 / TRANSPORT 重试，判据写在 `forwardToOffscreen` 一处
- 写命令经转发后仍只重试一次：`TRANSPORT` 时对端可能已执行，重复执行的幂等性由容器侧承担（保存链本就是「再存一次 = 无变化」）

## 仍在广播上的两条

`data:changed`（写侧 → 全体读侧，且**刻意不唤醒 SW**）与 `chat:chunk`（容器 → 可能多开的面板）。二者的对端都是「不确定数量、不确定在不在」的读者，与「点对点命令」不是一类问题 —— 链路不该去接管扇出。
