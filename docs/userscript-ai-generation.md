# AI 生成用户脚本 · 实施方案

> 状态：**已拍板（2026-09-14），实施中**，**无待拍板项**——十条主决策见 §6.1；剩余可代定项见 §6.2；前置 9 条见 §5（A 组「容器与通道」1–4 已落地：offscreen entrypoint、`ensureOffscreenReady`、`model:getActiveProfile` + 配置转发、`offscreen-bridge.ts`；B 组「编排与构建」5–9 待开工）。存储底座已随单写方迁 `duoling-state`，见 [userscript-single-writer.md](./userscript-single-writer.md)。
> 前置阅读：`docs/userscript-v2-plan.md`（新形态四阶段，Phase 0–3 已落地）、
> `docs/userscript-api.md`（DL 能力 API 契约）、`docs/userscript-git-history.md`（每脚本一仓的 git 侧车）。
> 与「AI 生成工具」的关系：**本次完全不碰工具链路**（老大决策）。脚本生成与工具生成走两条独立通道，
> 不共用 `parseGeneratedIntents`、不经 `conversation.applyIntents`（该函数在扩展侧目前是 no-op stub）。

---

## 1. 这件事和「AI 生成工具」不是一回事

| 维度 | AI 生成 UserTool | AI 生成用户脚本 |
|---|---|---|
| 产物容器 | 我们自己的容器（工具页） | **别人的页面**（第三方站点） |
| AI 的上下文 | 完全掌握（index.html 就是产物本身） | **只有 URL**，DOM 得另外去拿（§4.2） |
| 生效方式 | 用户主动打开工具才运行 | 命中 `matches` **自动注入** |
| 运行环境 | sandbox iframe + `window.cap`，能力受 `meta.capabilities` 白名单 | USER_SCRIPT 世界 + `window.DL`，**全量能力、无白名单** |
| 落盘形状 | 目录（index.html / meta.json / js / css / assets） | `ScriptProject`（files / entry / config / bundle / git 侧车） |
| 中间环节 | **无构建**：源码即产物 | **有构建**：esbuild 打包 → bundle 才可注入 |
| 廉价验证器 | 没有（要验只能上 headless 浏览器） | **有：esbuild**（亚秒级给出 `file:line`） |
| 反馈源 | 工具页自己写 output.html | 运行期错误环形日志 `us:errors` |
| 越界风险 | 只影响自己 | 影响用户访问的**所有匹配站点**，`matches` 事实上是权限 |

三条直接推论：

1. **脚本生成缺的是「上下文获取」这一环**，工具不需要。不给 AI 任何页面信息的话，它只能凭 URL 猜 DOM 结构，选择器基本靠碰运气。
2. **loop 与构建的宿主条件是同一组，所以必须同址。** esbuild 要求宿主「能派生 Worker（拿得到 `URL.createObjectURL`）+ 不会在任务中途被回收」，而 agent loop 自己也要求后者——这不是两个决策，是**一个决策的两个对象**（§3.1）。定位 B（§4.8）把两者一起送进 offscreen document。
3. **「生成即生效」的风险远高于工具**。工具生成了放着不用没影响；脚本一旦注册就在所有匹配页面跑起来——所以本方案把「生成」与「生效」拆开（§4.5）。

## 2. 现状事实核查（逐项对过代码）

> ⚠️ 本节核查基于 2026-09-14 的代码现状。此后工具链路已移除（`68b70128`）、项目存储已迁独立
> IndexedDB 库 `duoling-state`（[userscript-single-writer.md](./userscript-single-writer.md)）：
> 文中引用的 `src/lib/api.ts`、`fs-store.ts`、`storage.ts`、`tools-data.ts`、`tool-prefs.ts`、
> `tool-generator.ts` 及 `tool:*` 命令均已不存在；「存储双轨」一行的 chrome.storage 清单（offscreen
> 已改为经消息中转）、§2.2 的「工具侧落盘链路」「意图契约解析器」两行、§2.3 缺口 2（offscreen 容器，
> 已落地）随之失效或过时。模块归属现状见下文 §4.8 的归属规则（已修订）。

### 2.1 相关链路的真实状态

| 事实 | 位置 | 含义 |
|---|---|---|
| 对话在**渲染层**直跑 `streamText` | `src/lib/extension-chat-transport.ts` | 模型调用**不经 SW**（也无 `keepalive` / `chrome.alarms` / `onConnect` / `Port`，全仓零命中 → 不存在「需要保活」的链路）；同文件注释明确「本次仅接**纯对话**链路（**无 Agent 工具**）」，`tools` / `stopWhen` 未接 → 本方案要补。**该文件顶部注释同时交代了这次取舍的来由**：「在渲染层直接跑 streamText……少一次中转，也摆脱了 service worker 生命周期对长连接的干扰」——**「绑在 UI 页」是有意换来的**，代价就是今天关掉侧边栏、流当场断（定位 B 要改掉这个前提，§4.8） |
| **SW 的既有定位就是「能力运行时 + 唯一写入方」** | `src/entrypoints/background.ts` 头注释原文：「工具文件与 git 操作的唯一写入方 + 原子能力执行。对话、模型配置不走这里（分别直连 IndexedDB 与 chrome.storage.local，见 src/lib/api.ts）」 | **这是 B 方案最省力的一条**：loop 搬进 offscreen 后，SW 的角色**一个字都不用改**（§4.8） |
| 存储是**双轨**的，且分界线正好落在 offscreen 的能力缺口上 | ① `IndexedDB`：`conversation-store.ts`（库 `duoling-chat`，会话与消息）、`src/fs-store.ts`（lightning-fs 库 `duoling`，工具/脚本文件树 + git 仓）② `chrome.storage.local`：**55 处、10 个文件**（`userscripts/store.ts` 17、`window-api.ts` 8、`tools-data.ts` 8、`tool-prefs.ts` 6、`conversation-store.ts` 6、`storage.ts` 4、`model-store.ts` 3…） | offscreen **只有 `chrome.runtime`**（官方原话：「The runtime API is the only extensions API supported by offscreen documents」）→ **IndexedDB 那半边它直接可用，chrome.storage 那半边必须中转**。分界线是客观存在的，不是我们划的 |
| **IndexedDB 同源共享是项目既有事实** | `conversation-store.ts` 头注释原文：「side panel 与 workbench 标签页**同源**，可直接共享该库，**无需经 background 中转**」 | offscreen 是扩展 origin 的 `window`，与侧边栏同源 → **会话历史、文件树（IndexedDB 侧）不需要任何新通道**。注意 lightning-fs 有内存索引层，双实例会互相看不见写入，故文件树**仍只允许 SW 持有实例**（§4.8 模块归属规则） |
| `chrome.userScripts` 与脚本存储**只在 SW 里** | `background.ts:55` import `userscripts/engine`、`:57` import `userscripts/store`；`engine.ts` 走 `chrome.userScripts.configureWorld / getScripts` | offscreen 拿不到 `chrome.userScripts` → **脚本注册必须留 SW**。这不是妥协，是浏览器规定的分工 |
| 侧边栏与工作台同为扩展 UI 页 | 产物 `sidepanel.html` / `workbench.html` + `chunks/*` | 同源同域，任何扩展页都能直接引 `builder.ts`，无新机制 |
| esbuild 目前只落在工作台 chunk | `.output/chrome-mv3/chunks/workbench-*.js` 是唯一引用 `esbuild.wasm` 的产物 | 谁来构建，谁就得 import `builder.ts`（B 下是 offscreen；wasm 资产零新增，`src/public/esbuild.wasm` 已随包分发） |
| 工具侧落盘链路本次不动 | `src/lib/window-api.ts` 的 `applyIntents` 仍是 no-op stub | 脚本侧**自建**落盘（直调 `userscript:*` 命令面），两条链解耦、互不阻塞 |
| 单轮意图契约解析器**不复用** | `src/lib/tool-generator.ts` `parseGeneratedIntents` | 脚本走 Agent 工具调用，不做 JSON 契约解析 |

### 2.2 可直接复用的资产（脚本侧已就绪）

