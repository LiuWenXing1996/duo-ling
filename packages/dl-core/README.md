# @duoling/dl-core

duo-ling 的**脚本内核**：注入体的实现体与对脚本暴露的能力面都在这里。源码直出（`exports` 指 `src/index.ts`），由消费方编译；自建的一步只有 esbuild 打包——`dist/mount-dl-iife.js`（内核，`build-user-script.ts` 以 `?raw` 读进来）。**根出口只有一个 `DLRuntime` 类**，它只在扩展进程可用：构造时同步挂内核服务（`sw` 存取与后台命令表），另暴露脚本注册面三个方法（`installCustomUserScript` / `installedCustomScriptIds` / `uninstallCustomUserScript`）、反向请求与后台命令调用面（`sendToScript` / `listBackgroundCommands` / `invokeBackgroundCommand`），以及「允许运行用户脚本」开关的探测与订阅（`isUserScriptsAvailable` / `onUserScriptsAvailableChange`）。messenger、proxy-service、`SwService` 与全部消息类型都是内核内部实现，包外取不到 —— 它们由包内模块经相对路径互相引用，加能力时也不必扩出口。

## 注入面契约

内核注入**默认 USER_SCRIPT 世界**（非 MAIN），**恒注入**，不读 `@grant` 清单。该世界有 `chrome.runtime`（直连传输的前提），其余扩展 API 一概没有：

| 能力面                                                    | 形态   | 说明                                                                          |
| ------------------------------------------------------ | ---- | --------------------------------------------------------------------------- |
| `DL.*`                                                 | 恒注入  | 脚本 API 的原生面，覆盖面是 **GM API 的超集** —— 现有 `GM_*` / `GM.*` 能做的事都有对应能力，另外收内核新增的能力。实现体是单层 `DLClient`：能力要不要给普通脚本，手写一行转发与否即是全部开关 |
| `unsafeWindow`                                         | 恒注入  | 页面真实 window                                                              |
| `window.onurlchange` / `window.close` / `window.focus` | 内核提供 | 不依赖 grant 声明                                                                |

## 与 GM 面的关系

`GM_*` / `GM.*` 是**对齐 Tampermonkey 的兼容面**，继续按 `@grant` 裁剪（未授权即不存在 / `undefined`，口径的唯一来源是 `@duoling/shared` 的 `gm-grants.ts`）。脚本要能同时跑在 Tampermonkey 与本扩展上，这条不能软化。

`DL` 面走另一条路：恒注入、不裁剪，是内核自己的原生面 —— 因此它能覆盖 GM 面的全部能力还留出扩展余量，而不必被 TM 的 grant 语义绑住。

命名上只有 `DL.*` 一种形状，**不提供 `DL_` 前缀的全局形态**：全局位留给 `GM_*` 那套兼容面，两套并存时再铺一层同义的全局名，只会让 `typeof` 判断与迁移对照多出一份分叉。

## 边界

- **除浏览器与扩展平台的原生 API 外，不复用现有任何能力**。内核是独立实现：不 import、不复制、不移植 `gm-main` 的注入源码、`bridge-main` 的桥客户端、`dl-bridge` 的分发与命令实现。判断标准很直白 —— 这套内核能否只靠平台 API 重新长出来；凡是「因为现成有所以拿过来」的引用，都算越界。
- **与 SW 的通道也在本包内自建**：脚本世界直连 Service Worker 的那条 `chrome.runtime.connect` Port 归内核自己维护，不沿用现有注入件的链路实现。
- **只依赖 `@duoling/shared` 的类型与常量**（外加平台适配库 `idb`：只有 SW 侧模块 `runtime` / `service/` 引用它，注入产物一行都不含）；实现不反向依赖任何宿主包，也不 import 页面包。
- **`types: ["chrome", "vite/client"]`**：vite/client 是 `?raw` 的模块声明（内核装配件原文要读成字符串）；chrome 只服务宿主侧注册模块。注入体那条链路只许引用 `chrome.runtime`（直连传输）—— `build.mts` 的产物守卫拦其余的 `chrome.*`，类型面放行不等于约束放行。node 仍不吃。
- 与 `shared` 的分工是「行为 vs 形状」：信封、常量、类型、纯数据处理进 `shared`；带运行期依赖、要拼进注入体的逻辑进本包。内核取 `shared` 只取形状，不取行为。

## 现状

十一块已落地，全部接线：

