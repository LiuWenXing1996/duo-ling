# @duoling/dl-core

duo-ling 的**脚本内核**：注入体的实现体与对脚本暴露的能力面都在这里。源码直出（`exports` 指 `src/index.ts`），由消费方编译；唯一自建的一步是内核装配件的 esbuild 打包（产物 `dist/mount-dl-iife.js` 是一段 IIFE 文本，由 `build-user-script.ts` 以 `?raw` 读进来，见下「现状」）。**根出口只有一个 `DLRuntime` 类**，它只在扩展进程可用：构造时挂内核服务与页面侧中继件，另暴露 `installCustomUserScript` / `installedCustomScriptIds` / `uninstallCustomUserScript` 三个脚本注册面方法，以及 `isUserScriptsAvailable` / `onUserScriptsAvailableChange` 两个「允许运行用户脚本」开关的探测与订阅方法。messenger、proxy-service、`SwService` 与全部消息类型都是内核内部实现，包外取不到 —— 它们由包内模块经相对路径互相引用，加能力时也不必扩出口。

## 注入面契约

内核注入到页面主世界，**恒注入**，不读 `@grant` 清单：

| 能力面                                                    | 形态   | 说明                                                                          |
| ------------------------------------------------------ | ---- | --------------------------------------------------------------------------- |
| `DL.*`                                                 | 恒注入  | 脚本 API 的原生面，覆盖面是 **GM API 的超集** —— 现有 `GM_*` / `GM.*` 能做的事都有对应能力，另外收内核新增的能力 |
| `unsafeWindow`                                         | 恒注入  | 页面真实 window（脚本本来就在主世界，拿到的就是它本身）                                             |
| `window.onurlchange` / `window.close` / `window.focus` | 内核提供 | 不依赖 grant 声明                                                                |

## 与 GM 面的关系

`GM_*` / `GM.*` 是**对齐 Tampermonkey 的兼容面**，继续按 `@grant` 裁剪（未授权即不存在 / `undefined`，口径的唯一来源是 `@duoling/shared` 的 `gm-grants.ts`）。脚本要能同时跑在 Tampermonkey 与本扩展上，这条不能软化。

`DL` 面走另一条路：恒注入、不裁剪，是内核自己的原生面 —— 因此它能覆盖 GM 面的全部能力还留出扩展余量，而不必被 TM 的 grant 语义绑住。

命名上只有 `DL.*` 一种形状，**不提供 `DL_` 前缀的全局形态**：全局位留给 `GM_*` 那套兼容面，两套并存时再铺一层同义的全局名，只会让 `typeof` 判断与迁移对照多出一份分叉。

## 边界

- **除浏览器与扩展平台的原生 API 外，不复用现有任何能力**。内核是独立实现：不 import、不复制、不移植 `gm-main` 的注入源码、`bridge-main` 的桥客户端、`dl-bridge` 的分发与命令实现。判断标准很直白 —— 这套内核能否只靠平台 API 重新长出来；凡是「因为现成有所以拿过来」的引用，都算越界。
- **与 SW 的通道也在本包内自建**：页面主世界到 Service Worker 的跨世界链路（页面内中继 + 消息 / 端口）同样归内核自己维护，不沿用现有注入件的链路实现。
- **只依赖 `@duoling/shared` 的类型与常量**；实现不反向依赖任何宿主包，也不 import 页面包。
- **`types: ["chrome", "vite/client"]`**：vite/client 是 `?raw` 的模块声明（内核装配件原文要读成字符串）；chrome 只服务宿主侧注册模块。注入体那条链路仍不许引用 `chrome.*`（页面主世界没有扩展 API）—— `build.mts` 的产物守卫拦这条，类型面放行不等于约束放行。node 仍不吃。
- 与 `shared` 的分工是「行为 vs 形状」：信封、常量、类型、纯数据处理进 `shared`；带运行期依赖、要拼进注入体的逻辑进本包。内核取 `shared` 只取形状，不取行为。

## 现状

八块已落地，全部接线：