| 能力 | 位置 | 复用点 |
|---|---|---|
| 多文件落盘 + 条件注册 | `userscript:updateFiles`（`src/entrypoints/background.ts`） | 已是「files + entry + bundle + name + config」全量形状，且**仅在 `enabled` 为真时注册**——正好是 §4.5 要的语义 |
| 启停 | `userscript:toggle`（→ `registerScript` / `unregisterScripts`） | 「一键启用」**零新增后端**，管理页开关已在用这条 |
| **git 侧车快照** | `src/lib/userscripts/us-git.ts` `snapshotProject` | `updateFiles` 保存成功后自动快照，且**已接受 `note` 参数**（`note?.trim()` 缺省才退化成「保存 #N」）→ AI 的 summary 直接当提交信息 |
| 版本恢复 | `us-git.ts` `restoreToCommit`（整树物化 + 新提交） | 「回滚这次生成」无需新机制 |
| esbuild 构建管线 | `src/lib/userscripts/builder.ts`（wasm 懒加载、mem 插件、远程依赖、裸说明符友好报错） | 直接作为 Agent 工具的执行体 |
| 运行期错误环 | `us:errors` + `userscript:errors` 命令 | 二期 AI 自修的反馈源 |
| CSP 检查 | `collectCspWarnings`（`updateFiles` 已返回 `warnings`） | 生成后一次性提示 |
| **SW 已是「唯一写入方」** | `src/entrypoints/background.ts` 全部 `userscript:*` / `tool:*` 命令 | B 方案下 loop 换宿主后，这些命令**照旧经 `chrome.runtime` 调用**——和今天 UI 侧调它们的写法完全一样（`src/lib/api.ts` 的 sendMessage 封装） |

### 2.3 缺口（都要新建）

1. **没有「创建项目」的命令**：`userscript:install` 只收单文件 `source`（且硬编码 `enabled: true`），`updateFiles` 要求 uuid 已存在。AI 一次产出多文件项目、且要「落盘但不启用」时无从落盘。
2. **没有 offscreen 容器**：全仓 `offscreen` 零命中（无 entrypoint、无 `ensureOffscreen`、无 `"offscreen"` 权限）。定位 B 的执行宿主需要从零建。
3. **没有 Agent 编排**：transport 无 `tools`。
4. **「被关掉也能接上」缺的是实现，不是入口**：`reconnectToStream()` 现在直接 `return null`，但它是 `ChatTransport` 接口的**既有方法**（语义正是「页面重载后接上仍在进行中的流」），返回 `null` 只因本地流没有可重连的远端——转入 offscreen 后它第一次有真实语义，需**填实现**（§4.1 / §4.8 机制 3）。
5. **没有 offscreen 侧的配置通道**：`getActiveProfileState()` 直读 `chrome.storage.local`，offscreen 里跑不起来。
6. **没有页面上下文获取通道**：全仓无 `tabs.query`，没有任何 DOM 采集逻辑。
7. **没有脚本生成用的规范载荷**：`docs/userscript-api.md` 是给人看的，AI 侧需要一份可注入的「API + 约束 + 禁止事项」（§8）。
8. **没有「未启用 + 生效范围」展示 UI**：管理页只有开关和 matches 列表，没有「本次生成将影响哪些站点、尚未生效」的确认概念。

## 3. 链路分工

按定位 B（§4.8）的三个容器：

```
┌─ 侧边栏 sidepanel.html ────────────────────────────────┐
│  指令入口 + 观察者（可关闭，关了任务照跑）                  │
│  · 下发：需求 + 当前标签 URL/标题 +（可选）用户点选元素      │
│  · 订阅：任务事件流 → 渲染进度、生成卡片                    │
│  · 重开时带 lastEventId 接上进行中的任务（§4.8 重连协议）    │
└───────────────────┬───────────────────────────────────┘
                    │ chrome.runtime 消息：指令 / 订阅 / 重连
                    ▼
┌─ offscreen document offscreen.html ───────────────────┐
│  Agent loop 常驻宿主（loop 与构建同址，§1 推论 2）         │
│  · streamText + tools + stopWhen + maxSteps            │
│  │   ├─ script_spec   拉规范全文（DL API + 约束 + 禁止项） │
│  │   ├─ script_read   读现有脚本源码（改脚本时用）         │
│  │   ├─ script_apply  写内存文件树 → esbuild 构建 → 诊断  │
│  │   └─ page_probe    页面上下文（元素拾取，紧随主链路）    │
│  · esbuild：默认 worker 模式可用，wasm 常驻（§3.1/§4.8）   │
│  · 任务事件缓冲（供侧边栏重连 replay）                     │
│  缺口：只有 chrome.runtime → 一切持久化/注册经消息回 SW      │
└───────────────────┬───────────────────────────────────┘
                    │ chrome.runtime 消息：能力调用
                    ▼
┌─ background SW ──────────────────────────────────────┐
│  能力运行时 / 唯一写入方（角色与今天完全一致）              │
│  · chrome.storage：脚本记录、DL.store、模型配置            │
│  · chrome.userScripts：注册 / 注销 / configureWorld      │
│  · lightning-fs + isomorphic-git：文件树与快照（单实例）   │
│  · chrome.notifications：面板关闭期间的进度出口            │
└──────────────────────────────────────────────────────┘
```

数据流（生成一次脚本）：
需求 + 页面上下文 → offscreen 的 loop 反复 `script_apply`（构建自收敛）→ 构建通过 →
调 `userscript:createProject(enabled: false)`（SW 落盘 + git 快照，note = AI summary）→
事件流回推侧边栏 → 卡片：尚未启用 · 生效范围 · 会做什么 ·「启用并生效」/「进编辑器」/「回滚」→
用户点启用（`userscript:toggle`，零构建等待）→ SW 注册 → 命中页面注入 →（二期）运行期异常进 `us:errors` 供 AI 自修。

### 3.1 「esbuild 不能转成 SW 吗」——技术核查结论

逐行读过 `node_modules/esbuild-wasm/lib/browser.js`（v0.28.2）的 Go wasm glue：

| 检查项 | 结论 |
|---|---|
| wasm 能否在 SW 编译 | **能**。glue 只依赖 `WebAssembly`、`crypto.getRandomValues`、`performance.now`、`TextEncoder/Decoder`、`setTimeout`、`fetch`——SW 全都有（**无任何 `document` / `window` 依赖**，逐项 grep 确认） |
| 默认 Worker 模式 | **不可用**。`let useWorker = options.worker !== false`（默认走 `new Worker(URL.createObjectURL(blob))`），而 `URL.createObjectURL` 按规范只暴露给 Window / DedicatedWorker / SharedWorker，**ServiceWorker 拿不到** → 必须 `initialize({ worker: false })`，构建直接跑在 SW 线程上 |
| 相对 wasmURL 的解析 | glue 用 `new URL(wasmURL, location.href)`；我们传 `chrome.runtime.getURL('esbuild.wasm')` 是绝对地址 → 不受影响 |
| 调试路径 | glue 的 `console.log / warn` 落到 `chrome://extensions` → Service Worker 控制台，比侧边栏 DevTools 里看报错绕 |
| **生命周期（真正的代价）** | MV3 SW 空闲约 30s 被回收，每次冷启都要重新取 wasm + 编译（`src/public/esbuild.wasm` **实测 13.98MB**，v2 计划写的「约 10MB」偏小）。agent loop 一轮里会多次构建 → 中途 SW 一被回收，下一轮就重付全价；UI 页只付一次（页面会话内常驻） |
| 动态 import | 产物 manifest 的 `background.service_worker` **没有 `"type": "module"`**（classic SW）→ 懒加载 `import('esbuild-wasm')` 是否可用需实测；不行就只能静态打进 316KB 的 SW bundle，把冷启动解析成本转嫁给**每次唤醒** |

**结论：技术上能，收益为负，不做。** 构建随 loop 一起走（§4.8 定位 B → offscreen）。wasm 资产零新增（`src/public/esbuild.wasm` 已随包分发，`chrome.runtime.getURL('esbuild.wasm')` 任何扩展页可读）；在 offscreen 里连「迁 Dedicated Worker」这步优化都不需要——它本来就有 `createObjectURL`，esbuild 的**默认 worker 模式可直接用**。

**补：这不是「能做、只是复杂」的复杂度权衡。** 这个说法容易被反复提出，但它把三类性质完全不同的代价混成一类了：

