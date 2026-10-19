# 0043. 脚本消息通道：MAIN ↔ 中继件 ↔ SW 两跳

日期: 2026-10-19
状态: 已接受（2026-10-20 两段传输各换过一次：中继件 ↔ SW 由 `runtime.sendMessage` 改为常驻 Port，
MAIN ↔ 中继件由 `CustomEvent` 改为 `MessagePort`（首条消息即带着 port 出去），见「变更」）
代码落点: packages/dl-core/src/messaging/（protocol / main-messenger / service-worker-messenger / relay）、
packages/dl-core/src/{mount-messaging-relay,install-messaging-relay}.ts

## 背景

脚本跑在 MAIN 世界，没有 `chrome.*`；能力在 Service Worker。原有链路是 MessagePort 三跳
（MAIN 建 MessageChannel → 中继件 → `runtime.connect` → SW），带 seq 配对，能用但形状重：
每脚本每条通道要先建 port、要处理握手、SW 回收后 port 变黑洞。（该链路已于 2026-10-19 整条删除，
见「与既有 SW 桥的关系」。）

这次按 `@webext-core/messaging` 的思路另起一条更薄的通道：**请求-应答**、一个协议映射表、
两段传输各用平台原语（`window.postMessage` / 一条常驻 Port），不做握手、不做重试。
（起初两跳分别用 `CustomEvent` 与 `runtime.sendMessage`，2026-10-20 前后各改过一次，见「变更」。）

## 决策

### 三段两跳

```
MAIN（DL.getTab/saveTab）──MessagePort──▶ USER_SCRIPT 中继件 ──常驻 Port──▶ SW
        ◀────MessagePort────                      ◀──port.postMessage──
```

- **MAIN ↔ 中继件**：**每脚本一条** `MessageChannel`，由该脚本的 `MainWorldMessenger` 实例建并自己持有，
  第一条消息就带着它一起发出去 ——
  请求本体走 `window.postMessage`，另一端（`port2`）随 transfer list 过去，中继件收下这条即拿到回程，
  并按帧里的 `scriptId` 存进自己的表里。没有握手、没有报到、没有单独的建线帧：
  `window` 上只出现首条 `request`，此后两边只走这条私线。
- **中继件 ↔ SW**：`runtime.connect` 建一条名为 `dl-messaging:port` 的常驻 Port，请求与回包共用它；
  SW 侧收端是 `runtime.onUserScriptConnect` —— userScripts 世界的连接走专用事件，不走通用 `onConnect`
  （与 `onUserScriptMessage` 同理，仓里已踩过三次）。中继件仍需 `configureWorld({ messaging: true })`，
  否则世界内没有 `chrome.runtime`，这条腿直接断。
- **改 Port 的收益**：SW 手里有了可长期持有的句柄，后续「SW 主动下发」不必再另开一条通道；
  代价是断线要自己接（`onDisconnect` → 退避重连），且 `sender.userScript.scriptId` 从此是
  中继件自己的 id —— 调用方身份只能取帧内声明的 `scriptId`。

### 信封

```ts
// 请求
{ channel: 'dl-messaging', kind: 'request', message: { id, type, data, scriptId? } }
// 回包
{ channel: 'dl-messaging', kind: 'response', scriptId?, id, type, ok: true, res }
{ channel: 'dl-messaging', kind: 'response', scriptId?, id, type, ok: false, err: { name, message, stack?, code? } }
// 断线（中继件 → MAIN，没有载荷）
{ channel: 'dl-messaging', kind: 'disconnect' }
```

- `channel` 是固定哨兵，`kind` 是唯一判别位：`protocol.ts` 的 `frameKind()` 只做这两件事，
  不再按形状猜帧类型。整条通道只剩 `request` / `response` / `disconnect` 三种 `kind`。
