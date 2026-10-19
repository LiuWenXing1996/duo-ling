# 0043. 脚本消息通道：MAIN ↔ 中继件 ↔ SW 两跳

日期: 2026-10-19
状态: 已接受
代码落点: packages/dl-core/src/messaging/（protocol / main-messenger / service-worker-messenger / relay）、
packages/dl-core/src/{mount-messaging-relay,install-messaging-relay}.ts

## 背景

脚本跑在 MAIN 世界，没有 `chrome.*`；能力在 Service Worker。原有链路是 MessagePort 三跳
（MAIN 建 MessageChannel → 中继件 → `runtime.connect` → SW），带 seq 配对，能用但形状重：
每脚本每条通道要先建 port、要处理握手、SW 回收后 port 变黑洞。（该链路已于 2026-10-19 整条删除，
见「与既有 SW 桥的关系」。）

这次按 `@webext-core/messaging` 的思路另起一条更薄的通道：**请求-应答**、一个协议映射表、
两段传输各用平台原语（CustomEvent / runtime 消息），不做常连、不做握手、不做重试。

## 决策

### 三段两跳

```
MAIN（DL.getTab/saveTab）──CustomEvent──▶ USER_SCRIPT 中继件 ──runtime.sendMessage──▶ SW
        ◀──CustomEvent──                          ◀──sendResponse──
```

- **MAIN ↔ 中继件**：`CustomEvent`，事件名固定（`dl-messaging:request` / `dl-messaging:response`），
  namespace 在 `detail` 里。用固定事件名而不是把 namespace 编进事件名，是因为 `addEventListener`
  没有通配，中继件只能监听确定的名字。
- **中继件 ↔ SW**：`runtime.sendMessage`。中继件注册在独立 world 并 `configureWorld({ messaging: true })`，
  否则世界内没有 `chrome.runtime`，这条腿直接断。SW 侧收端是 `runtime.onUserScriptMessage`
  —— userScripts 世界发出的消息走专用事件，不走通用 `onMessage`（与 `onUserScriptConnect` 同理，
  仓里已踩过两次）。

### 信封

```ts
// 请求（两跳共用 message 部分）
{ channel: 'dl-messaging', namespace, instanceId?, message: { id, type, data, timestamp, scriptId? } }
// 回包
{ ok: true, res } | { ok: false, err: { name, message, stack? } }
```

- `channel` 是固定哨兵：中继件只转哨兵匹配的事件；SW 侧只处理哨兵匹配的消息；其它监听者
  （dl-bridge）看到哨兵必须放行、不抢答 —— `runtime` 事件是广播，谁先 `sendResponse` 谁赢。
- `id` 由发起端自增，回包原样带回；配对表只在 MAIN 侧（`pending: Map<id, {resolve, reject}>`）。
  中继件与 SW 都是无状态回声，SW 重启不需要恢复任何上下文。
- `instanceId` 只用于回包过滤：同一页面会同时跑多个脚本，回包事件是 `window` 级的广播，
  靠它区分「这条回包是不是我这个实例的请求」。同一脚本内只有一份实例（见「其它约束与代价」）。
- `scriptId` 来自内核的 `registerId`，随消息带给 SW，仅作归属线索 —— 它是页面可伪造的字段，
  不是身份校验（见「安全边界」）。

### 类型面

`ProtocolMap` 支持两种写法（与 webext-core 对齐）：

```ts
interface ProtocolMap {
  'tab.get': (data: { tabId: number }) => TabInfo     // 函数式：入参 = data，返回值 = res
  'tab.save': ProtocolWithReturn<{ value: unknown }, void>
}
```

- `GetDataType<Entry>` 取入参（零参函数 = 无 data），`GetReturnType<Entry>` 取 `Awaited<返回值>`。
- 发送端 `sendMessage(type, data)` 与处理端 `onMessage(type, handler)` 共用同一张表，
  写错类型在编译期就挂；`data` 为 `undefined` 时该参数可省略。
- MAIN 侧只提供 `sendMessage`、SW 侧只提供 `onMessage`：方向是契约的一部分，不提供用不上的半边。

### 错误传播