| 代价 | 性质 |
|---|---|
| `worker: false` 后构建压到 SW 单线程——构建期间 SW 无法处理任何其他扩展消息（排队） | 工程麻烦，**可忍** |
| SW 冷启要重新取 14MB wasm + 重新编译（wasm 编译产物不能跨上下文复用） | 工程麻烦，**可忍** |
| classic SW 无 `"type": "module"`，动态 `import('esbuild-wasm')` 能否用需实测；不行就只能静态打进 SW bundle，**每次唤醒都付解析/执行成本** | 工程麻烦，**可忍** |
| **agent loop 活在一个会被回收的宿主里** | **架构冲突，不可忍** |

要害在最后一行，且比「空闲 30s 回收」更精确：MV3 SW 在**有活跃网络请求时不会死**（流式 LLM 响应期间其实是安全的），但**一旦停下来就会**——而 loop 里天然存在停顿点：等用户看生成卡片、两次构建之间的间隙、用户中途去干别的。也就是说它**偏偏会在最需要它活着的时候死**，而 SW 一死，loop 的上下文（对话历史、已写入的文件、构建状态）全丢。这不是多写几行适配能修的。

**判据：谁常驻，构建就放谁家。** esbuild-standalone 把 esbuild 放 SW 是对的——因为它的调用者是**页面**：页面每次加载脚本都喂一个 `fetch` 事件，SW 有活干、不空闲，且与调用者同域、天然事件驱动（§3.2）。我们的调用者是 agent loop，它是一个**需要长命的进程**；搬去 SW 等于**为一个需要常驻的进程，去求一个会死的进程帮忙**。

> 前提提醒：「常驻」只是相对的——宿主的寿命**上限由用户行为决定，不由技术决定**（用户可以关掉任何 UI、关掉窗口）。所以这条判据只在「任务能在宿主存活期内跑完」时成立；超出则要靠**任务可恢复**兜底，见 §4.8。

**再补：准确表述不是「esbuild 必须放在页面中」，而是「必须放在与调用者同生共死、且能派生 Worker 的宿主里」。** 「需要 DOM」从来不是理由——我们构建时一行 DOM 都不碰；`worker: false` 也只是**在 SW 里被迫**，不是到处都被迫。按三个条件筛一遍扩展里现成的宿主：

| 宿主 | 跑 wasm | 能不阻塞 | 生命周期 | 判定 |
|---|---|---|---|---|
| **offscreen document** | ✓ | ✓（可用 esbuild 默认 worker 模式） | **不主动关就一直活着**（唯一） | ★ **采用**（定位 B → loop 与构建同址，§4.8） |
| 侧边栏 / 工作台（扩展页） | ✓ | ✓（还可再派生 Dedicated Worker） | 与 UI 同生共死 → **用户点 X 即销毁** | 保留为「指令入口 + 观察者」，不再承载 loop（§4.8） |
| Dedicated Worker（由扩展页创建） | ✓ | ✓ | 随创建它的扩展页 | 不采用：**它随页面死**，救不了「关面板」；若将来 offscreen 构建实测卡 UI，可在 offscreen 内再派生一层 |
| background SW | ✓ | ✗（`worker: false`，压在 SW 单线程） | ✗ 空闲 30s 回收 + 单次调用 5 分钟硬顶 | 否决（见上表） |
| content script（注入网页的隔离世界） | ✓ | ✓ | 随网页 | 否决：**每个网页各一份独立 JS 上下文** → 14MB wasm 在每个页面反复加载；且构建是用户的编辑动作，归宿该是扩展自身，不是随手打开的某个网页 |
| 工具页 sandbox iframe | ✓ | ✓ | 随页面 | 否决：opaque origin + 那是「工具运行」链路，不该反向承载构建器 |

这张表也解释了为什么「必须有 DOM」是个会传错的心智模型：它会漏掉 Dedicated Worker（它不是页面），又会误纳 content script（它有 DOM 但归属错）。**真正的筛子是「生命周期对齐 + 不阻塞」，DOM 只是个巧合的副产品。**

### 3.2 外部对照：`esbuild-standalone`（已核查，不采用）