- `id` 由发起端自增，回包原样带回；配对表只在 MAIN 侧（`pending: Map<id, {resolve, reject}>`）。
  中继件与 SW 都是无状态回声，SW 重启不需要恢复任何上下文。一条私线只属于一个 messenger 实例，
  所以 `id` 在线上就是唯一的，不需要额外的实例标识（`instanceId` 已删）。
- `scriptId` 来自内核的 `registerId`，随消息带给 SW，同时是中继件那张「脚本 → 私线」表的 key ——
  回包原样带回它，中继件才投得回该脚本那条线。它是页面可伪造的字段，
  不是身份校验（见「安全边界」）。

### 类型面

通道只有两段具体签名：`sendMessage(type: string, data?: unknown): Promise<unknown>`、
`onMessage(type: string, handler: (message: SwMessage) => unknown | Promise<unknown>)`。

- 曾按 webext-core 铺过一层 `ProtocolMap` / `ProtocolWithReturn` / `GetDataType` / `GetReturnType` /
  `SendArgs`，2026-10-19 整层删除：全仓所有实例化都是 `Record<string, any>`，`ProtocolWithReturn`
  零引用，推导结果与 `unknown` 等价。
- 类型面已经上移一层 —— 脚本侧拿到的是服务代理的 `DeepAsync<T>`（见 ADR 0044）。通道这层再写一遍
  协议表，等于在下面挂一层永远推导不到具体形状的装置。
- MAIN 侧只提供 `sendMessage`、SW 侧只提供 `onMessage`：方向是契约的一部分，不提供用不上的半边。

### 错误传播

| 场景 | 对端看到 |
| --- | --- |
| handler 抛错 | 同 `name` + `message` + `stack` + `code` 的 `Error`（`deserializeError` 重建） |
| handler 未注册 | `MessagingError`，`code: 'NO_HANDLER'` |
| SW 侧常驻 Port 断开（SW 被回收） | 在途请求全部 `MessagingError`，`code: 'TRANSPORT'`，紧接着按退避重连 |
| 中继件连不上 SW（世界未开 messaging / 拿不到 `chrome.runtime`） | 请求入队并退避重连，期间**不回包**（Promise 悬着） |
| 回包不符合信封 | 已不在协议层判：数据帧只走私有 MessagePort，两端都是自己 |
| 数据过不了结构化克隆（函数 / DOM 节点 / 循环引用） | `port.postMessage` 同步抛 `DataCloneError`，`sendMessage` 直接 reject |

没有超时：链路不存在时 Promise 会一直悬着，这是刻意的取舍（与 Port 链路同口径），
但**中继件在岗**的情况下每种失败都有明确回包，不会静默。

### 序列化：不做预检

数据不在我们这层检查，交给平台。`MessagePort.postMessage` 走结构化克隆，
Chrome 的 `port.postMessage` 走 JSON —— 后者是前者的真子集，所以「克隆能过、JSON 过不去」的值
（`Date` / `Map` / `Set` / `RegExp` / `ArrayBuffer` / `NaN` / 嵌套 `undefined`）会在
中继件 → SW 那一段被静默降级成字符串、`{}` 或丢掉字段。

**曾经有一道 `assertSerializable` 前置拦截**（白名单 + 字段路径报错），2026-10-20 按要求删除：
它在链路上多插一道，排查时多一个要怀疑的环节；平台自己会抛的（`DataCloneError`）本来就不需要
我们再判一次。代价是上面那类静默降级重新回到“看日志也看不出哪一段坏的”状态 —— 这是明确接受的取舍。

## 文件划分

