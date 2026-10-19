# 0044. 服务代理：按方法名把 SW 的能力透到 MAIN 世界

日期: 2026-10-19
状态: 已接受
代码落点: packages/dl-core/src/proxy-service/（index / types）、packages/dl-core/src/service/（内核服务 `sw`）、packages/dl-core/src/dl.ts 的 `getService`

## 背景

消息通道（`docs/adr/0043-script-messaging-channel.md`）解决的是「怎么发一条请求」，没有解决
「每加一个能力要改几处」。`DL.getTab/saveTab` 就是样板：协议表加一行 type、SW 加一个 handler、
`DL` 加一个方法。能力多起来之后，协议表会退化成一份手写的命令清单，而脚本真正想要的是
「调 SW 里的某个函数」。

`@webext-core/proxy-service` 的形状值得抄：一个服务只占**一个**消息 type，方法名作为载荷里的路径，
MAIN 侧拿到深代理，`service.a.b(x)` 直接变成一次请求。

仓里其实已经在用它，但只覆盖了扩展进程之间：`packages/shared/src/service/` 的 SW 保活探针与
offscreen 服务都经由 `chrome.runtime` 发消息。脚本跑在页面 MAIN 世界、没有 `chrome.*`，那套代理
到不了这里 —— 所以抄它的形状铺在自己的消息通道上，而不是再加一层信封去桥接它。

## 决策

- **一个服务一个 type**：`proxy-service.<key>`，载荷是 `{ path: string[], args: unknown[] }`。
  `path` 是方法路径，`args` 原样透传；SW 侧按路径逐层取值，`this` 绑到方法所在的父对象。
- **MAIN 侧深代理**：`DL.getService<T>(key)` 返回 Proxy，读属性长出新的一层、调用发一次请求，
  `path` 在读取过程中累积。
- **messenger 自建、单实例**：`createProxyService(key)` 只收 key（与参照实现同形），通道由
  `proxy-service` 内部按模块级单例懒建，`scriptId` 由 `DL` 构造时 `setProxyScriptId` 注入。
  每个脚本的注入体各有一份模块作用域，所以「模块级单例」正好等于「每脚本 × 每文档一条」，
  不会跨脚本串号，也不会按 `getService` 次数累积 `window` 监听。
- **key 就是一个 `string`**：曾照参照实现加过 `ProxyServiceKey<T> = string & ProxyServiceConstraint<T>`，
  想给 key 标上服务类型 —— 但 `ProxyServiceConstraint<_>` 是空接口，不约束任何东西，参数位置
  还保留着 `| string`，实际零作用；2026-10-19 连同与 `DeepAsync<T>` 等价的 `ProxyService<T>` 一并删除，
  类型面只剩 `DeepAsync<T>` 一处。
- **SW 侧反射调用**：`registerService(key, factory)` 注册一个 handler，取到方法后 `apply(args)`；
  返回值照旧走 messenger —— `Promise` 会被等，抛错会被序列化回对端。
- **服务一律由工厂建，身份永远在场**：第二个参数固定是 `(context: ServiceContext) => T`，
  handler 每次调用现建一个实例。`ServiceContext` 的 `scriptId` / `tabId` / `sender` 都是必填 ——
  拿不到就抛 `PROTOCOL`，不把半个身份交给服务自己兜。`scriptId` 优先取 `sender.userScript.scriptId`
  （浏览器盖章），缺省才回退消息体里那个页面可写的值；`tabId` 只有 `sender.tab.id` 一个来源。
  请求上下文因此不必污染对外方法签名，也不必挤进模块级变量（并发下会串号）。
- **只支持方法调用**：数据字段读到的是代理而不是值（调用它回 `PROTOCOL`）。要传数据就放进
  入参或返回值，不要指望读属性。
- **不放宽序列化约束**：入参与返回值仍是 JSON 面，`Date` / `Map` / 类实例 / `undefined`
  在发送前就报错。服务的入参契约因此只能是纯数据。

## 第一个用户：内核服务 `sw`