- **宿主侧运行时**：`src/runtime.ts` 的 `DLRuntime` —— 根出口唯一的东西。构造函数里**同步**挂 `mountSwService` 与 `mountCommandService` —— MV3 的事件投递按同步注册表决定，SW 休眠后脚本侧的 `sendMessage` 就是唤醒动作，handler 等异步注册链跑完才挂的话那次投递已丢失。**类不是单例**：实例由宿主创建，再经 `createServiceWorkerHost({ dlRuntime })` 注入到 SW 包，包内按需取用。
- **引擎可用性**：`src/availability.ts` —— `isUserScriptsAvailable()` 实探 `chrome.userScripts.getScripts()`（开关关着时命名空间不存在、调用必抛，这是唯一与版本无关的判据）；`UserScriptsAvailabilityWatch` 每 1s 轮询一次、只在翻转时回调（Chrome 对该开关没有变化事件），首个订阅者起表、退到空停表、首个读数只建基线。两个能力都经 `DLRuntime` 暴露，SW 侧不再自己养定时器。
- **注入体拼装**：`src/build-user-script.ts` 的 `buildUserScript` —— 按「`var DL` 挂载点 → 内核 IIFE → `@require` + 脚本正文」拼成一条 IIFE，三段同处一个函数作用域。
- **内核装配件（一层，一份产物）**：`src/dl.ts` 的 `DLClient` —— `getTab` / `saveTab` / 键值七件 / `registerBackgroundCommand` / `config` / `log`，全部经内部服务代理转发。`src/mount-dl.ts` 一句 `DL = new DLClient({ registerId })`：没有分层、没有 `tier`。`build.mts` 只 bundle 这一份 `dist/mount-dl-iife.js`（不入库，随 `pnpm -r build` 重建；产物先过形状守卫再落盘：无 import/export、无本地 `DL` 声明、只许 `chrome.runtime`、禁 `openDB`，且必须真给 `DL` 赋值、必须发起 `connect`）。
- **宿主侧注册**：`src/install-custom-user-script.ts` 的 `installCustomUserScript` —— 接一段代码（裸代码，或 GM 包装层包好的整段源码），经 `buildUserScript` 拼好后用 `chrome.userScripts.register` 装成**默认 USER_SCRIPT 世界**脚本（页面 JS 摸不到这里，内核拿得到 `chrome.runtime` 直连 SW），`uninstallCustomUserScript` 反手注销。注册动作抽成 `registerUserScript`（可用性检查 + 先注销再注册 + `configureWorld({ messaging: true })`，缺省世界一次配置全局生效），中继件那条世界注册同一个函数，两处不再各写一遍。只在本进程有效（注册不跨浏览器重启存活），缺省全站匹配、`document_start`、只注入顶层 frame。SW 的 `registerScript` 也走它：校验与配置映射留在 SW，注册动作收敛在这里。
- **内核服务**：`src/service/sw-service.ts` 的 `mountSwService` —— tab 存取与脚本键值都包成服务 `sw`（`getTab` / `saveTab` / `getValue` / `setValue`），经 `registerService` 注册，`DL.getTab/saveTab` / `getValue/setValue` 都是 `DL` 私有取用的 `#swService()` 的方法。服务以工厂形式注册，每次调用按 `ServiceContext` 现建实例，`ServiceContext` 的 `scriptId` / `tabId` 都必填（缺了直接按 `PROTOCOL` 拒掉）；key 是 `${scriptId}:${tabId}`，tabId 取 `sender.tab.id`，浏览器盖章、页面改不了，只在服务内部可见。tab 状态是内存 Map，SW 回收即蒸发，`tabs.onRemoved` 清关 tab 的记录；`saveTab()` 与 `saveTab(null)` 都清本 tab 的记录 —— 参数过通道是 JSON，`undefined` 到 SW 已成 `null`，两者只能同义。脚本键值另走 IndexedDB，不受回收影响（见下条「脚本存储」）。