| 文件 | 职责 |
| --- | --- |
| `messaging/protocol.ts` | 信封类型 + `frameKind()` 判别 + 错误序列化 |
| `messaging/main-messenger.ts` | MAIN 侧 messenger：`MainWorldMessenger` 类，自身持有 `#link`（首条请求把 port 带出去、之后复用），`sendMessage` / `onRequest`，id 配对 |
| `messaging/service-worker-messenger.ts` | SW 侧 messenger：`ServiceWorkerMessenger` 类（惰性静态单例），`onUserScriptConnect` 收 Port、handler 表、`tabId:scriptId → Port` 索引，`onMessage` / `sendToScript` |
| `messaging/relay.ts` | USER_SCRIPT 中继件：`MessagingRelay` 类（`static readonly instance`），从主世界首条请求里收下 port、按 `scriptId` 存表，之后转发两跳 + 失败兜底 |
| `mount-messaging-relay.ts` | 中继件 IIFE 入口（`MessagingRelay.instance.mount()`） |
| `install-messaging-relay.ts` | 宿主侧注册面：独立 world + messaging + 保留名单 + 幂等注册 |
| `service/sw-service.ts` | 内核服务 `sw`：`getTab` / `saveTab`，工厂形式注册（见下一条 ADR） |

`build.mts` 多一个目标 `mount-messaging-relay-iife.js`，正向守卫要求产物里真的出现
`connect(` —— 中继件不建这条连接，通道就不存在；反向守卫要求它**不出现** `MessageChannel`
—— 私线归主世界建，中继件只接收转移过来的那端（`MessageChannel` 的守卫落在内核装配件上）。

## 与既有 SW 桥的关系

初版写的是「并存，不替代」。**2026-10-19 追加：并存结束，MessagePort 桥整条下线。**
`DL.getTab/saveTab` 改走本通道，SW 侧落点从 `mountSWBridgeManager` 换成 `mountTabStore`
（2026-10-19 第二轮：`mountTabStore` 与 `dl-protocol.ts` 又被 `service/sw-service.ts` 的内核服务
`sw` 取代，见 ADR 0044 —— 能力面统一成「服务代理」，协议表不再逐个能力登记）；
`SWBridgeManager`、`sw-bridge.ts`、`mount-sw-bridge.ts`、
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

MAIN 世界就是页面，首条请求连同那条 port 都摆在 `window` 上，站点脚本看得见、也伪造得出 ——
它塞一条带自己 port 的帧过去，中继件分辨不出来源。**换 MessagePort 不是设防**，
只是把后续的数据帧从公共总线上撤下来。一期**不做** proof / 页面密钥校验（旧桥有），因为：

- 通道目前只暴露内核服务 `sw`（`getTab` / `saveTab`），落点是 SW 内存 Map，不落库、不外发、随 tab 关闭即焚；
- 伪造者能做的上限是「读写本 tab 的内存值」，与迁移前 MessagePort 链路的攻击面**完全相同**
  （旧桥同样没有鉴权）。2026-10-19 起 `scriptId` 改以 `sender.userScript.scriptId` 为准，
  页面伪造消息里的 `scriptId` 不再能跨脚本读写；但页面仍可直接以**自己**的身份调用这些方法。

规则不变：**在挂上第一个真正有副作用（落库 / 发请求 / 改配置）的 handler 之前，必须先补鉴权** ——
落点是「SW 生成每扩展一把密钥 → 注册中继件时注入 → MAIN 内核拿到同一把」，形状与旧桥的
`bridgeDigest` 一致。`sw.saveTab` 目前只写内存，尚不触发这条。

## 其它约束与代价

- **注册顺序成了硬前提**：首条消息（连带那条 port）发出去时若中继件还没就位，这条线就废了 ——
  主世界以为自己建好了，后续消息全投进一条没有对端的 port，这一次调用一直悬着（与「没有超时」同一口径）。
  `initUserScripts` 里中继件先于脚本库注册，正常顺序成立；但两个世界都在 `document_start` 注入，
  彼此相对顺序不受我们控制 —— 这是本设计主动让出的那点确定性，换来的是零握手、零建线状态机。
- **每页一个中继件**：`allFrames: false`，与 SW 侧按 tab 记账的口径一致；iframe 内的脚本
  暂不在此通道服务范围内。
