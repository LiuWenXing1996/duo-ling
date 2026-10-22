# 0044 SW ⇄ offscreen：一条 Port 承载命令、事件与服务调用

## Status

已接受（accepted）。SW 与 offscreen 之间现在只有这一条链路：命令、事件、服务调用三类帧都由它承载。

## 背景

本决策之前，SW 与 offscreen 之间有四种报文，形态不同但底座相同：

| # | 形态 | 底座 | 方向 |
|---|---|---|---|
| 1 | 命令面，`{ kind }` + `{ ok, data \| error }` | `runtime.sendMessage` 广播 | 双向 |
| 2 | `OffscreenService`，`@webext-core/proxy-service` | 同上，库自带信封 | SW / UI → off |
| 3 | `SWService`，只有 `isAlive()` | 同上 | off → SW |
| 4 | 单向推送 `chat:running` / `chat:finished` / `offscreen:ready` | 同上，不要应答 | off → SW |

`sendMessage` 是广播：SW 与 offscreen 都无法只发给对方。两端各自按 kind 前缀认领，不认的静默让路 —— `SW_KIND_PREFIXES` / `OFFSCREEN_KIND_PREFIXES` 与 ADR 0027 都是给这个平台缺陷打的补丁。**统一的前提是换传输，不是合并信封。**（这套补丁动不了：SW ⇄ off 改用链路之后，UI → off 还在用广播，前缀让路仍然必要。）

不在范围：`data:changed`（BroadcastChannel，写侧 → 全体读侧，选中它正是为了不唤醒 SW）、共享 IndexedDB（不是通信）、`createDocument`（生命周期）、`chat:chunk`（对端是 UI，不是 SW）。

## 决策

### 1 一条 Port，帧带 channel 哨兵

offscreen 与 SW 之间建立唯一一条 `runtime.connect({ name: 'duoling:sw-offscreen' })`。帧形状：

```ts
export const LINK_CHANNEL = 'duoling:link'

export type LinkFrame =
  | { ch: typeof LINK_CHANNEL; t: 'req'; id: number; type: string; payload?: unknown }
  | { ch: typeof LINK_CHANNEL; t: 'res'; id: number; ok: true; data: unknown }
  | { ch: typeof LINK_CHANNEL; t: 'res'; id: number; ok: false; err: LinkErrorData }
  | { ch: typeof LINK_CHANNEL; t: 'evt'; type: string; payload?: unknown }
```

`ch` 是哨兵：offscreen 同时还在收 UI 的 `sendMessage`，两条线并存期间靠形状猜报文必撞。判别只有一个函数、只比一个字段：

```ts
export function isLinkFrame(v: unknown): v is LinkFrame {
  return typeof v === 'object' && v !== null && (v as { ch?: unknown }).ch === LINK_CHANNEL
}
```

**不做逐帧形状校验**。两端同一份代码，帧过不了这一道说明代码有 bug，该在编译期/测试暴露，不该在协议层兜。

`type` 沿用现有 kind 字符串（`chat:abort`、`fs:ping`、`page:snapshot`…），handler 签名与类型收窄一行不改。`evt` 无 id、不应答，语义等同现在的 `ipcNotify`。

两端各有**两个入口**：SW 同时挂 `serveIpc`（给 UI）与 Port（给 off），offscreen 同理。handler 表只维护一份、两个入口共用 —— 这是「不新增第二套真相」的关键。差异仅在 `serveIpc` 的表项签名带 `sender`，link 入口补一个空壳；只在 UI 方向出现的 kind（`tab:identify` 这类）不会从 link 进来。

`req` 的 id 由发送方维护、只需在本端唯一，两端 id 空间互不干扰 —— 方向由「谁在读这一帧」决定，不由 type 区分。

### 2 通道层不认识「服务」

`svc` 只是 type 表里的一个条目，`service-dispatch` 是一个普通 handler —— 不在帧层开特例：

```ts
// 注册侧（offscreen）
link.serve('svc', async ({ method, args }) => {
  const fn = (service as Record<string, unknown>)[method]
  if (typeof fn !== 'function') throw new LinkError('NO_HANDLER', `未知服务方法：${method}`)
  return (fn as (...a: unknown[]) => Promise<unknown>).apply(service, args as unknown[])
})

// 消费侧（SW）
const offscreen = createServiceClient<IOffscreenService>(link, 'svc')
```

24 个方法不膨胀成 24 个 kind，kind 表仍可枚举；`implements IOffscreenService` 的类型闸原样留在实现类上，`createServiceClient<T>` 的方法名来自 `keyof T`，拼错编译期报错。