`DL.getTab/saveTab` 随即从「协议表里的一对 type」改成服务：`src/service/sw-service.ts` 里一个
`SwService` 类（以工厂形式注册 `(context) => new SwService(context)`，每次调用按上下文现建实例），
`DL.getTab()` 就是 `getService<SwService>('sw').getTab()`。方法照 `MathService` 示例的口径
声明成 `async`，于是 `DeepAsync<SwService>` 与原类同形，类型上不再有映射后的形状差。`saveTab()`
不传参即清空（顶层 `undefined` 进不了信封）。一并撤销的是
`dl-protocol.ts`（专用协议表）与 `tab-store.ts`（专用 handler）—— `tab.get` / `tab.save` 两个
type 消失，能力面只剩「服务」一种形状，加能力不必再改协议表。

## 类型面

```ts
export interface MathService {
  add(a: number, b: number): number // 同步实现也行，MAIN 侧一律拿到 Promise
  deep: { echo(value: unknown): unknown }
}

// SW
registerService<MathService>('math', () => mathService)

// MAIN
const math = DL.getService<MathService>('math')
const sum = await math.add(1, 2) // Promise<number>
```

`DeepAsync<T>` 把方法映射成 `Promise<Awaited<R>>`，其余字段原样保留。类型面只保证方法部分：
`name: string` 在类型上仍是 `string`，运行时却是代理 —— 深代理的固有代价，文档写明而不是
用 `never` 假装拦住（`never` 赋值给 `string` 一样能编译，拦不住）。

## 错误

| 场景 | 对端看到 |
| --- | --- |
| 服务根本没注册 | `MessagingError`，`code: 'NO_HANDLER'`（通道既有行为） |
| 方法不存在 / 载荷形状不对 | `MessagingError`，`code: 'PROTOCOL'` |
| 消息里凑不出 `scriptId` / `tabId` | `MessagingError`，`code: 'PROTOCOL'`（服务层不接无身份调用） |
| 方法抛错 | 同 `name` + `message` + `stack` + `code` 的 `Error` |
| 入参或返回值不可序列化 | `MessagingError`，`code: 'SERIALIZATION'`，附字段路径 |

调用方只需要 `try / catch`：链路层每种失败都有明确回包，不会静默等到超时。

## 其它约束与代价

- **没有推送**：服务不能主动回调 MAIN。要推送得另起一条通道，不要指望在这个代理上补半边。
- **没有「实例」形态**：无状态服务也要包一层 `() => service`。注册面因此只有一种形状，代价是
  写起来多几个字符。
- **一个 key 只能注册一次**：messenger 的 handler 表按 type 唯一，重复 `registerService` 抛 `PROTOCOL`。
- **注册时机**：`registerService` 首次调用时构造 SW messenger 并挂上根监听（模块级单例，之后复用），
  但这条注册链仍要在 `defineBackground` 的同步段就位（当前入口是 `DLRuntime` 的构造函数里的
  `mountSwService`）。晚于唤醒的注册收不到那次投递。
- **页面可伪造**：服务方法就是真实能力，MAIN 世界的任何页面脚本都能调。`docs/adr/0043-script-messaging-channel.md`
  记的鉴权欠账在这里第一次变得关键 —— 补页面密钥之前，只注册无副作用或幂等的服务。
- **`then` 在代理里放过**：否则 `await 代理` 会把它当 thenable 发一次调用（参数还是 resolve / reject，
  直接撞序列化报错）。放过之后 `await service` 只是原样拿到代理。

## 备选与否决

- **每个能力一个 type（`tab.get` 的写法）**：类型最紧，但每加一个能力要改三处；服务一多，
  协议表就变手写命令清单。
- **直接用 `@webext-core/proxy-service`**：它绑在 `chrome.runtime` 上（`shared/src/service/`
  那两处就是这么用的），而 MAIN 世界没有这个 API；要复用只能把整条链路换成它的 messaging，
  等于推倒消息通道那条 ADR。抄设计比抄依赖便宜。
- **在 MAIN 暴露 messenger，让脚本自己封服务**：每个脚本会各写一套 path 约定，正是本条要收掉的分叉。
- **把身份做成方法参数**（`getTab(scriptId)`）：`tabId` 页面根本拿不到（MAIN 世界没有 `chrome.tabs`），
  只传 `scriptId` 等于把钥匙交出去一半；而 `scriptId` 本身已经跟着消息到了 SW，做成参数只多一条
  页面可伪造的入口。身份只能从消息的 `sender` 里来，所以总得有个通道把它从框架送到服务手上 ——
  方法参数（页面给不出）、模块级变量（并发串号）、构造函数（即 `ServiceContext`），只有第三条成立。