考察对象：npm [`esbuild-standalone`](https://www.npmjs.com/package/esbuild-standalone) `0.0.19`（个人项目，10 个月前发布，0.0.x）。它自称「用 Service Worker + esbuild-wasm 给浏览器提供独立版 esbuild」，看起来像是本条决策的现成替代。**结论：不能替我们干活；但它从外部逐行印证了 §3.1 的两条判断。**

| 核查项 | 事实 | 对我们的含义 |
|---|---|---|
| 它带 esbuild 吗 | **不带**。`esbuild-wasm` 不在 dependencies，靠 `importScripts('https://unpkg.com/esbuild-wasm@0.27.0/lib/browser.js')` 从 CDN 拉，wasm 也从 unpkg 取 | MV3 扩展 SW 的 CSP（`script-src 'self'`）**禁止远程 `importScripts`** → 扩展内不可用；且我们本地已有 `esbuild-wasm@0.28.2`，引入零收益 |
| SW 里怎么初始化 | `const inWorker = self instanceof WorkerGlobalScope` → `initialize({ worker: !inWorker, wasmURL })` | **印证 §3.1**：SW 里跑起来的唯一姿势就是 `worker: false`（建 Worker 走 `URL.createObjectURL`，SW 拿不到）。这是社区通用写法，不是我们的独门判断 |
| 它的 SW 为什么不会被回收 | 那是**页面自己的 SW**，靠页面每次加载 `.tsx` 触发的 `fetch` 事件持续唤醒 | 与我们的处境相反：MV3 background SW 空闲 30s 即回收，没有这种天然心跳 → §3.1 的「生命周期」代价对我们成立、对它不成立 |
| 构建入口 | **URL 驱动**：SW 拦截 `GET /x.tsx` → `fetch` 取源码 → 编译 → 以 module 返回并缓存 | 我们输入在内存（IndexedDB 文件树），无语义对应；我们要的是可被调用的 `build(files)`，它对外暴露的是 `data-*` 属性 / importmap 那套页面集成 |
| 虚拟文件机制 | `entryPoints: Object.keys(files)` + plugin 的 `onResolve` / `onLoad({ namespace: 'virtual' })` | 我们的 `builder.ts` 用 **`stdin` 喂入口 + `mem` / `remote` 双 namespace**，比它更严格（它走 `entryPoints` 会落到磁盘解析路径）→ **无可抄之处** |
| 它多做的部分 | 构建结果按 `hash(source, tsconfig, config)` 存进 CacheStorage，命中即跳过构建 | 唯一我们没有的优化；但 esbuild 单次构建几十毫秒、输入全在内存，收益低于复杂度，不引入 |
| 其他信号 | `.vue` 直接映射成 `tsx` loader、CLI 依赖（yargs / inquirer / picocolors）占了整个包 | 「能跑就行」的取向 + 0.0.x，不适合作为依赖引入 |

一句话：**它是「在网页里用 SW 帮页面编译 TS 的成品」，我们是「在扩展里把内存文件树编译成注入产物」，两者只共用 esbuild-wasm 这个上游。** 参考价值已吸收进 §3.1，实现不复用。

一个附带收获：它选择把 wasm 实例放进 SW，恰恰说明「**esbuild-wasm 实例必须待在长生命周期上下文里、不能每次重建**」是共识——只不过在网页里那是 SW，在扩展里对应的是**长命的扩展文档**（定位 B 下即 offscreen document）。

## 4. 关键设计点

### 4.1 为什么脚本要走 Agent 工具链，而不是照搬单轮意图契约

单轮契约的前提是**产物无法自动验证**——AI 一次吐完，对错只能等用户打开页面看。脚本没这个限制：**esbuild 就是一台确定性验证器**（失败必给 `file:line`）。把构建做成 Agent 工具，AI 就有了「写 → 编译 → 读错误 → 再写」的闭环，一次会话内自我收敛；而这件事**只有多步 Agent loop 能表达**（单轮契约一轮结束就该落盘了）。

代价与裁剪：
- 需补 `streamText` 的 `tools` + `stopWhen`（transport 现在完全没有编排）；
- 工具集要白名单 + `maxSteps` 上限，防无限自修循环：同一会话内构建失败超过 N 次就停手，把诊断抛给用户。

**只有一条对话链路**（2026-09-14 老大指出「没有两条链路，只有一条对话链路」，已逐项核代码确认）

代码事实：全仓只有**一个** `useChat` 实例（`use-global-conversation.ts:119`）、**一个** `ExtensionChatTransport` 类、**一个** `send()` 入口（`:356`）、**一处** `streamText` 调用（`extension-chat-transport.ts:63`）。我此前说的「两条链路」，差别其实**只是一个入参**——`streamText` 有没有 `tools` / `stopWhen`：

| | 现状 | 本方案要做的 |
|---|---|---|
| `streamText` 入参 | `model / messages / temperature / topP / maxOutputTokens / onFinish`（**无 `tools`**） | 补上 `tools` + `stopWhen` |
| 模型能否调工具 | 不能，只能回文本 | 能，**且这次要不要调由模型自己决定** |
| 入口 | `sendMessages()` | **同一个** `sendMessages()`，不新增入口 |
| 用户视角 | 一个对话框 | **同一个**对话框 |

这不是「两条链」，是**同一条链的能力升级**。`extension-chat-transport.ts:10-11` 的注释就是原文：「本次仅接**纯对话**链路（无 Agent 工具）。桌面版 streamText 里的 tools / stopWhen 多步循环属于 agent 编排，**待 capability runtime 在扩展侧打通后再补**」——作者本意就是在**同一个位置补**，不是另起一条。桌面版同理也只有一条：`legacy/src/main/agent-orchestrator.ts:59-60` 的 `tools: aisdkTools` + `stopWhen: isStepCount(8)`，工具只是这条链里的一环。

**这个纠正有实际后果，不是术语洁癖**：我此前用「两条链路被打断损失差一个量级」论证「一期只搬生成链路」，那个论证**建立在一个用户不可知的分界上**——用户说「帮我把这个页面的广告去掉」，模型可能只回一句话（秒级），也可能连续 `script_spec` → `script_apply` → 构建失败 → 再改 → 再构建（分钟级）。**跑多久由模型在运行时决定，用户和 UI 都无从预判。** 既然分界线不可知，就**不能按它裁剪搬谁**——否则体验变成「有时关面板没事、有时丢整个任务，而我事先不知道是哪种」，比「统一都会断」更糟。

**所以定位 B 的正确表述是：整条对话链路搬进 offscreen，不做任务类型分流。** 这比「只搬生成链路」更简单，另有三处复杂度随之消失：

- 不必在 `sendMessages()` 里判断「这次是不是生成任务」——少一处运行时分支；
- 不必维护「一半会话在侧边栏跑、一半在 offscreen 跑」的状态分裂（会话历史的写入方回归唯一，§4.8）；
- `reconnectToStream()` 语义统一：**所有**流都可能需要重连，不是只有生成任务的——它本就是 `ChatTransport` 的既有方法（语义为「页面重载后接上仍在进行中的流」），我们返回 `null` 只因本地流没有可重连的远端；整条链路转入 offscreen 后它第一次有真实语义（§4.8 机制 3）。

净结果是体验一致：**关面板 = 一律继续跑，重开 = 一律接上。**

### 4.2 页面上下文从哪来（脚本独有的输入）

| 档 | 手段 | 拿到什么 | 成本 | 隐私 |
|---|---|---|---|---|
| 0 | 当前标签 URL / 标题 | 站点身份、路径 | 极低（现有 `host_permissions: <all_urls>` 下 `tabs.Tab.url` 应可读，**需实测确认**；不行再看是否补 `tabs` 权限） | 只发 URL |
| 1 | 扩展页直接 `fetch(目标 URL)` | 服务端返回的原始 HTML | 低（扩展页有 host 权限，免 CORS） | 整页 HTML 送模型 |
| 2 | **元素拾取器**（用户点选） | 选中元素：选择器 + 文本 + 关键属性 + 局部结构 | 中 | 只发用户主动选的部分，**隐私最优** |
| 3 | 自动 DOM 摘要探针 | 裁剪后的 DOM 结构 / 交互元素清单 | 高 | 整页结构送模型，需显式告知 |

备注：
- **档 0 的采集方在侧边栏**（它是扩展页、能拿 `chrome.tabs`），采集后随指令一起发给 offscreen（offscreen 里没有 `chrome.tabs`）。
- **档 1 对 SPA 基本无效**（客户端渲染，HTML 里没内容），登录后站点大概率也拿不到有用结构 → 只能当零成本增强，不能当主路径。
- **档 2 的落地路径现成**：注册一个内置「拾取器」脚本项目（`runAt: document_end`、`allFrames: false`），页面里高亮跟随 + 点击取元素 → 经 `DL.fetch` 桥回传（`dl-bridge` 的身份校验要求 sender 的 `scriptId` 与 uuid 一致，所以它必须是一个真实注册的脚本项目）→ 用完注销。油猴做同一件事得自搭服务端，我们是白拿的。
- 档 3 = 档 2 + 一次全页裁剪，别急着上。
- **拾取器采集什么（载荷形态，实施前需定）**：`{ selector, tag, classes, text, attrs, 同类计数 }`。其中**同类计数**（对选中的 selector 做一次 `querySelectorAll().length`）不可省——它决定 AI 写出来的是「只改这一个」还是「改所有同类」，缺了它模型只能猜。
- **回传通道是新增缺口**：DL 桥现有命令（`store.*` / `fetch` / `notify` / `download` / `tabs.open`）中**没有「向 UI 回传自定义数据」这一条**（`dl-bridge.ts` 的 `dispatch` 已穷尽）。两个候选：拾取器写自己的脚本私有存储、侧边栏去读；或给契约新增一条命令。实施时定。
- **要能只让发起拾取的标签页响应**：`matches` 是 URL 模式、不含 tabId，同站多标签会被一起注入。需把 targetTabId 随注入内容带进去（或经存储传递），其余标签页静默。
- **临时注册复用现成机制**：拾取器作为内置项目常驻 `enabled: false`（`registerScript` 只在 `enabled` 时注入，`engine.ts:336`），点「拾取」才切启用 → 注册 → 用完立即注销（同 uuid 重复注册即覆盖，天然幂等）。零新增注册机制。

### 4.3 写入契约

- 脚本用**整文件写**，不用 patch：文件小、多文件之间要一致、改完必须整体重构建，patch 产生的中间态没有意义。（工具用 patch 是因为那个 index.html 可能很长，值得增量。）
- **`script_apply` 把「写」和「验证」合并成一步**：入参 `{ target: uuid | null, summary, config: ScriptConfig, files, entry }`，返回 `{ ok: true }` 或 `{ ok: false, errors: [{ file, line, column, text }] }`。拆成「写」「构建」两个工具的话，AI 会在写完后以为已经成功。
- **构建在 offscreen 内、落盘经 SW**：`script_apply` 只把文件写进 offscreen 的内存文件树并构建；构建通过后由编排层调 `userscript:createProject`（SW 命令）落盘 + 快照，**不由 AI 显式调用**保存，避免「AI 忘了存」。

### 4.4 `matches` 是权限，不是配置

工具侧靠 `meta.capabilities` 做硬白名单；脚本侧浏览器**不给**这种机制（`window.DL` 全量可用），所以只能做「可见 + 可撤回」：

1. AI 提议 `matches`，**默认收窄到当前标签的 host**（`*://<host>/*`）；`*://*/*` 只在用户明说「所有网站」时用，并在卡片上高亮；
2. 卡片展示**生效范围 + 脚本会做什么**——后者由静态扫描 bundle 里的 `DL.` 用法得出（用到 `fetch` = 可跨域请求、`store` = 读写私有存储、`notify` / `download` / `tabs.open` 各自对应）。展示级软审查，成本极低；
3. 生效时机见 §4.5。

### 4.5 生成结果的处理：先落盘不启用 + 一键启用（已拍板）

- **落盘**：新增 `userscript:createProject`，收 `{ name, config, files, entry, bundle, enabled: false }` → `saveProject` → **不调用 `registerScript`** → git 快照照做（`note` = AI summary）。于是「生成」与「生效」彻底解耦，AI 的产物默认**零影响**。
- **启用**：完全复用现成能力——`userscript:toggle(uuid, true)`。bundle 已随项目落盘，启用是纯注册动作，**无构建等待**。
- **卡片必须讲清三件事**：①「尚未启用」；②生效范围（matches 原文）；③「脚本会做什么」（§4.4 的静态扫描）。三个出口：「启用并生效」/「进编辑器看一眼」/「回滚或删除」。
- **代价（接受）**：用户可能忘了启用，管理页里堆一批关着的脚本。缓解：卡片主按钮就是「启用」；管理页可对「AI 生成且从未启用」的项目加一条提示（可选）。
- **额外收益**：未启用 = 未注册 = 不注入，用户能在启用前读一遍源码——比「自动生效 + 事后回滚」稳得多；回滚/删除也仍是干净的单步操作。

**失败产物去哪儿了：它本来就在对话记录里**（2026-09-14 老大提出，已核代码）

循环期间 AI 生成的是**普通的 `ScriptProject` 文件树**（入口 `.ts`、被 import 的模块、构建产物 `bundle`），与用户手写的脚本**同一种结构**——不是新数据类型。「它在哪」分两段：**loop 期间只在 offscreen 的内存文件树里**（`script_apply` = 写内存 + 当场构建，`userscript:createProject` 是唯一落盘入口）；**收敛成功才一次性落盘**（`enabled: false`）。

但**失败那一份不用愁**，因为它在对话记录里：

- `Message.parts` 存的是**完整 `UIMessage.parts`（reasoning / text / tool）**（`src/shared/types.ts:43-45` 注释原文）；
- **回复完成时（`onFinish`）整条 assistant 消息连同 parts 落盘**到 IndexedDB（`use-global-conversation.ts:9`、`:226-234`）；回读时 `toUiMessage` 据此还原「分轮思考 / 工具卡 / 多段正文」。
- → `script_apply` 的**入参（完整文件树）与返回（构建诊断）本来就随对话保存**，用户在对话里能看到 AI 试过哪些文件、卡在什么错误上。

**两个边界要分清**（两个机制各覆盖一半，不重叠）：

| 情形 | 走到 `onFinish`？ | 产物还在吗 | 靠什么覆盖 |
|---|---|---|---|
| loop 正常失败（`maxSteps` 耗尽） | ✅ | **在对话历史里** | 无需任何额外机制 |
| 宿主被杀（关窗口 / 崩溃 / 内存压力回收） | ❌ | 这一轮的 parts **全丢** | §4.8 机制 4 的「每步快照」 |

**代价（必须认）**：§4.3 的写入契约是**整文件写、不 patch** → N 步 loop 中每步的 tool input 都是**完整文件树** → **单条消息的 parts 会重复存 N 份近似文件**，对话存储明显放大。IndexedDB 存得下，但要避免再叠一份：**§4.8 机制 4 的每步快照只存「最新一份」（覆盖写），历史由 tool parts 承载，不双份存。**

**「继续改」也随之变成零成本**：在那条对话里接着说即可——`useChat` 会把整条 messages（含工具调用历史）带回模型，**模型看得到自己之前写的文件**。

**结论：不做「草稿」**（2026-09-14 老大追问「为什么需要草稿」，复核后撤回原设想）

上一轮在此处设想过一个「保存为脚本草稿」按钮。复核后**撤回**——它想服务的每个需求都已有更合适的载体，再加它只是**凭空造出一个并不存在的产物类型**：

| 需求 | 已有载体 |
|---|---|
| 想知道 AI 试过什么、卡在哪 | **对话历史**（`onFinish` 把含 tool 调用的完整 parts 落盘，代码依据见上） |
| 想让 AI 接着改 | **在同一条对话里接着说**（`useChat` 把整条 messages 含工具调用历史带回模型） |
| 宿主被杀时别丢产物 | **§4.8 机制 4 的任务快照**（每步覆盖写进 IndexedDB 任务记录，不外露、不污染管理页） |
| 想自己手改 | **成功路径已免费提供**——收敛即 `createProject(enabled: false)`，进管理页后 `openEditor` / 启用 / 回滚现成 |

**唯一残留的窄缝**是「最后一次构建成功、但 loop 因 `maxSteps` 提前收尾」（编译没成功的不算——那种产物不可用）。**这条窄缝也不为它加按钮**，理由：

1. **失败产物的价值取决于它能否编译。** 编译不过的**完全不可用**——让用户手改编译错误，比让他重新描述一遍需求更费劲，而且 AI 改得比人快；而能编译的**会自动落盘**（走成功路径）。两侧相减，草稿服务的场景接近空集。
2. **「别浪费那几分钟」不是理由。** 用户要的是能用的脚本，不是一个有研究价值的半成品。
3. **成本不对称。** 入口一旦可点，脚本管理页就会混进「AI 没做成的东西」；而失败率取决于模型能力（一期无数据）。为一个多数时候是死的按钮引入一个新概念，不划算。**将来实测确有此需，再补也是「一次命令调用 + 一个按钮」（`saveProject()` 本就是按 uuid 覆盖写的 upsert，`store.ts:79-81`），不必提前造。**

**顺带一个命名纠正**：即便将来要做，也**不该叫「草稿」**——落盘后的它和「AI 一次成功但未启用」的产物**结构完全同构**（都是 `ScriptProject` + `enabled: false`），叫「草稿」会把它说成二等公民。统一表述应始终是「AI 生成的脚本（未启用）」。

### 4.6 撤销与档案

- **撤销**：`restoreToCommit` 已实现，卡片给「回滚到生成前」入口即可，不做 reset。
- **档案（建议补）**：工具侧已有 `archive.md`（AI 主笔、随 git 版本化的说明书），脚本侧**没有任何对应物**。脚本比工具更需要它——工具用户会主动打开，脚本是后台静默生效的，半年后用户只看到一串开关。建议 `ScriptProject` 加 `notes` 字段（别一上来做独立文件），AI 每次生成/修改时更新「干什么、在哪生效、依赖哪些 DL 能力」。

### 4.7 反馈闭环的两段

- **构建期（本期）**：Agent loop 内自修，§4.1。
- **运行期（二期）**：`us:errors` 已有页面 URL + `duoling://` sourceURL 堆栈，用户点「让 AI 修」时把错误记录 + 当前源码带进新会话。**必须由用户触发**，不做后台自动改脚本——静默修改在所有匹配站生效的代码，不可接受。

### 4.8 执行宿主：定位 B（下完单就走），loop 与构建一起进 offscreen document

> **已拍板（2026-09-14，老大）：定位 B。** 即「用户发起生成后可以关掉侧边栏去干别的，任务照跑完，回来收结果」——这是产品定位，不是技术偏好，且技术上**只有 offscreen document 一条路**（见下）。

**问题**（老大提出）：用户发起生成后去忙别的，侧边栏可能被关 → loop 与构建一起消失。

**三层事实**（本次现查代码与官方文档）：

1. **现有链路是「有意绑在 UI 页」的。** `extension-chat-transport.ts` 顶部注释原文：「……在渲染层直接跑 streamText……少一次中转，也摆脱了 service worker 生命周期对长连接的干扰」。代价就是今天关掉侧边栏，正在生成的回答当场断。所以这不是本方案新增的风险，是既有前提——**定位 B 要改掉的正是这个前提**。
2. **loop 不在 SW 里。** 全仓 grep `keepalive` / `keepAlive` / `chrome.alarms` / `setInterval` / `onConnect` / `Port` **零命中**——既没有保活代码，也没有需要保活的对象；`offscreen` 同样零命中。真正的位置是**侧边栏渲染层**。这比「跑在 SW 里」更脆：SW 至少还有 30s 空闲容错 + 单次调用 5 分钟窗口，而**用户关面板是零容错**——document 一销毁，`streamText` 的流当场断，连保存现场的时机都没有。（「SW 需要保活」是 MV3 的通用知识，我们这条链路恰好绕开了它。）
3. **「去忙别的」多数情况不会关掉面板。** 产物 manifest 只有全局 `side_panel.default_path`，代码里**没有任何 `chrome.sidePanel.setOptions({ tabId })`**（全仓 grep 为空）→ 没有 per-tab 配置，**切换标签页时面板保持、document 不重建**。真正会丢的只有三种：用户主动点 X 关面板、关掉浏览器窗口、扩展被重载。

**宿主寿命对照**：

| 宿主 | 不主动关就一直活着？ | 用户关掉 / 关窗口 | 能否靠技术保活 |
|---|---|---|---|
| 侧边栏 / 工作台（document） | 是 | **立即销毁** | 不能 |
| background SW | **否**——空闲 30s 即回收 + 单次调用 5 分钟硬顶 | 同左 | 部分（keepalive 只能改 30s 那条，5 分钟那条不可绕过，代价大且官方不鼓励） |
| **offscreen document** | **是**（唯一） | 关窗口时死 | 不需要 |

**offscreen document 的完整约束与 API 面**（官方文档 + 本地 `@types/chrome` 核查）：

- **版本与权限**：Chrome 109+（MV3）；manifest 需声明 `"offscreen"`。
- **API 面**：`createDocument({ reasons, url, justification })` / `closeDocument()`。**`chrome.runtime` 是它唯一可用的扩展 API**（官方原话），所以**消息必须用 runtime 那套成员**。存在性检查现代做法是 `chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [...] })`（Chrome 116+；项目 `minimum_chrome_version: 133` 够用），比老的 `clients.matchAll()` 直接。（`hasDocument()` 是 `@since Chrome 150`，不用。）
- **`reason` 是必填声明，而且就是寿命开关**：官方枚举 15 个——`TESTING` / `AUDIO_PLAYBACK` / `IFRAME_SCRIPTING` / `DOM_SCRAPING` / `BLOBS` / `DOM_PARSER` / `USER_MEDIA` / `DISPLAY_MEDIA` / `WEB_RTC` / `CLIPBOARD` / `LOCAL_STORAGE` / `WORKERS` / `BATTERY_STATUS` / `MATCH_MEDIA` / `GEOLOCATION`。只有 `AUDIO_PLAYBACK` 带自动关闭（无声 30 秒），其余全部无寿命限制。我们要 `BLOBS`（拿 `createObjectURL`）+ `WORKERS`（派生 worker 跑构建）。顺带一处印证：`BLOBS` 的官方描述括号里**点名了 `URL.createObjectURL()`**——§3.1 那条「SW 拿不到它」的缺口，Chrome 在文档层面自己承认了，并专设一个 reason 来补。
- **另三条官方明写的约束**：offscreen 的 URL **必须是打包进扩展的静态 HTML 文件**（→ 新增一个 entrypoint，注意 WXT 的 `x.html` / `x.ts` 同名冲突规则）；**不能聚焦**；`opener` 恒为 `null`。
- **每扩展同时只能有一份**（隐身与普通模式各一份）。
- **调试路径**：offscreen 的 `console` 落在 **SW 的 inspector**（`chrome://extensions` → Service Worker），不再是侧边栏 DevTools。

**为什么定位 B 的代价比上一轮估的小——三条刚查清的事实：**

1. **SW 的角色本来就不用改。** `background.ts` 头注释写着它的定位是「工具文件与 git 操作的**唯一写入方** + 原子能力执行」。迁移只是**换个客户端调同一套命令**：今天侧边栏经 `api.ts` 的 sendMessage 调 `userscript:*`，明天 offscreen 用同一个封装调同一条命令——**命令面一字不改**。这不是「把东西搬到一个陌生容器」，而是「把 loop 放进一个新宿主，SW 完全照旧」。
2. **存储的双轨分界线恰好在 offscreen 的能力边界上。** IndexedDB（会话历史 `duoling-chat`、lightning-fs 库 `duoling`）**同源共享**，offscreen 直连可用；`chrome.storage.local`（55 处）读不到——但它那半边今天也**已经全部经 SW**（`background.ts` 的 `userscript:*` / `tool:*` 命令），所以对 loop 而言是**零变化**。
3. **`chrome.userScripts` 本来就在 SW 独占。** offscreen 拿不到它，但脚本注册从第一天起就只在 `background.ts` 里做 → 无需搬迁，也**不该**搬。

**三容器职责与「谁写什么」**（防双写是设计红线）：

| 数据 | 唯一写入方 | 说明 |
|---|---|---|
| 脚本记录 / `DL.store` / 模型配置（`chrome.storage.local`） | **SW** | offscreen 经消息调用，绝不直接 import 那些模块 |
| 脚本注册（`chrome.userScripts`） | **SW** | offscreen 无此 API |
| 文件树与 git 快照（lightning-fs + isomorphic-git） | **SW** | **lightning-fs 有内存索引层，双实例会互相看不见写入** → 只允许 SW 持有实例 |
| 会话历史（IndexedDB `duoling-chat`） | **offscreen**（整条对话链路） | 同源共享：侧边栏只读 + 订阅，**不写**（否则双写）。整条链路（含纯对话与工具调用）都在 offscreen，**不做任务类型分流**（§4.1） |
| 任务运行时状态（进行中标记、事件缓冲） | **offscreen** | 侧边栏重开时读它、订阅它 |
| 进度通知（面板关闭期间） | **SW** | `chrome.notifications`（`notifications` 权限已在）——offscreen 没有该 API，经消息请 SW 发 |

> **注（2026-09-14 追加）**：工具链路移除后，上表「文件树与 git 快照」一行将变更——其归属从 SW 迁至 offscreen（lightning-fs 仍保持"唯一写入方"这条约束，只是换持有者）。方案见 [offscreen-fs-migration.md](./offscreen-fs-migration.md)。

**模块归属规则（硬约束，写代码时按这条落）**（2026-09-15 按单写方落地后的现状修订）：
`src/lib/userscripts/store.ts`（`DL.store` 值与 `us:errors`，SW 直写）、`src/lib/model-store.ts`、`src/lib/userscripts/engine.ts` —— **只允许被 SW 代码 import**。
项目数据走 `state-db.ts` / `project-store.ts`（读）与 `project-write.ts`（写，**只归 offscreen**）；`lightning-fs` 实例（`us-fs.ts`）只许 offscreen 持有。
offscreen 侧只能 import：`builder.ts`（纯 esbuild，无 chrome API）、`extension-chat-transport.ts`、`ai` SDK、`state-db.ts` / `project-write.ts`，以及 **`offscreen-bridge.ts`**（把「读模型配置」等封装成 `chrome.runtime.sendMessage` 调用）。
这条规则的价值：**它把「能不能在 offscreen 里跑」变成编译器可查的问题**——import 了只有 SW 能跑的模块就会在运行时报 `chrome.storage is undefined`，而不是等到某个冷门分支才暴露。

**新增的四个机制**

1. **`ensureOffscreen()`（SW 侧）**：`getContexts` 查存在性 + 在途 promise 防重复创建（官方示例的 `creating` 写法）。**触发点放在「收到生成请求」时**，而不是只靠 `onStartup` / `onInstalled`——因为 Chrome **不会自动启动** offscreen，而安装时 SW 未必有机会跑；用户在生成入口点下去那一刻 ensure，是唯一必然发生的时机。
2. **配置通道**：SW 新增 `model:getActiveProfile` 命令（直接复用现成的 `getActiveProfileState()`，SW 里本来就能调）。offscreen 启动时取一次并缓存；配置变更经 SW 的 `storage.onChanged` 转发给 offscreen（offscreen 没有 `chrome.storage`，收不到该事件）。**关于 apiKey：它会随这条消息进入 offscreen 内存**——这是同扩展内上下文之间的传递（offscreen 与 SW 信任级别等同），不是新增对外暴露面；但仍应做到「取一次、缓存、不写日志」。
3. **订阅 / 重连协议**（B 的核心体验；**入口现成，要写的是实现**）：`ChatTransport` 接口本就预留 `reconnectToStream()`，语义正是「页面重载后接上仍在进行中的流」——我们返回 `null` 只因本地流没有可重连的远端（§4.1）。要写的是：offscreen 维护 per-task 事件缓冲（内存环形 + 关键节点落 IndexedDB），每事件带自增 `eventId`；侧边栏 `connect` 时带 `lastEventId` → offscreen 先 replay 缓冲、再续订。缓冲设上限 + 过期清理（关掉侧边栏数小时后重开，应显示「任务已完成」或「已中断」，而不是把几百条旧事件倒出来）。
4. **任务可恢复（简化版，但粒度要够用）**：offscreen 也不是不死的（见下），所以保留兜底。**注意「只记一个『进行中』标记」是不够的**——没有文件快照，「继续」这个选项就无从而来（内存里的文件树已随宿主消失）。够用的粒度是：
   - **每步把文件树快照进 IndexedDB 的任务记录**（`{ taskId, step, files, status, heartbeat }`）——这不是 git 提交，只是任务运行时状态的 JSON；文件总量 KB~几十 KB 级，成本可忽略；
   - **git 快照仍只在收尾做一次**（它是全链路**唯一非幂等**的动作，其余全可重跑）；
   - **只存「最新一份」（覆盖写）**——历史由对话记录的 tool parts 承载（§4.5），**不双份存**；
   - 侧边栏启动时对 `status = running` 但心跳过期的记录做孤儿判定，提示「上次生成中断在第 N 步，继续 / 丢弃」——**「继续」此时才有东西可继续**；
   - **它只覆盖「宿主被杀」这一种**（`onFinish` 没跑到 → 这一轮的 parts 全丢）；loop 正常失败（`maxSteps` 耗尽）走得到 `onFinish`，产物已在对话历史里，不靠这份快照（§4.5）；
   - 一份机制同时兜住：关侧边栏、关窗口、浏览器崩溃、offscreen 被内存压力回收。

**一条必须精确的限定**：offscreen「不主动关就一直活着」成立但**不绝对**——权威实践指南的措辞是它 *not subject to idle eviction, but Chrome may still close it if memory pressure is extreme*；且**关浏览器窗口 / 扩展重载 / 浏览器崩溃三者它一个都挡不住**。所以上面的「任务可恢复」不能删，只是简化。

**代价清单（核全）**

| 代价 | 具体影响 |
|---|---|
| 新增 `"offscreen"` 权限 | 当前 permissions 是 `storage` / `sidePanel` / `userScripts` / `notifications`；上架审查可见，项目规范要求先确认 |
| 新增一个 entrypoint | `offscreen.html` + 入口脚本；注意 WXT 的 `x.html` / `x.ts` 同名冲突规则（入口脚本用非约定名由 html 引用） |
| 消息通道由「UI ↔ SW」变三层 | 侧边栏 ↔ offscreen ↔ SW。**多了一层就多一处协议**：指令 / 事件 / 能力调用三类消息要有统一的 route 与错误处理，否则很难查 |
| 模型配置（含 apiKey）要跨进程取 | 见上「配置通道」；一次性，不是每轮 |
| `reconnectToStream` 从桩变真实现 | 它**不是新发明的入口**（`ChatTransport` 的既有方法，§4.1），但**事件缓冲与 replay 逻辑是全新增量**，也是 B 体验的命门 |
| 进度对用户不可见 | 面板关闭期间用户看不到进度 → 用 `chrome.notifications`（权限已在）+ 可选 action 角标；由 SW 发 |
| 谁来启动 / 重启它 | `ensureOffscreen()` + 在途 promise 防竞态（见上）；进程崩了需要看门狗 |
| **泄漏是 MV3 内存膨胀第一大原因** | 官方与社区一致强调「用完必须 `closeDocument()`」。我们要它常驻＝**故意长活**，故生命周期集中在 `offscreen.ts` 一个模块（ensure/close 均经此处），**不设退出条件**（空闲 / 任务结束 / 面板关闭均不自关，老大 2026-09-14 拍板）；仅在调试命令 `offscreen:close` 时主动关 |
| 调试路径变化 | offscreen 的 `console` 落到 SW inspector，不再是面板 DevTools |
| offscreen bundle 变肥 | 它要打进 `ai` SDK + `esbuild-wasm` 的 JS 部分（wasm 仍是外部资源），冷启动加载量上升（待实测） |

**「不做」与「留待实测」**
- **不做**：把 loop 或构建搬进 SW（§3.1 已否）。
- **留待实测**：① offscreen 首次构建的 wasm 加载耗时；② 侧边栏与 offscreen 之间消息的派发行为（若 SW 也监听 `onMessage`，消息会连带唤醒它——这**不是坏事**：SW 本来就要处理存储中转，等于顺带保活；但要确认没有意外唤醒风暴）；③ 面板关闭期间通知的打扰度。

**判据修正（二次）**：§3.1 那句「谁常驻，构建就放谁家」要补一条前提——**宿主寿命的上限由用户行为决定，不由技术决定**。但由此推出的结论不是「所以别找不死宿主」，而是**两个问题必须分开回答**：

- **「在哪跑得更舒服 / 更不被打断」** → 宿主选择（offscreen 是三条件唯一全过的那个）；
- **「被打断后还能不能继续」** → 任务可恢复（与宿主无关的兜底）。

定位 B 的回答是：**前者用 offscreen（一期就做），后者降级为简化兜底**。

## 5. 一期范围

**前置（按依赖顺序，共 9 条）**

**A. 容器与通道（先有地方跑，再谈跑什么）**

1. **新增 `offscreen` entrypoint** + manifest 加 `"offscreen"` 权限（`wxt.config.ts`；**老大 2026-09-14 已批准**，§6.1 #9）；`reason` 用 `['BLOBS', 'WORKERS']`。
2. **`ensureOffscreen()`（SW 侧）**：`chrome.runtime.getContexts` 查存在性 + 在途 promise 防竞态；挂在「收到生成请求」的入口处，另在 `onStartup` / `onInstalled` 各挂一次。
3. **配置通道**：SW 新增 `model:getActiveProfile`（复用 `getActiveProfileState()`）；`storage.onChanged` 转发给 offscreen。
4. **offscreen 侧桥接层**（新文件，如 `src/lib/offscreen-bridge.ts`）：把「读模型配置 / createProject / toggle / 读脚本」封装为 runtime 消息调用，并守住 §4.8 的模块归属规则。

**B. 编排与构建（核心链路）**

5. **整条对话链路与构建搬进 offscreen**（**不做任务类型分流**——只有一条链路，§4.1）：`streamText` + `tools` + `stopWhen` + `maxSteps` 上限；`builder.ts` 随 offscreen 入口 import（wasm 懒加载 + 首次构建 loading 态）；esbuild 用默认 worker 模式（不必 `worker: false`）。
6. **`reconnectToStream` 真实现 + 事件缓冲**（§4.8 机制 3）：per-task 事件带 `eventId`，侧边栏按 `lastEventId` replay 后续订。
7. **`userscript:createProject`**（收 name / config / files / entry / bundle，**支持 `enabled: false`**）；顺手把 `userscript:install` 收敛为它的单文件快捷调用，避免两套写入路径。
8. **Agent 工具三个**：`script_spec`（规范载荷，§8）/ `script_read` / `script_apply`（写内存 + 构建 + 返回诊断）。
9. **生成卡片 + 可恢复状态**：卡片（未启用 + 生效范围 + 会做什么 + 启用 / 编辑器 / 回滚）；**每步把文件树快照进 IndexedDB 任务记录（覆盖写、只留一份）**——只为「宿主被杀」后的续跑，另加收尾一次 git 快照 + 孤儿判定提示「继续 / 丢弃」（§4.8 机制 4）；**失败那轮的产物就地留在对话历史里，不做「草稿」落盘**（§4.5）；面板关闭期间的进度走 `chrome.notifications`。

**上下文**：当前标签 URL / 标题 + 用户描述（档 0，由侧边栏采集）。元素拾取器（档 2）紧随主链路，可单独排期，不阻塞。

**明确不做（本期）**

元素拾取器与页面探针（紧随其后）、档 1 / 档 3、运行期错误自动回喂、`DL.page`（依赖 Phase 4 反向中继）、**SW 化 esbuild**（§3.1 已否）、工具侧 `applyIntents` 链路（老大决策：不用管）、脚本市场 / 分享。

## 6. 决策台账

### 6.1 已拍板（2026-09-14）

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 编排形态 | **Agent 工具链**（不照搬工具的单轮意图契约）——依据是 esbuild 这个廉价确定性验证器，§4.1 |
| 2 | 生成入口 | **侧边栏**（指令入口 + 观察者）；现成替代 `esbuild-standalone` 已核查不适用（§3.2） |
| 3 | 生效方式 | **先落盘不启用 + 一键启用**（§4.5） |
| 4 | 工具侧 | **本次不动**；脚本链路与工具链路解耦（§2.1） |
| 5 | esbuild 放哪 | **不进 SW**（§3.1 逐项核查：`worker: false` 被迫 + 冷启重付 14MB + 单次调用 5 分钟硬顶）；随 loop 走 |
| 6 | **执行宿主 = 定位 B** | 老大 2026-09-14 拍板：**「下完单就走」**（发起后关掉侧边栏，任务照跑完，回来收结果）。→ **offscreen document 为一期必需**，**loop 与构建一起搬**（§4.8）；任务可恢复降级为简化兜底。技术上 B 无替代方案：搬 SW 有 5 分钟硬顶，搬 content script 随网页死，Dedicated Worker 随页面死 |
| 7 | 落盘范围 | **整条对话链路搬进 offscreen**，不做「只搬生成任务」的任务类型分流——「两种链路」是误判（实际只有一个 `useChat` 实例、一处 `streamText` 调用，差别仅 `tools` 入参）；一次请求跑多久由模型运行时决定、用户不可预知，故不能按链路裁剪（§4.1） |
| 8 | **页面上下文隐私边界** | 老大 2026-09-14 拍板：**档 0 必做 + 档 2 拾取器紧随主链路**；档 1 可选尝试，档 3 后置。即**只发「当前页 URL / 标题」与「用户主动点选的那一块」**，不自动抓整页 DOM（§4.2） |
| 9 | **新增 `"offscreen"` 权限** | 老大 2026-09-14 **已批准**。定位 B 的硬前提（没有它 offscreen 起不来）；上架审查可见项，按项目规范（AGENTS.md「不自行增删 manifest 权限」）走完确认流程 |
| 10 | **失败产物处置 = 不做「草稿」** | 老大 2026-09-14 追问「为什么需要草稿」→ 复核代码后**撤回**上一轮设想的「保存为脚本草稿」按钮：失败产物的四个相关需求各已有载体（追溯→对话 parts、继续改→对话里接着说、抗中断→任务快照、手改→成功路径自动落盘），再加按钮只是**凭空造出不存在的产物类型**（§4.5 完整论证） |

### 6.2 仍待定

> **必答**＝需要老大拍板（涉及权限 / 隐私 / 用户可感知行为，或不可逆）；**可代定**＝我按建议执行，老大否决即改。
>
> 原 #8「构建失败后的草稿处置」已于 2026-09-14 拍板为**不做**，移入 §6.1 #10（编号保留原样，避免破坏交叉引用）。

| # | 决策点 | 我的建议 |
|---|---|---|
| 9 | 可代定 · 脚本档案（对齐工具 `archive.md`） | **加**，`notes` 字段起步 |
| 10 | 可代定 · 内置脚本（拾取器等）放哪里 | 管理页「内置」分组，与用户脚本同构但不可编辑 / 不可删除 |
| 11 | 可代定 · 首条 `script_spec` 规范载荷的形态 | 由 `docs/userscript-api.md` + §8 生成一段注入文本；`.d.ts` 留给脚本作者（v2 计划 P3 已列） |
| 12 | ~~offscreen 的退出条件~~ **已撤销** | 老大 2026-09-14 拍板采用**常驻策略**：offscreen 在 install / startup / SW 冷启动即 `ensureOffscreen()`，不再设任何自关退出条件；极端内存压力下 Chrome 可能关闭它，由请求方 `ensure` 兜底重建 |
| 13 | 可代定 · `maxSteps` 上限 | 先沿用桌面版的 8（`legacy/src/main/agent-orchestrator.ts:60` 的 `stopWhen: isStepCount(8)`）；实测后调 |
| 14 | 可代定 · 任务进行中用户又发一条消息怎么办 | 建议**排队**（不并发同会话两条流），面板上显式提示「当前任务进行中，已排队」——避免同一会话两条流交错写入 |

## 7. 风险

| # | 风险 | 说明 | 缓解 |
|---|---|---|---|
| 1 | Agent 自修死循环 / 成本失控 | 模型反复改构建错误 | `maxSteps` 限死 + 失败 N 次停手抛诊断 |
| 2 | 首次构建的 14MB wasm 等待 | 实测 13.98MB；offscreen 里只付一次、之后 wasm 常驻（比侧边栏方案更好），但第一次要等 | 懒加载 + loading 态；offscreen 若在生成请求时创建，等待与「ensure → 构建」串行发生，需在 UI 上给明确反馈 |
| 3 | 选择器脆弱 | 无页面上下文时 AI 猜的选择器站不住 | 档 2 拾取器让用户喂真实结构 |
| 4 | 页面内容外发 | 档 1 / 档 3 会把页面 HTML 送给模型 | 本期只用档 0 / 档 2；档 3 落地前必须显式告知 |
| 5 | 生成物被遗忘在未启用状态 | 「先落盘不启用」的副作用 | 卡片主按钮为「启用」；管理页可对未启用项目加提示 |
| 6 | AI 误用已作废概念 | 先验里有 `unsafeWindow` / `@grant` / 同步 `GM_getValue`，写出来的脚本跑不起来 | `script_spec` 明确列禁止事项（§8）；`script_apply` 的构建失败会当场纠正 |
| 7 | 脚本越界影响面大 | 一旦启用即在所有匹配站生效 | 默认收窄 matches + 卡片展示范围 + git 一键回滚（「先不启用」已把默认风险降到零） |
| 8 | **offscreen 泄漏 / 无人回收** | 官方与社区一致：offscreen 泄漏是 MV3 内存膨胀第一大原因。我们要它常驻 = 故意长活 | 生命周期集中在 `offscreen.ts` 一个模块（ensure/close 均经此处，不散落 `createDocument` 调用）；**不设退出条件**（§6.2 #12 已撤销，老大 2026-09-14 拍板常驻） |
| 9 | **offscreen 未创建 → 任务静默不启动** | Chrome 不会自动启动它；安装时 SW 未必有机会跑 | `ensureOffscreen()` 挂在**生成请求入口**（必然发生的时机），不只挂 `onStartup` / `onInstalled` |
| 10 | **三层消息协议出错难查** | 侧边栏 ↔ offscreen ↔ SW，跨三个上下文 | 统一 route 字段 + 每条消息带 `taskId`；按 §调试方法论「三段各打一条日志」定位；offscreen 的日志在 SW inspector |
| 11 | **模型 apiKey 跨进程** | 配置读取要从 SW 传给 offscreen | 取一次 + 内存缓存 + 不写日志；offscreen 与 SW 信任级别等同，非新增对外暴露面 |
| 12 | **会话历史双写** | offscreen 与侧边栏都能直连同一个 IndexedDB | 硬性约定：生成链路的会话写入方**只有 offscreen**，侧边栏只读 + 订阅（§4.8「谁写什么」） |
| 13 | **对话存储被工具调用放大** | 写入契约是整文件写 + N 步 loop ⇒ 单条 assistant 消息的 `parts` 里重复存 N 份近似文件树（§4.5） | 接受（IndexedDB 存得下）；**任务快照只留最新一份**、不与 parts 双份存；若实测过大，再考虑 tool output 只回摘要（代价是丢掉「每步可完整还原」） |
| 13 | 生成中途被中断（关窗口 / 崩溃 / 扩展重载） | offscreen 挡不住这三者 | 简化版可恢复：进行中标记 + 收尾一次 git 快照 + 孤儿判定提示 |
| 14 | 每条消息多一次跨上下文跳转 | 整条链路搬 offscreen 后，即使一句闲聊也要走「侧边栏 → offscreen → LLM」，流式事件还要逐段回传（原为侧边栏直跑 `streamText`） | 同为扩展内 `chrome.runtime` 消息，量级微秒~毫秒，相对首 token 延迟（百毫秒~秒）可忽略；若实测流式观感变差，再把逐条 `sendMessage` 换成 `MessageChannel` 长连 |

## 8. 附：`script_spec` 该写什么（AI 最容易写错的地方）

1. 没有 `==UserScript==` metadata、没有 `@grant` / `@require` / `unsafeWindow`——配置走 `config` 对象（`matches` / `excludeMatches` / `includeGlobs` / `excludeGlobs` / `allFrames` / `runAt`）；
2. 入口文件**不得有顶层 `export`**（iife 格式约束）；
3. 依赖只能 `import 'https://…'`（CDN 直链，会被逐条 fetch 并持久化进项目），**裸包名 `from 'lodash'` 会报错**；
4. `DL` **全 async**——照抄油猴的 `if (GM_getValue('x'))` 写法会恒真；存储值必须是 Json；
5. `DL.page.*` **尚未可用**：脚本能操作 DOM，但**看不到页面 JS 全局**（框架实例、页面变量），不要写依赖它们的代码；
6. `allFrames` 默认 `true`，脚本可能在同页多个 frame 各跑一次，初始化逻辑要幂等；
7. 能力清单（一期）：`DL.info` / `DL.style` / `DL.log` / `DL.store.{get,set,delete,keys,clear}` / `DL.fetch` / `DL.notify` / `DL.download` / `DL.clipboard.write` / `DL.tabs.open`；`store.watch` 与 `menu` 为二期（调用抛 `NOT_AVAILABLE`，不要用）；
8. 生成的脚本**不会自动生效**——落盘为未启用状态，由用户确认后启用；不要在脚本里假设「已经跑起来了」。