一个必须防的坑：`Proxy` 的 `get` 对任何属性都返回函数，`await client` 会先取 `then`。`get` 里 `if (prop === 'then') return undefined`。

### 3 错误码替代错误文案

```ts
export type LinkErrorCode = 'TRANSPORT' | 'TIMEOUT' | 'NO_HANDLER' | 'PROTOCOL' | 'REMOTE'

export class LinkError extends Error {
  constructor(readonly code: LinkErrorCode, message: string, readonly remote?: LinkErrorData) {
    super(message)
  }
}
```

跨线保留 `{ code, name, message, stack }`，收到 `res:ok=false` 时还原成 `LinkError`，`code` 为 `REMOTE` 时把对端原始 code 挂到 `remote`。

现状是 `background.ts` 与 `ui-client.ts` 各写一份正则去匹配「port closed / Receiving end does not exist / Could not establish connection」，**同一套重试判据抄了两遍且靠英文文案**。换成：

```ts
export const isTransportError = (e: unknown): boolean =>
  e instanceof LinkError && e.code === 'TRANSPORT'
```

`TIMEOUT` 不能并进 `TRANSPORT`：后者可重试，而超时的写操作重试一次就会重复执行。

### 4 连接所有权与 hello

**由 offscreen 发起**。它不是「谁活得久」，而是「谁的生命周期更不确定」：offscreen 按需创建、可被 `closeDocument` 销毁，由它发起，SW 只挂一个 `onConnect` 就够，不必在启动时探测「容器在不在」；反过来 SW 得在每次唤醒时先找 offscreen，多一段永远不可靠的探测。SW 重启后连接由 offscreen 侧的重连自动补上。

hello 是**普通 req**，不是独立帧类型：

```ts
await link.request('link:hello', { role: 'offscreen', instanceId, startedAt })
```

SW 侧 handler 收到即登记 port。这条不是礼节 —— 它是 **SW 主动下发的前置条件**：SW 只能回发到「发过 hello 的那条连接」，没有登记就找不到对端，`chat:abort` / `conv:*` 都发不出去。

SW 收到新 hello 时先 `old.disconnect()` 再登记（防扩展重载后残留两条）。同 `instanceId` 视为重连，不同视为 offscreen 重启。

### 5 断线与重连

| 情况 | 处理 |
|---|---|
| 未决 `req` | 立即 reject，`code: 'TRANSPORT'` |
| 发 `req` 时无连接 | reject `TRANSPORT`（调用方的 retry 钩子接手） |
| 发 `evt` 时无连接 | 丢弃，返回 `false` |
| 重连 | offscreen 侧指数退避 100 → 5000ms 封顶，无限重试 |
| 心跳 | 连接建立后每 5s 一次 `req link:ping`，断线即停 |
| 半死连接 | 心跳连续 2 次超时即主动 `disconnect()`，走重连（否则会对着一条不响应的 Port 空转） |

断线期间产生的事件一律丢弃、不排队：补发迟到命令比丢失更危险 —— 一条迟到的保存会在用户已经改完之后落盘。补齐靠在位机制（chat 走 `chat:resume` + seq，数据走 `data:changed` 回拉）。

心跳同时是保活：消息到达即重置 SW 空闲计时（原先靠 `SWService.isAlive()` 的往返，那条服务已随本决策删除）。Chrome 对 Port 也有硬上限，Port 本身不阻止 SW 回收，故心跳保留。

`request` 默认超时 30s；写操作调用点显式覆盖（保存要写 fs + 提交 git，慢起来没有上限，故给 120s 而不是让默认值猜）。

### 6 分腿：UI 不在这条线上

`runtime.connect` 只能连到 SW，扩展页无法直接 connect 到 offscreen。UI ⇄ offscreen 只能继续走广播，所以：

- `SW_KIND_PREFIXES` / `OFFSCREEN_KIND_PREFIXES` **在本次范围内删不掉**，它们拦的是 UI 的广播。
- `@webext-core/proxy-service` **不能删**：UI 侧还有 9 处直接调用（fs 组散在 workbench 与 chat 面板：读源码、git 历史、lfs 浏览、导出 zip、写资源）。本次只搬 SW 侧那 15 处调用点。

本次要达成的目标是可验证的：**SW 与 offscreen 之间的 `sendMessage` 流量归零**。判据是 offscreen 的 `serveIpc` 里 `sender` 不再出现 SW 来源（SW 的 `sender.url` 与扩展页不同）。

## 改动面

新增：