- **每脚本一条 port，线归 messenger 实例自己持有**：`MainWorldMessenger` 的 `#link` 是实例字段，
  首条请求时建线、把另一端随 transfer list 一起发出去，此后这个实例一直复用它。
  一个注入体只 new 一次（`MainWorldMessenger.instance` 单例），所以「每实例一条」在这里就等于「每脚本一条」；
  线不再挂到 `window` 上，也不存在跨实例交接。
  若每次调用都新建实例，会有多条线互顶（中继件按 `scriptId` 存表、新线顶掉旧的），这条不变。
- **`DL` 不暴露 messenger**：对外只有 `getTab` / `saveTab` / `getService` 三个具体能力，
  messenger 与信封都是内部实现。理由是通道的另一半（handler）在 SW：把 MAIN 半边公开，
  脚本就能自己造 type 发请求，编译期全过、运行期一律 `NO_HANDLER`。
  `getService` 是这条约束下的正解 —— SW 侧先有 `registerService` 这个 handler 注册面
  （`docs/adr/0044-proxy-service.md`），MAIN 侧才多一个按方法名寻址的入口；鉴权仍缺。
- **不暴露 logger，也不留 namespace**：`Logger` 从未被注入（`#logger?.debug` 那 7 处打点全在空转），
  2026-10-19 连同类型一起删除。`namespace` 走得更远 —— 同一天整条删除：它是按「库给第三方用」
  设计的参数，本仓一处也没传过，`DEFAULT_NAMESPACE`、两个 options 字段、SW 侧按 namespace 的单例表、
  中继件的白名单过滤全在空转。真要开第二条通道，改 `channel` 哨兵比加一个只在内部流转的分区维度更直接。
- **dl-bridge 的 `onUserScriptMessage` 已不再看到本通道**：中继件改走常驻 Port 后，这条消息面
  上只剩 GM 包装自己的转发；当初「见到非空 `channel` 直接放行」的约定随之失效。
- **SW 侧监听必须同步**：SW messenger 在第一次 `registerService` 时构造（当前入口是 `DLRuntime`
  构造函数里的 `mountSwService`），必须落在 `defineBackground` 的回调里、任何 `await` 之前 —— SW 休眠后
  中继件的 `sendMessage` 是唤醒动作，监听不在同步注册表里就收不到这次投递。

## 备选与否决

- **直接用 `@webext-core/messaging`**：它只有两段（page/content/extension 各一种 messenger），
  要接成 MAIN → USER_SCRIPT → SW 仍得自己写中继件与转发协议；再加一层「只做转发」的 messenger
  反而多一层信封转换。且它不在本包依赖里（只是 proxy-service 的传递依赖），直接依赖会引入
  版本升级面。
- **复用现有 MessagePort 链路**：常连 port + seq 已经能跑，但每脚本一条 port、SW 回收后重建、
  建线要一套时序；请求-应答场景不需要常连。
- **给 `DL` 加 `postMessage/onMessage` 裸通道**：没有类型面，也没有错误/序列化约束，
  脚本侧会各写一套信封 —— 正是本 ADR 要收掉的分叉。

## 变更（2026-10-20）：中继件 ↔ SW 改走常驻 Port

**改因**：请求-应答确实不需要常连，但「SW 主动下发」需要。`sendMessage` 是一次性通道，
SW 收到的只是事件 + 一次性的 `sendResponse`，拿不到任何可长期持有的句柄；`tabs.sendMessage`
到不了 userScripts 世界。要句柄只有 `runtime.connect` 一条路，而两条腿并存又多一套协议，
故整段替换而非新增。

**代价与取舍**：

- 断线要自己接：`onDisconnect` → 1s 起翻倍、封顶 15s 重连；在途请求按 `TRANSPORT` 结算，
  不再有「Promise 永远悬着」这种静默失败。