- **脚本消息通道**（设计见 `docs/adr/0043-script-messaging-channel.md`，直连形态）：`src/messaging/` 两个 messenger —— `MainWorldMessenger`（脚本世界侧，`static readonly instance` 单例）与 `ServiceWorkerMessenger`（SW 侧，惰性静态单例 `static get instance()` + 私有构造 —— 写成静态初始化器会让 esbuild 不敢摇掉模块，`chrome.*` 就落进内核产物）。**脚本世界直连 SW，没有中继件**：`MainWorldMessenger` 首次发送时 `chrome.runtime.connect({ name: MESSAGING_PORT })` 建一条 Port（`#link` 实例字段，内联在 `#post`），此后复用；`onDisconnect` 把在途请求按 `TRANSPORT` 结算并置空 `#link`，下一次发送自愈重建。SW 侧 `runtime.onUserScriptConnect` 收 Port，**连接即声明身份**：`port.sender.userScript.scriptId` + `sender.tab.id` 直接登记进 `#ports`（`'${tabId}:${scriptId}'`），不握手、无 ping、无控制帧 —— 订阅型脚本（从不发请求）也能被 `sendToScript` / `emit` 寻址到。帧只有三种 `kind`：`request` / `response` / `event`，同一对 `request` / `response` 帧方向由谁读它决定（上行是脚本发请求，下行是 SW 的 `sendToScript`，信封扁平、`scriptId` 顶格）。通道只有六个具体签名：脚本世界 `sendMessage(type, data?)` / `onRequest(type, handler)` / `emit(type, data?)` / `onEvent(type, handler)`，SW 侧 `onMessage(type, handler)` / `sendToScript(...)` / `onEvent(listener)` / `emit(...)` / `tabIdsOf(scriptId)`。`scriptId` 在脚本世界用 `MainWorldMessenger.setScriptId` 静态占位（同值不动作、不同值抛 `PROTOCOL`），发消息时现读。错误序列化成 `{ name, message, stack, code }` 在对端重建，失败回包统一走 `wireError`。数据不做预检、交给平台：过不了结构化克隆的值在 `port.postMessage` 那一步同步抛 `DataCloneError`。`DL.getTab/saveTab` 也走这条通道（见上一条），`DL` 对脚本只暴露具体能力、不暴露 messenger。

- **服务代理**（设计见 `docs/adr/0044-proxy-service.md`）：`src/proxy-service/` —— SW 侧 `registerService(key, factory)` 把一个工厂注册成服务，一个服务只占一个消息 type（`proxy-service.<key>`）；脚本侧的 `#service<T>(key)`（`DL` 私有）拿到深代理，`service.a.b(x)` 就是一次请求：路径在读取时累积，SW 侧按路径反射取值并把 `this` 绑到父对象。注册参数固定是工厂 `(context: ServiceContext) => T`，handler 每次调用现建一个实例；`ServiceContext` 的 `scriptId` / `tabId` / `sender` 都必填（`tabId` 只有 `sender.tab.id` 一个来源），凑不出来就回 `PROTOCOL` 而不是给半个身份；内核的 `sw` 服务就是这么写的。入参与返回值仍是 JSON 面；方法抛错按通道既有语义序列化回对端，服务没注册回 `NO_HANDLER`，方法不存在回 `PROTOCOL`。只能调方法，读数据字段拿到的是代理而不是值。key 就是普通字符串 —— 曾经那层 `ProxyServiceKey<T>` 是空接口交叉类型，不约束任何东西，已随 `ProxyService<T>` 一并删除。

- **后台命令**（设计见 `docs/adr/0045-background-command.md`）：`src/service/command-service.ts` —— 脚本用 `DL.registerBackgroundCommand(name, handler, { title? })` 向 SW 登记一条命名命令，表键是 `${tabId}:${scriptId}`（与 messenger 的 `#ports` 同一约定）；宿主用 `DLRuntime.listBackgroundCommands(tabId, scriptId)` 枚举、`invokeBackgroundCommand(tabId, scriptId, name, arg)` 调用，投递复用 `sendToScript`，命令类型 `command.<name>`（前缀常量与拼接函数在 `messaging/protocol.ts`，留在 command-service 会把 SW 侧模块带进注入产物）。脚本侧不提供调用面：脚本拿不到自己的 `tabId`，三元组只有宿主给得全；`exported` / `PERMISSION` 因此也不存在。表是纯内存的唯一真相源，`invoke` 查不到即 `NO_HANDLER`，不降级不落盘。条目寿命跟着消息线：`ServiceWorkerMessenger.onPortClosed` 在 Port 断开（导航 / 关 tab / 崩溃）时回调，整键删掉，所以不需要 `tabs.onRemoved`。SW 空闲回收即失表，是这一轮接受的代价。