- **宿主侧运行时**：`src/runtime.ts` 的 `DLRuntime` —— 根出口唯一的东西。构造时同步挂内核服务（`mountSwService`），随后装页面侧中继件并把那句 promise 留着（`whenReady()` 供启动链排序，`installMessagingRelay()` 供可用性翻转时重装，失败只记日志不抛）；脚本注册面的三个方法原样转出，包外要注册脚本必须经它。**类不是单例**：实例由宿主创建，再经 `createServiceWorkerHost({ dlRuntime })` 注入到 SW 包，包内按需取用。
- **引擎可用性**：`src/availability.ts` —— `isUserScriptsAvailable()` 实探 `chrome.userScripts.getScripts()`（开关关着时命名空间不存在、调用必抛，这是唯一与版本无关的判据）；`UserScriptsAvailabilityWatch` 每 1s 轮询一次、只在翻转时回调（Chrome 对该开关没有变化事件），首个订阅者起表、退到空停表、首个读数只建基线。两个能力都经 `DLRuntime` 暴露，SW 侧不再自己养定时器。
- **注入体拼装**：`src/build-user-script.ts` 的 `buildUserScript` —— 按「`var DL` 挂载点 → 内核 IIFE → `@require` + 脚本正文」拼成一条 IIFE，三段同处一个函数作用域。
- **内核装配件**：`src/dl.ts` 是 `DL` 的实现类，`src/mount-dl.ts` 负责实例化并写到外层那个 `DL` 上。`build.mts` 把它 bundle 成 `dist/mount-dl-iife.js`（不入库，随 `pnpm -r build` 重建；产物先过五道形状守卫再落盘）。
- **宿主侧注册**：`src/install-custom-user-script.ts` 的 `installCustomUserScript` —— 接一段代码（裸代码，或 GM 包装层包好的整段源码），经 `buildUserScript` 拼好后用 `chrome.userScripts.register` 装成 MAIN 世界脚本，`uninstallCustomUserScript` 反手注销。**注册动作抽成 `registerUserScript`**（可用性检查 + 同 id 先注销再注册），中继件那条世界注册同一个函数，两处不再各写一遍。只在本进程有效（注册不跨浏览器重启存活），缺省全站匹配、`document_start`、只注入顶层 frame。SW 的 `registerScript` 也走它：校验与配置映射留在 SW，注册动作收敛在这里。
- **内核服务**：`src/service/sw-service.ts` 的 `mountSwService` —— tab 存取包成服务 `sw`（`getTab` / `saveTab`），经 `registerService` 注册，`DL.getTab/saveTab` 就是 `DL` 私有取用的 `#service('sw')` 的两个方法。服务以工厂形式注册，每次调用按 `ServiceContext` 现建实例，`ServiceContext` 的 `scriptId` / `tabId` 都必填（缺了直接按 `PROTOCOL` 拒掉）；key 是 `${scriptId}:${tabId}`，tabId 取 `sender.tab.id`，浏览器盖章、页面改不了，只在服务内部可见。状态是内存 Map，SW 回收即蒸发，一期不做持久化，`tabs.onRemoved` 清关 tab 的记录。它必须在 `defineBackground` 的回调里随 `DLRuntime` **同步**建出来 —— MV3 的事件投递按同步注册表决定，SW 休眠后中继件的 `sendMessage` 就是唤醒动作，handler 等异步注册链跑完才挂的话那次投递已丢失。

- **脚本消息通道**（设计见 `docs/adr/0043-script-messaging-channel.md`）：`src/messaging/` 一套 messenger 实现 —— `MainWorldMessenger`（MAIN 世界，首条请求带一条新 port 出去、之后复用同一条，线是它自己的 `#link` 实例字段，不对外暴露）、`ServiceWorkerMessenger`（SW 侧，`runtime.onUserScriptConnect` 收中继件建来的 Port + 按 type 的 handler 表，惰性静态单例 `ServiceWorkerMessenger.instance` —— 不写成静态初始化器，因为构造函数会挂 `chrome` 监听，那会把 `chrome.*` 带进内核产物）、`MessagingRelay`（USER_SCRIPT 中继件，`static readonly instance` + `mount()`；跑在独立 world、只有一条世界注册，故不再用 window 标记做幂等，`MessagePort` ⇄ 常驻 chrome Port）。跨 world 的那一段：**每脚本一条** `MessageChannel`，主世界把第一条请求连同这条新 channel 的另一端一起发出去（请求本体走 `window.postMessage`，`port2` 随 transfer list 过去），中继件收下即拿到回程并按帧里的 `scriptId` 存进自己的表（线归主世界建，中继件只接收转移过来的那端），此后 `window` 上不再出现任何帧，请求与回包全在 port 上，`frameKind()` 校验一次 `channel` + `kind` 即可。中继件在页面加载时 `runtime.connect` 建一条 chrome Port，请求与回包都走它；连上之前发出的请求先排队，断线（SW 回收）后按 1s 起翻倍、封顶 15s 重连，并把在途请求按 `TRANSPORT` 结算掉。通道只有四个具体签名、没有协议映射表的泛型：`MainWorldMessenger` 是 `sendMessage(type, data?)` / `onRequest(type, handler)`（后者不经 `DL` 暴露，脚本侧接请求只有 `registerBackgroundCommand` 一个入口），SW 侧 `onMessage(type, handler)` / `sendToScript(tabId, scriptId, type, data?)` —— 两个方向同一对 `request` / `response` 帧（信封扁平，`scriptId` 顶格：上行是发起者、下行是目标），方向由谁读它决定。SW 侧的 `tabId:scriptId → Port` 索引靠脚本发来的第一条请求建立，所以 `DL` 构造时会先发一条 `dl.ping` 自荐（SW 内置应答，不查 handler 表）—— 只订阅、从不发请求的脚本也因此推得到。类型面在上一层（服务的 `DeepAsync<T>`），通道这层再写一遍只会推导成 `unknown`。错误序列化成 `{ name, message, stack }` 在对端重建，失败回包统一走 `wireError`。数据不做预检、交给平台：过不了结构化克隆的值在 `port.postMessage` 那一步同步抛 `DataCloneError`；`Date` / `Map` / `Set` / `NaN` / 嵌套 `undefined` 这类“克隆能过、JSON 过不去”的值，会在中继件 → SW 那一段被 Chrome 的 JSON 序列化静默变形（曾经有一道 `assertSerializable` 前置拦截，2026-10-20 按要求删除，理由见 ADR 0043 的变更段）。中继件由 `installMessagingRelay` 注册成独立 world（`dl-messaging-relay`）并 `configureWorld({ messaging: true })`，启动链里排在脚本库注册之前。`DL.getTab/saveTab` 也走这条通道（见上一条），`DL` 对脚本只暴露具体能力、不暴露 messenger：messenger 是内部实现，由 `MainWorldMessenger.instance` 提供（`static` 字段挂类上、`private constructor` 封死；单例持有自己那条 port，回包按 `id` 配对）。