- `sender.userScript.scriptId` 从此恒为**中继件自己**的 id，调用方身份只能取帧内声明的
  `scriptId`（`contextOf` 的取值顺序随之反转）。这是本次唯一的能力降级。
- 「每脚本一条常连 port」的旧问题不复现：连接仍是**每帧一条**（中继件共享，`allFrames: false`）。

## 变更（2026-10-20）：MAIN → 中继件 改走 `postMessage`

**改因**：为「中继件向 MAIN 投递」做准备。`CustomEvent` 只有派发方与监听方能对上一件事，
但要换成 `MessagePort` 转移时，载体必须是 `postMessage`（transfer list 只有它有）。先把上行
这一段换掉，下行暂时留在 `CustomEvent` —— 一次只动一个方向，出问题好定位。

**代价**：

- 投递由同步变异步任务：`sendMessage` 里 `postMessage` 之后同一个 tick 里读不到效果，
  所有等待方本来就是 Promise，无感；但写单测时不能假定“派发完就到”。
- 语义上没有新增攻击面：页面脚本本来就能伪造同形状的 `CustomEvent`，换成 `postMessage` 一样能伪造；
  两道守卫都只靠 `isRequestDetail` 认帧。
- `MESSAGING_REQUEST_EVENT` 常量随之删除 —— 不再需要事件名，`isRequestDetail` 就是判据。

## 变更（2026-10-20）：中继件 → MAIN 也改走 `postMessage`

上一条只换了上行，下行（回包 / 断线）留在 `CustomEvent`。至此两侧统一，`CustomEvent` 全部退场。

- 回包帧结构不变，中继件直接 `window.postMessage(raw, '*')`；MAIN 侧两个监听（回包 / 断线）
  并成**一个** `message` 监听，先判断线帧、再判回包帧。
- 断线帧原本是 `CustomEvent(MESSAGING_DISCONNECT_EVENT)`，没有 `detail`。换成 `postMessage` 后
  必须有个能认的东西，于是给它加了 `kind: 'disconnect'` —— 全通道唯一带 `kind` 的帧，因为它
  形状上确实认不出来（没有 `id` / `ok` 这类可判字段）。
- `MESSAGING_RESPONSE_EVENT` / `MESSAGING_DISCONNECT_EVENT` 两个常量删除。
- 副作用（可接受）：`window` 上的 `message` 监听会收到自己发出去的帧，靠守卫过滤；额外几个
  分支判断，比留两套投递机制便宜。

## 变更（2026-10-20）：MAIN ↔ 中继件 改走 `MessagePort`（最终形态）

上面两段「改走 `postMessage`」是中间态，被本节取代：数据帧全部搬到 `MessageChannel` 上，
**每个脚本一条**，`window` 上只剩「主世界的第一条请求」这一种帧，带着私线另一端一起 transfer 过去。

**改因**：`window` 是一条公共总线 —— 每个请求、每个回包都会广播给页面上所有监听者，
接收方只能靠形状猜「这条是不是给我的」，自己发出去的帧还会绕回来。换成 port 后是点对点私线，
`frameKind()` 判一次 `channel` + `kind` 就够，不再逐个字段验形状。

**首条消息即建线**：

```
MAIN:  new MessageChannel()
       window.postMessage(request, '*', [port2])   // 请求本体 + 回程端，一句说完
中继件: links.set(key, event.ports[0]);            // key 取帧里的 scriptId
       ports[0].onmessage = …; queue.push(event.data)
```

**按脚本分线**：线是脚本私产 —— 主世界这边是 `MainWorldMessenger` 的实例字段 `#link`（实例由
`MainWorldMessenger.instance` 单例提供，所以实例边界就是脚本边界），中继件那边是
`Map<scriptId, MessagePort>`。回包由 SW 原样带回 `scriptId` 才投得回对应那条线，所以 `ResponseDetail`
有这个字段；`scriptId` 恒有（`DL` 构造必传 `registerId`），key 不做回退。断线帧例外：SW 掉了所有脚本
都受影响，中继件广播给每一条线。同脚本内若真出现第二个实例，它会建第二条线并顶掉第一条（中继件同 key
覆盖）—— 目前主世界只经由 `MainWorldMessenger.instance` 这个单例拿实例，不会走到这一步。