- `packages/shared/src/ipc/link-frame.ts` — 帧形状、错误码、`isLinkFrame`（零 chrome 类型）
- `packages/shared/src/ipc/link.ts` — 连接、pending 表、超时、退避重连、心跳。用结构形状取 `chrome.runtime`（同 `ipc-bus.ts` 的 `messagePort()`），不引入 chrome 类型。接收侧只用到 Port 的两个 listener 面、不涉及 `MessageSender`，故不触碰 ADR 0028 的分工理由 —— 它约束的是全局 `onMessage` 接收口。
- `packages/shared/src/ipc/link-service.ts` — `serve` / `createServiceClient`

同时删掉旧的四件：`shared/src/service/sw-service.ts`、`service-worker/src/sw-service.ts`、`offscreen-document/src/keepalive.ts`（含其单测），以及两处 `registerSWService` 调用、`fs:ping` 轮询、`OFFSCREEN_GONE` 正则。

## 落地结果

现状（三层各自的落点）：

- 契约与实现：`shared/src/ipc/link-frame.ts`（帧 / 错误码 / 判别）、`link.ts`（连接、pending、超时、退避重连、心跳）、`link-service.ts`（`svc` 寻址）。零 chrome 类型。
- offscreen 侧：`offscreen-document/src/link-host.ts` 发起连接并把 `OffscreenService` 挂成 `svc`；`bootstrap.ts` 订阅 `offscreen:configChanged` 与 `onOpen`（重连后补拉配置）；`chat/sw-bridge.ts` 的九条能力调用、`chat/event-bus.ts` 的两条任务事件都改走它。
- SW 侧：`service-worker/src/sw-link.ts` 接收连接、给出带重试的 `offscreenService` 代理与 `ensureLinkReady`；`background.ts` 在顶层挂链路，`linkHandlers` 承接原先只有 offscreen 会发的九条能力（`model:getActiveProfile` / `page:{snapshot,env}` / `userscript:{save,createProject,errorRead,runlog,runEvents,tabRecordRead}`）。
- 拆掉的旧面：`offscreen:ready`、`fs:ping`、`model:*` 等八条 kind 从 `RuntimeRequest` 联合与两端 handlers 表移除；`SWService` 两份、`keepalive` 一份删除；`SW_KIND_PREFIXES` 只保留 UI 广播那几条。

`chat:running` / `chat:finished` 不再广播后，UI 靠 SW 的 `sw:runningChanged` 得知「进行中」变了 —— 状态权威方转发一声，UI 不必认识 offscreen 的内部事件。

**配置变更回拉走广播、不走链路**（e2e 抓出来的修正）：写方可能在任何上下文（设置页直写 IDB，不经过 SW），而链路推送只能覆盖 SW 自己那份 model-store 实例的写 —— offscreen 的回拉触发最终挂回 `subscribeDataChange` 的 `model` 域广播；链路推送保留，只当 SW 侧写的补充。

剩下两处有意保留：`chat:chunk` 仍走广播（对端是可能多开的对话界面）、`@webext-core/proxy-service` 仍给扩展页用（UI 无法 connect 到 offscreen）。

## 后果

**收益**

- SW 与 off 之间从四条线收敛到一条，方向由「谁读它」决定，不再靠前缀让路
- 两处 `OFFSCREEN_GONE` 正则删掉，重试判据变成 `code === 'TRANSPORT'`
- `chat:running` / `chat:finished` 不再发广播：现在每一条都会到达所有扩展页与浮层 iframe，没有订阅方就丢弃
- `SWService` 整条服务消失
- 跨线错误的 `name` / `stack` / `code` 保留，现在只剩一句 `errorText`

**代价**

- 必须写重连与 pending 清理 —— 现在是「送不到就静默丢弃」的免费容忍
- 双线并存期（P1–P4）两套代码同时活着，直到 P5 才收敛
- `chat:chunk` 仍走广播，SW 仍会被每条 chunk 唤醒。改成 BroadcastChannel 是独立的机会，不在本 ADR 内

## 后续

**P6（未做）**：SW 成为唯一入口，UI → off 的命令经 SW 转发，offscreen 撤 `serveIpc`，两张白名单合成一张路由表。代价是每条 UI → off 命令多一次 SW 转发（不增加唤醒成本：现在就是广播，SW 已经醒了）。做不做取决于「少一张白名单」值不值这条转发。

**`chat:chunk` 的下一站**：仍是广播，SW 仍会被每条 chunk 唤醒。改 BroadcastChannel 是独立的机会，不在本 ADR 内。