| 场景 | 对端看到 |
| --- | --- |
| handler 抛错 | 同 `name` + `message` + `stack` + `code` 的 `Error`（`deserializeError` 重建） |
| handler 未注册 | `MessagingError`，`code: 'NO_HANDLER'` |
| 中继件拿不到 `chrome.runtime`（世界未开 messaging） | `MessagingError`，`code: 'TRANSPORT'` |
| `runtime.sendMessage` 的 `lastError`（SW 无接收端 / 中继失效） | 同上，带原始 message |
| 回包不符合信封（被别的监听者抢先应答） | `MessagingError`，`code: 'PROTOCOL'` |
| 数据不可序列化 | 发送前同步抛 `MessagingError`，`code: 'SERIALIZATION'`，附字段路径 |

没有超时：链路不存在时 Promise 会一直悬着，这是刻意的取舍（与 Port 链路同口径），
但**中继件在岗**的情况下每种失败都有明确回包，不会静默。

### 可序列化约束

`runtime.sendMessage` 走 JSON，`CustomEvent.detail` 走结构化克隆，两者交集是 JSON 能表达的值。
所以 `assertSerializable` 在发送前、以及 handler 返回后各校验一次：

- 允许：`null`、字符串、布尔、有限数字、数组、纯对象（原型是 `Object.prototype` 或 `null`）。
- 拒绝：`undefined`（顶层可省，嵌套会丢字段）、函数、Symbol、BigInt、非有限数字、
  `Date` / `Map` / `Set` / `RegExp` / `ArrayBuffer` / 类实例、DOM 节点、循环引用、Symbol 键。
- 报错带路径（`data.user.createdAt 是 Date`），并提示先转成 ISO 字符串 —— 拒绝而不是静默转换，
  因为 `Date → string`、`Map → {}` 这类降级在链路上无声无息，排查成本远高于一次显式报错。

## 文件划分

| 文件 | 职责 |
| --- | --- |
| `messaging/protocol.ts` | 类型面 + 线格式与守卫 + 错误序列化 + 可序列化校验 |
| `messaging/main-messenger.ts` | MAIN 侧 messenger：CustomEvent 传输、id 配对 |
| `messaging/service-worker-messenger.ts` | SW 侧 messenger：`onUserScriptMessage` 根监听、handler 表、按 namespace 的单例挂载 |
| `messaging/relay.ts` | USER_SCRIPT 中继件：转发两跳 + 失败兜底 |
| `messaging/index.ts` | 对外出口（类型 + 三个工厂 + 常量） |
| `mount-messaging-relay.ts` | 中继件 IIFE 入口 |
| `install-messaging-relay.ts` | 宿主侧注册面：独立 world + messaging + 保留名单 + 幂等注册 |
| `dl-protocol.ts` | DL 自己的协议表（`tab.get` / `tab.save`），MAIN 与 SW 共用 |
| `tab-store.ts` | tab 存取的 SW 侧落点：handler 注册 + 内存 Map + `tabs.onRemoved` 清理 |

`build.mts` 多一个目标 `mount-messaging-relay-iife.js`，正向守卫要求产物里真的出现
`sendMessage(` —— 中继件不转发就没有存在意义。

## 与既有 SW 桥的关系

初版写的是「并存，不替代」。**2026-10-19 追加：并存结束，MessagePort 桥整条下线。**
`DL.getTab/saveTab` 改走本通道的 `tab.get` / `tab.save`，SW 侧落点从 `mountSWBridgeManager`
换成 `mountTabStore`；`SWBridgeManager`、`sw-bridge.ts`、`mount-sw-bridge.ts`、
`install-sw-bridge-script.ts` 与构建目标 `mount-sw-bridge-iife.js` 一并删除。

删它的理由不是「新通道更时髦」，而是它带的三样东西在这里都不需要：每脚本一条常连 port、
握手、SW 回收后的重建。请求-应答型命令只需要一次往返，往返完了不留状态。

代价与语义变化写在明处：

- **没有推送**：旧桥能给 MAIN 侧 `on('推送')`，新通道只有请求-应答。当前没有任何调用方，
  将来要推送得另起一条（或改用 Port），不要指望在这个 Messenger 上补半边。
- **等待语义变了**：旧桥回包走 seq 配对，SW 失活时 Promise 悬着；新通道在中继件在岗时
  每种失败都有明确回包（`TRANSPORT` / `NO_HANDLER` / `PROTOCOL`），比旧桥更容易定位。