- **服务代理**（设计见 `docs/adr/0044-proxy-service.md`）：`src/proxy-service/` —— SW 侧 `registerService(key, factory)` 把一个工厂注册成服务，一个服务只占一个消息 type（`proxy-service.<key>`）；MAIN 侧的 `#service<T>(key)`（`DL` 私有，脚本侧拿到的面是 `getTab` / `saveTab` / `registerBackgroundCommand`）拿到深代理，`service.a.b(x)` 就是一次请求：路径在读取时累积，SW 侧按路径反射取值并把 `this` 绑到父对象。注册参数固定是工厂 `(context: ServiceContext) => T`，handler 每次调用现建一个实例；`ServiceContext` 的 `scriptId` / `tabId` / `sender` 都必填（`scriptId` 以帧内声明的为准：Port 由共享中继件建立，`sender.userScript.scriptId` 只能是中继件自己的 id，不是调用方；`tabId` 只有 `sender.tab.id` 一个来源），凑不出来就回 `PROTOCOL` 而不是给半个身份；内核的 `sw` 服务就是这么写的。入参与返回值仍是 JSON 面；方法抛错按通道既有语义序列化回对端，服务没注册回 `NO_HANDLER`，方法不存在回 `PROTOCOL`。只能调方法，读数据字段拿到的是代理而不是值。`createProxyService(key)` 只收 key：通道由 `src/messaging/main-messenger.ts` 的 `MainWorldMessenger.instance` 提供（`static` 字段挂类上、构造器私有，每个注入体一份模块作用域，正好等于「每脚本 × 每文档一条」），`scriptId` 由 `DL` 构造时经 `MainWorldMessenger.setScriptId` 注入、发消息时现读，不在构造时定死。key 就是普通字符串 —— 曾经那层 `ProxyServiceKey<T>` 是空接口交叉类型，不约束任何东西，已随 `ProxyService<T>` 一并删除。

- **后台命令**（设计见 `docs/adr/0045-background-command.md`）：`src/service/command-service.ts` —— 脚本用 `DL.registerBackgroundCommand(name, handler, { title? })` 向 SW 登记一条命名命令，表键是 `${tabId}:${scriptId}`（与 messenger 的 `#ports` 同一约定）；宿主用 `DLRuntime.listBackgroundCommands(tabId, scriptId)` 枚举、`invokeBackgroundCommand(tabId, scriptId, name, arg)` 调用，投递复用 `sendToScript`，命令类型 `command.<name>`（前缀常量与拼接函数在 `messaging/protocol.ts`，留在 command-service 会把 SW 侧模块带进注入产物）。脚本侧不提供调用面：MAIN 拿不到自己的 `tabId`，三元组只有宿主给得全；`exported` / `PERMISSION` 因此也不存在。表是纯内存的唯一真相源，`invoke` 查不到即 `NO_HANDLER`，不降级不落盘。条目寿命跟着消息线：`ServiceWorkerMessenger.onPortClosed` 在 Port 断开（导航 / 关 tab / 崩溃）时回调，整键删掉，所以不需要 `tabs.onRemoved`。SW 空闲回收即失表，是这一轮接受的代价。

`installCustomUserScript` 与 SW 的注册引擎有一处必须对齐：全量同步会把不在保留名单里的注册当残留清掉。本包用 `installedCustomScriptIds()` 把本进程装过的 id 报给 SW，由它并进那份名单 —— 少了这步，装上的脚本会在下一次同步里静默消失。走脚本库的那条注册则要传 `protectFromSync: false`：它的 id 归引擎管，删除 / 关停靠同一次清扫兜底。
内核原文由本包自己取：`build-user-script.ts` 里 `import DL_KERNEL_IIFE from '../dist/mount-dl-iife.js?raw'`，拼装接口对外只有 `{ uuid, name, source, requires }`，调用方不需要知道产物的存在，也无从传错。代价写在明处：`?raw` 是 Vite 方言，这条 import 让本包不再是「任何构建器都能直接编译的纯 TS」，消费方的构建必须认这个后缀（当前唯一消费方 `@duoling/service-worker` 走 Vite，成立）。

内核必须与外层 `var DL` **同处一个函数作用域**，所以 dist 里那份的消费方式是**取文本内联**，不是另起一条注册。