- **脚本存储**：并进服务 `sw`（`src/service/sw-service.ts`）—— 七个方法 `getValue` / `setValue` / `deleteValue` / `getValues` / `setValues` / `deleteValues` / `listValues`，落到独立 IDB 库（库名由 `DLRuntime` 的 `storeDatabase` 给，缺省 `duoling-dl`，经 `mountSwService(name)` 传入）：一个 `script_values` store，键是 `[scriptId, key]`、值原样落盘，`scriptId` 取 `ServiceContext`，脚本侧无从指定命名空间。连接是模块级惰性单例（服务实例每次调用现建，连接挂实例上就变成每请求开一次库），首次读写才开库；库名只认第一次挂载，二次传不同名直接抛错。`setValue(k, undefined)` 即删键 —— 通道是 JSON，`undefined` 传到 SW 已变成 `null`，两者在此不可分，所以 `null` 同样当删键、不能作为值存，`setValues` 里的 `null` 同规则。`getValues` 的三种形态照 TM：无参给全量、键数组只含**实际存在**的键、默认值对象按其键补缺 —— 前两种由 SW 面承载，补缺在脚本侧做（`DLClient.getValues` 的落点）。批量写整批一个事务（`await tx.done`），这是它相对循环调单键的全部价值。`listValues` 只回键名，靠数组键的范围扫（`IDBKeyRange.bound([scriptId], [scriptId, []])`）—— 当初选数组键而非字符串拼接，就是为这一步：IDB 键类型序里 array 最高，`[scriptId, []]` 恰好在「该脚本全部键」之后，不用 `\uffff` 技巧。与 `GM_*` 的存储（`duoling-usdata` 库）是两条库、不互通 —— 这是「不复用现有能力」的直接代价。`idb` 是本包唯一的运行时依赖，只在 SW 侧被引用；`build.mts` 有一条 `openDB` 产物守卫，防止它被误打进注入产物。

- **下行事件通路**（SW → 脚本，单向）：`ServiceWorkerMessenger.emit(tabId, scriptId, type, data?)` 是 `sendToScript` 的对照面 —— 同一个 `#ports.get('${tabId}:${scriptId}')` 取端口动作，一个发 `kind: 'request'`、生成 id、进 `#pending`、等回包，一个发 `kind: 'event'`、不进 `#pending`、端口不在即静默返回（断开的端口由 `onDisconnect` 摘掉，这条通知没有收件人）。广播范围交给调用方：`tabIdsOf(scriptId)` 从 `#ports` 反查该脚本的在线 tab（键切分取第一个 `:`，`tabId` 是纯数字、`scriptId` 不含冒号），配一层循环就是「发给这个脚本的所有实例」。脚本世界侧由 `MainWorldMessenger.onEvent(type, handler)` 收，`#eventHandlers` 是 `Map<type, Set<handler>>`：同 type 可挂多个（`onRequest` 那张是单值表、重复注册直接抛 `PROTOCOL`，两张表不能合并），取消按函数引用删，单个 handler 抛错只 `console.error`、不波及其他。**SW 侧不存任何订阅状态**：谁订了什么只在脚本世界那张表里，所以 SW 回收后没有需要重放的东西；代价是同 `scriptId` 的在线 tab 都会收到、由接收方自己过滤 —— 与 `chrome.storage.onChanged` 的广播语义一致。这一层只提供通路，载荷形状与「谁在什么时候发」都由上层决定。

- **页面录制（已下线）**：原 MAIN 世界捕获件（hook 页面 `fetch` / `XMLHttpRequest` 采样上报）随「脚本统一切 USER_SCRIPT 世界」删除 —— 它是唯一硬依赖 MAIN 世界的件，USER_SCRIPT 世界 hook 不到页面自己的请求。待办：换 CDP（SW 侧 `chrome.debugger`）方案，本次不做。

`installCustomUserScript` 与 SW 的注册引擎有一处必须对齐：全量同步会把不在保留名单里的注册当残留清掉。本包用 `installedCustomScriptIds()` 把本进程装过的 id 报给 SW，由它并进那份名单 —— 少了这步，装上的脚本会在下一次同步里静默消失。走脚本库的那条注册则要传 `protectFromSync: false`：它的 id 归引擎管，删除 / 关停靠同一次清扫兜底。
内核原文由本包自己取：`build-user-script.ts` 里 `import KERNEL_IIFE from '../dist/mount-dl-iife.js?raw'`，拼装接口对外只有 `{ uuid, name, source, requires }`，调用方不需要知道产物的存在，也无从传错。代价写在明处：`?raw` 是 Vite 方言，这条 import 让本包不再是「任何构建器都能直接编译的纯 TS」，消费方的构建必须认这个后缀（当前唯一消费方 `@duoling/service-worker` 走 Vite，成立）。

内核必须与外层 `var DL` **同处一个函数作用域**，所以 dist 里那份的消费方式是**取文本内联**，不是另起一条注册。
