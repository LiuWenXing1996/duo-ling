# @duoling/dl-core

duo-ling 的**脚本内核**：注入体的实现体与对脚本暴露的能力面都在这里。源码直出（`exports` 指 `src/index.ts`），由消费方编译；唯一自建的一步是内核装配件的 esbuild 打包（产物 `dist/mount-dl-iife.js` 是一段 IIFE 文本，由 `build-user-script.ts` 以 `?raw` 读进来，见下「现状」）。另有两个宿主侧注册面（`installCustomUserScript` 与 `installSWBridgeScript`），只在扩展进程里可用。

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

四块已落地，全部接线：

- **注入体拼装**：`src/build-user-script.ts` 的 `buildUserScript` —— 按「`var DL` 挂载点 → 内核 IIFE → `@require` + 脚本正文」拼成一条 IIFE，三段同处一个函数作用域。
- **内核装配件**：`src/dl.ts` 是 `DL` 的实现类，`src/mount-dl.ts` 负责实例化并写到外层那个 `DL` 上。`build.mts` 把它 bundle 成 `dist/mount-dl-iife.js`（不入库，随 `pnpm -r build` 重建；产物先过四道形状守卫再落盘）。
- **宿主侧注册**：`src/install-custom-user-script.ts` 的 `installCustomUserScript` —— 接一段代码（裸代码，或 GM 包装层包好的整段源码），经 `buildUserScript` 拼好后用 `chrome.userScripts.register` 装成 MAIN 世界脚本，`uninstallCustomUserScript` 反手注销。只在本进程有效（注册不跨浏览器重启存活），缺省全站匹配、`document_start`、只注入顶层 frame。SW 的 `registerScript` 也走它：校验与配置映射留在 SW，注册动作收敛在这里。
- **SW 桥安装**：`src/install-sw-bridge-script.ts` 的 `installSWBridgeScript` —— 把桥中继件（`dist/mount-sw-bridge-iife.js`，页面侧 ISOLATED 语义的常连件）原样注册成默认 USER_SCRIPT 世界脚本（固定 id `dl-sw-bridge`、全站、`document_start`、顶层 frame；保留名单在注册**之前**登记，装上的那一刻就已受保护），顺手 `configureWorld({ messaging: true })`，并实例化 `SWBridgeManager` 返回给 SW。桥的两段链路：MAIN 世界的 `DL` 经 MessageChannel 把 port 递给中继件，中继件经 `chrome.runtime.connect` 常连 SW，三方互转。SW 侧的接收端必须监听 `runtime.onUserScriptConnect` 而不是通用的 `runtime.onConnect` —— userScripts 世界的 connect 只走专用事件，挂错事件名的症状是页面侧 port 建好了、SW 侧一条日志都没有。桥 IIFE 不经 `buildUserScript`：包装层是 MAIN 世界语义，桥必须留在有 chrome 的世界。`DL.getTab/saveTab` 的 SW 侧落点也在这里（`mountTabStore`）：内存 Map 按 `${scriptId}:${tabId}` 存取（SW 回收即蒸发，一期不做持久化），`tabs.onRemoved` 清关 tab 的记录 —— 请求-应答走 seq 配对（状态只在 MAIN 侧，SW 无状态回声）。启动链在宿主的 `initUserScripts` 里调它，位置在引擎可用判定的 `setEngineAvailable(true)` 之后、`registerAllEnabled()` 之前（保留名单要先就位，否则桥会被当残留清掉）；引擎由不可用翻回可用时补调一次。安装失败降级为日志，不阻断脚本注册。SW 侧收口由 `mountSWBridgeManager` 单独提供（同一文件导出）：它必须在 `defineBackground` 回调里**同步**调用 —— MV3 的事件投递按同步注册表决定，SW 休眠后页面中继件的 `connect` 是唤醒 SW 的动作，监听等异步注册链跑完才挂的话那次 connect 已丢失，port 变成无接收方的黑洞。

`installCustomUserScript` 与 SW 的注册引擎有一处必须对齐：全量同步会把不在保留名单里的注册当残留清掉。本包用 `installedCustomScriptIds()` 把本进程装过的 id 报给 SW，由它并进那份名单 —— 少了这步，装上的脚本会在下一次同步里静默消失。走脚本库的那条注册则要传 `protectFromSync: false`：它的 id 归引擎管，删除 / 关停靠同一次清扫兜底。

内核原文由本包自己取：`build-user-script.ts` 里 `import DL_KERNEL_IIFE from '../dist/mount-dl-iife.js?raw'`，拼装接口对外只有 `{ uuid, name, source, requires }`，调用方不需要知道产物的存在，也无从传错。代价写在明处：`?raw` 是 Vite 方言，这条 import 让本包不再是「任何构建器都能直接编译的纯 TS」，消费方的构建必须认这个后缀（当前唯一消费方 `@duoling/service-worker` 走 Vite，成立）。

内核必须与外层 `var DL` **同处一个函数作用域**，所以 dist 里那份的消费方式是**取文本内联**，不是另起一条注册。