后来写过一版「`handshake` → `relay-ready` → `port` 三段控制帧」的握手（中继件建线，再翻成主世界建），
2026-10-20 按要求砍掉：私线的建立本来就可以由第一条消息顺手完成，多一个「你在吗 / 我在 / 给你线」
的往返只是把一次投递拆成三次，还把「谁建线」变成一个要维护的状态机。

**代价与取**：

- 建线成功与否主世界**无从感知**：没有对端接那条 `port2` 时，`port1.postMessage` 不报错，
  消息进一个没人读的队列。这条与「没有超时」是同一个取舍（见「其它约束与代价」的注册顺序一条）。
- 页面脚本能看见首条请求、也能伪造一条带 port 的帧把某个脚本那条线顶掉 —— 同一个 realm、同一个事件，
  藏不住。这是既有信任模型的延续，不是新增攻击面（见「安全边界」）。
- 中继件那张表按脚本数增长，没有淘汰：被顶掉的那条 `close()` 掉，其余随页面卸载一起消失。
- `MessagePort` 在 USER_SCRIPT world 下可转移（双向都已真机验证）；这条曾是整个方案唯一的未知项。
- `kind` 从「只有断线帧有」升级成所有帧都有：`protocol.ts` 里 5 个形状守卫
  （`isWireMessage` / `isWireResult` / `isRequestDetail` / `isResponseDetail` / `isDisconnectDetail`）
  连带删除，只剩一个 `frameKind()`；控制帧那三个 `kind` 也随之不存在，现在只有
  `request` / `response` / `disconnect`。

## 变更（2026-10-20）：中继件也收成单例

`relay.ts` 从「一个 `mountMessagingRelay()` 函数 + 闭包状态」改成 `MessagingRelay` 类：`port` /
`links` / `attempt` / `queue` 变成 `#` 字段，`static readonly instance` 供入口取用，`private constructor`
封死外部 `new`。入口随之只剩 `MessagingRelay.instance.mount()`。

- **`window.__dlMessagingRelay` 一并删掉**：中继件跑在 userscripts 的独立 world、只有一条世界注册，
  `mount()` 每文档必跑且只跑一次，那条 window 标记原本防的「同一 realm 被装第二遍」在这个世界不成立 ——
  留着只会让读代码的人以为有一道跨 bundle 的幂等守卫，而它挡不住任何真实情形。
- 附带修掉一处顺序依赖：原来 `schedule()` 引用 `open()` 要写成 `function open()` 靠函数提升，
  进类之后 `#schedule()` 直接调 `this.#open()`。
- `build.mts` 两道守卫不变（`connect(` 必须有、`MessageChannel` 不许有），产物形状没变。


## 变更（2026-10-20）：SW 侧 messenger 也收成单例（惰性）

`ServiceWorkerMessenger` 原先由 `proxy-service` 用 `swMessenger ??= new ServiceWorkerMessenger()`
兜住「SW 里只有一份」这件事，现在单例挪进类：`static #instance` + `static get instance()`，
`private constructor` 封死外部 `new`，`registerService` 直接取 `ServiceWorkerMessenger.instance`。

- **为什么是惰性 getter，不是 `MainWorldMessenger` 那种 `static readonly instance = new …`**：
  它的构造函数有副作用（`chrome.runtime.onUserScriptConnect.addListener`）。写成静态初始化器，
  这段代码就在**模块求值时**执行，内核 bundle（`mount-dl`）的引入链是
  `dl.ts → proxy-service → service-worker-messenger`，esbuild 会因此不敢摇掉这个模块，
  `chrome.runtime.*` 就落进注入产物，撞上 `build.mts` 的「主世界不许出现 `chrome.*`」守卫。
  惰性求值让类体只剩声明、模块仍然无副作用，产物照旧可以摇掉。
  验证方式：`grep -c onUserScriptConnect packages/dl-core/dist/mount-dl-iife.js` 必须是 `0`。