- **tab 归属来源不变**：仍取 `sender.tab.id`（浏览器盖章），`scriptId` 仍取消息字段。

## 安全边界

MAIN 世界就是页面，任何站点脚本都能伪造同形状的 CustomEvent，中继件无法分辨来源。
一期**不做** proof / 页面密钥校验（旧桥有），因为：

- 通道目前只暴露 `tab.get` / `tab.save`，落点是 SW 内存 Map，不落库、不外发、随 tab 关闭即焚；
- 伪造者能做的上限是「以别的 scriptId 读写本 tab 的内存值」，与迁移前 MessagePort 链路的
  攻击面**完全相同**（旧桥同样没有鉴权，scriptId 同样来自页面可写的字段）。

规则不变：**在挂上第一个真正有副作用（落库 / 发请求 / 改配置）的 handler 之前，必须先补鉴权** ——
落点是「SW 生成每扩展一把密钥 → 注册中继件时注入 → MAIN 内核拿到同一把」，形状与旧桥的
`bridgeDigest` 一致。`tab.save` 目前只写内存，尚不触发这条。

## 其它约束与代价

- **注册顺序**：中继件在 `initUserScripts` 里先于脚本库注册，Chrome 按注册顺序在同一
  `document_start` 执行，故中继件的监听先于脚本体就位。顺序若被打乱，首个请求会丢（无握手）。
- **每页一个中继件**：`allFrames: false`，与 SW 侧按 tab 记账的口径一致；iframe 内的脚本
  暂不在此通道服务范围内。
- **每脚本一个实例**：`DL` 内部首次用到时建实例，之后 `getTab/saveTab` 复用同一个。实例会在
  `window` 上挂一个常驻 `response` 监听且从不摘除，若每次调用都新建，监听数随调用次数增长，
  每条回包都要被所有实例各过滤一遍（O(n²)）。
- **`DL` 不暴露 messenger**：对外只有 `getTab` / `saveTab` 两个具体能力，messenger 与
  `ProtocolMap` 都是内部实现。理由是通道的另一半（handler）在 SW，`mountTabStore` 只注册了
  `tab.get` / `tab.save`；把 MAIN 半边公开，脚本就能用自造的 `ProtocolMap` 声明任意 type，
  编译期全过、运行期一律 `NO_HANDLER`。真要开放第三方 type，需要的是「SW 侧 handler 注册面 +
  鉴权」，届时再把入口提到 `DL` 上。
- **不暴露 namespace 与 logger**：`namespace` 固定默认分区（`dl`），没有日志开关。两者都是按
  「库给第三方用」设计的参数，本仓一处也没传过；`Logger` 更是从未被注入，`#logger?.debug` 的
  7 处打点全在空转，2026-10-19 连同类型一起删除。底层 `mountServiceWorkerMessaging({ namespace })`
  与 `mountMessagingRelay({ namespaces })` 仍保留分区能力，要开第二个分区时一并往上提。
- **dl-bridge 需放行异通道信封**：它的 `onUserScriptMessage` 监听会对所有陌生消息回
  「非 DL 消息」。新通道的信封带 `channel` 字段，dl-bridge 见到非空 `channel` 直接放行，
  避免「谁先注册谁应答」的隐式依赖。
- **SW 侧监听必须同步**：`mountServiceWorkerMessaging()`（当前入口是 `mountTabStore()`）要在
  `defineBackground` 回调里、任何 `await` 之前调用 —— SW 休眠后中继件的 `sendMessage` 是唤醒
  动作，监听不在同步注册表里就收不到这次投递。

## 备选与否决

- **直接用 `@webext-core/messaging`**：它只有两段（page/content/extension 各一种 messenger），
  要接成 MAIN → USER_SCRIPT → SW 仍得自己写中继件与转发协议；再加一层「只做转发」的 messenger
  反而多一层信封转换。且它不在本包依赖里（只是 proxy-service 的传递依赖），直接依赖会引入
  版本升级面。
- **复用现有 MessagePort 链路**：常连 port + seq 已经能跑，但每脚本一条 port、SW 回收后重建、
  页面侧要等 handshake；请求-应答场景不需要常连。
- **给 `DL` 加 `postMessage/onMessage` 裸通道**：没有类型面，也没有错误/序列化约束，
  脚本侧会各写一套信封 —— 正是本 ADR 要收掉的分叉。