- **SW 侧语义不变**：`registerService` 是唯一入口，第一次调用才构造、挂监听，此后复用。
## 变更（2026-10-20）：反向请求（SW → 脚本）与自荐 ping

原来通道只有一个方向：脚本发请求、SW 应答。现在两端对称 —— **SW 也能主动找某个 tab 里的某个脚本**，
脚本侧用 `DL.onRequest(type, handler)` 接，SW 侧 `DLRuntime.sendToScript(tabId, scriptId, type, data)`
拿到同一个 `Promise`。实现上仍是「请求 / 回包」这一对帧，方向由谁读它决定，不由 `kind` 区分。

**信封拍平**（上一节那三行带 `message: {…}` 的写法作废）：

```ts
{ channel, kind: 'request',  id, type, scriptId, data? }
{ channel, kind: 'response', id, type, scriptId, ok, res?, err? }
{ channel, kind: 'disconnect' }
```

`WireMessage` 这层嵌套删了：反向请求要由中继件按 `scriptId` 选路，这个字段必须顶格；
上行时它是「发起者是谁」，下行时是「目标是谁」。

**两端各自变成 { handler 表, pending 表 }**：

| | 发 | 收 |
| --- | --- | --- |
| MAIN | `sendMessage` → `#pending` | `#dispatch`：`response` 结算 pending，`request` 交 `#handlers` 应答 |
| SW | `sendToScript` → `#pending` | `#serve`：`response` 结算 pending，`request` 交 `#handlers` 应答 |

两边各自产生 `id`，但配对表各管各的：MAIN 的 `#pending` 只由 SW 发来的 `response` 结算，
SW 的 `#pending` 只由脚本发来的 `response` 结算 —— 方向不同表不同，`id` 空间不需要全局唯一。

**SW 怎么找到「某个 tab 的某个脚本」那条 port**：`#ports: Map<'${tabId}:${scriptId}', Port>`，
在 `#serve` 里随手登记（那里同时拿得到 `port` 与 `port.sender.tab.id`），`port.onDisconnect` 时清掉
该 port 的所有键。中继件不需要知道 tab —— 它只管按 `scriptId` 选自己那张表，所以向下打来的
`request` 与 `response` 在它眼里是同一种东西：按 `scriptId` 投递。

**自荐 ping**：索引靠「脚本发过一条请求」建立，纯订阅的脚本永远不会发，SW 也就永远推不到它。
所以 `MainWorldMessenger.setScriptId`（`DL` 构造时）先 `sendMessage(PING_TYPE)` 喊一声，SW 侧
`#serve` 见到 `PING_TYPE` 直接回 `{ ok: true }`，不查 handler 表。一次往返办两件事：
建线 + 让 SW 记住 `tabId:scriptId → port`。

**让出的确定性**：

- 目标脚本没连上（页面没加载、从没请求过、port 已断）→ `sendToScript` 立即以 `TRANSPORT` 拒绝，
  不排队、不重试；脚本侧没注册 handler → 回 `NO_HANDLER`，与反方向同一套错误码。
- ping 发生在 `DL` 构造时，那会儿页面可能刚 `document_start`：中继件注册在脚本库之前，正常顺序下
  监听已就位，但两个世界都在 `document_start` 注入，相对顺序不由我们控制 —— 这一声若落在中继件
  挂上之前，那条私线就是死的（后续请求全投进没有对端的 port，且没有超时兜底）。
- `scriptId` 仍是页面可伪造的：页面脚本能冒充别的 id 抢登记，甚至顶掉别人那条线，
  与之前的信任模型一致（见「安全边界」）。
