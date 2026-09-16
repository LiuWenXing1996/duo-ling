# AI 生成用户脚本 · 现状与用法

本文描述当前 AI 生成用户脚本链路的实现：三容器职责与数据流、模块归属、写入契约、页面上下文与 `matches`、生成结果行为、执行宿主与脚本规范约束。设计取舍与已被否决的方案见 [AI 生成用户脚本一期收编](proposals/done/ai-userscript-phase1-archive.md)。

## 三容器职责与数据流

```
┌─ 侧边栏 sidepanel.html ────────────────────────────────┐
│  指令入口 + 观察者（可关闭，关了任务照跑）                  │
│  · 下发：需求 + 当前标签 URL/标题 +（可选）用户点选元素      │
│  · 订阅：任务事件流 → 渲染进度、生成卡片                    │
│  · 重开时按 seq 重连、接上进行中的任务                      │
└───────────────────┬───────────────────────────────────┘
                    │ chrome.runtime 消息：指令 / 订阅 / 重连
                    ▼
┌─ offscreen document offscreen.html ───────────────────┐
│  Agent loop 常驻宿主（loop 与构建同址）                    │
│  · streamText + tools + stopWhen + maxSteps            │
│  │   ├─ script_spec   拉规范全文（DL API + 约束 + 禁止项） │
│  │   ├─ script_read   读现有脚本源码（改脚本时用）         │
│  │   └─ script_apply  写内存文件树 → esbuild 构建 → 诊断  │
│  · esbuild：默认 worker 模式可用，wasm 常驻               │
│  · 任务事件缓冲（供侧边栏重连 replay）                     │
│  · 项目数据 / 会话历史 / 任务状态的唯一写入方               │
│  缺口：只有 chrome.runtime → 注册与 chrome.storage 经消息回 SW │
└───────────────────┬───────────────────────────────────┘
                    │ chrome.runtime 消息：能力调用
                    ▼
┌─ background SW ──────────────────────────────────────┐
│  能力运行时 / 注册方                                     │
│  · chrome.userScripts：注册 / 注销 / configureWorld      │
│  · chrome.storage：DL.store 值、错误日志、模型配置         │
│  · chrome.notifications：面板关闭期间的进度出口            │
│  · offscreen 容器管理（ensure / close）                  │
└──────────────────────────────────────────────────────┘
```

数据流（生成一次脚本）：需求 + 页面上下文 → offscreen 的 loop 反复 `script_apply`（构建自收敛）→ 构建通过 → 经 `userscript:createProject(enabled: false)` 落盘（写归 offscreen 单写方，note = AI summary）→ 事件流回推侧边栏 → 卡片：尚未启用 · 生效范围 · 会做什么 ·「启用并生效」/「进编辑器」/「删除」→ 用户点启用（`userscript:toggle`，零构建等待）→ SW 注册 → 命中页面注入 →（二期）运行期异常进 `us:errors` 供 AI 自修。

### 谁写什么

同一份数据只有一个写入方，防双写是设计红线。

| 数据 | 唯一写入方 | 说明 |
| --- | --- | --- |
| 项目数据（源码 / 配置 / 构建产物 / `enabled`，IndexedDB 库 `duoling-state`） | offscreen | 写状态与 git 提交在同一函数内完成；SW 与扩展页只读（`project-store`） |
| 脚本 git 历史与草稿（`lightning-fs` 库 `duoling`） | offscreen | lightning-fs 有内存索引层，双实例会互相看不见写入 → 只允许 offscreen 持有实例 |
| 会话历史（IndexedDB 库 `duoling-chat`） | offscreen（整条对话链路） | 同源共享：侧边栏只读 + 订阅，不写 |
| 任务运行时状态（进行中标记、事件缓冲） | offscreen | 侧边栏重开时读它、订阅它 |
| 脚本注册（`chrome.userScripts`） | SW | offscreen 无此 API |
| `DL.store` 值（`us:gm:*`）与错误日志（`us:errors`） | SW 直写 `chrome.storage.local` | 由用户脚本触发、频率不可预期、不参与「脚本是什么」的真相判定 |
| 模型配置 | SW（读侧） | offscreen 拿不到 `chrome.storage`，经消息取一次 |
| 面板关闭期间的进度通知 | SW | `chrome.notifications`（`notifications` 权限已在）；offscreen 无此 API |

分工的边界来自浏览器：IndexedDB 同源共享，offscreen 直连即可读写；`chrome.userScripts` 与 `chrome.storage` 只有 SW 拿得到。

### 消息路由

三容器之间的消息都走 `chrome.runtime`。SW 只应答白名单前缀（`userscript:` / `model:` / `offscreen:` / `sw:`）；`ai:`（git 历史）、`state:`（项目状态库写侧）、`conv:`（会话写侧）、`chat:`（对话链路）都由 offscreen 应答，SW 对这些前缀静默让路（`return false` 放行）——offscreen 与 SW 同时在监听 runtime 消息，而 `sendResponse` 对一条消息只有一次机会，SW 若不登记前缀就会抢答、把 offscreen 的响应挤掉。新增命令若忘了登记前缀，该命令会静默无响应（而不是报「未知消息类型」）。

### 机制·配置通道

offscreen 拿不到 `chrome.storage`，模型配置只能在启动时经 `model:getActiveProfile` 从 SW 取一次并缓存；配置变更由 SW 转发通知（`storage.onChanged` → `offscreen:configChanged`）后回拉。apiKey 会随这条消息进入 offscreen 内存——这是同扩展内上下文之间的传递（offscreen 与 SW 信任级别等同），不是新增对外暴露面；边界要求是「取一次、缓存、不写日志、不落盘」。

### 机制·事件缓冲与重连

`ChatTransport` 的 `reconnectToStream()` 在 offscreen 下有真实现。offscreen 为每个会话的进行中任务维护一份 `UIMessageChunk` 环形缓冲，每条事件带自增 `seq`（每轮任务从 1 重计）；侧边栏（观察者）按 `seq` 去重，重连（`chat:resume`）时**从头全量回放**——观察方本地视图可能刚从会话历史重建，按消费点续传会缺 `start` / `reasoning-start` 这类配对块。去重由 seq 基线负责（每轮重计，`chat:start` 与回放前清零）。

缓冲只服务进行中任务：任务收尾（正常 / 中止 / 异常）即丢弃（`dropBuffer`）——收尾后结果已在会话历史，保留缓冲只会让重开面板 replay 出重复消息。单会话上限 5 万条（长回复按约 1 delta/token 计，最坏 token 量曾冲穿 4000 条上限）；被截断时 resume 按「缓冲不完整」处理（返回 idle，UI 回退到会话历史）。缓冲**不用于落盘还原**：落盘走泵流时自收的完整 chunk 序列。推送通道是 `chrome.runtime.sendMessage`（offscreen → 侧边栏 + SW），面板未开时报「无人接收」，尽力而为、不阻断任务。

### 机制·任务可恢复

offscreen 也会因关窗口 / 崩溃 / 扩展重载 / 极端内存压力而消失，故留兜底。粒度是：每步把文件树快照进 IndexedDB 任务记录（库 `duoling-chat-tasks`，记录形如 `{ taskId, step, files, status, heartbeat }`），**覆盖写、只留最新一份**——历史由对话记录里的 tool parts 承载，不双份存；git 快照仍只在收尾做一次（它是全链路唯一非幂等的动作）；心跳由宿主每 5 秒刷新。

侧边栏对 `status = running` 的孤儿记录做判定：记录说 running 而宿主内存表没有该任务 = 宿主换代，必是孤儿（无需等心跳过期），另加 5 秒小保护窗盖住「`chat:start` 落盘 → 注册内存表」的竞态；判到孤儿就提示「上次生成中断在第 N 步，继续 / 丢弃」——有文件快照，「继续」才有东西可继续。任务正常收尾 / 用户中止时记录即删除，孤儿判定只认 `running`。

这份快照只覆盖「宿主被杀」这一种（`onFinish` 没跑到 → 这一轮的 parts 全丢）；loop 正常失败（`maxSteps` 耗尽）走得到 `onFinish`，产物已在对话历史里，不靠它。

### 编排约束

- 整条对话链路只此一条：全仓一个 `useChat` 实例、一个 `ExtensionChatTransport`、一处 `streamText` 调用；`streamText` 接 `tools` + `stopWhen`，不按任务类型分流。
- `maxSteps` 上限 8（沿用桌面版 agent-orchestrator 的取值，实测后调）。
- 同一会话同时只允许一条流，不并发。
- 连续构建失败上限 6：达到即让模型停手、把诊断交给用户；已达阈值仍再次 `apply` 时硬中断整个任务（`onFatal`）。

## 模块归属规则

`src/lib/userscripts/store.ts`（`DL.store` 值与 `us:errors`，SW 直写）、`src/lib/model-store.ts`、`src/lib/userscripts/engine.ts` —— 只允许被 SW 代码 import。

项目数据走 `state-db.ts` / `project-store.ts`（读）与 `project-write.ts`（写，只归 offscreen）；`lightning-fs` 实例（`us-fs.ts`）只许 offscreen 持有。

offscreen 侧只能 import：`builder.ts`（纯 esbuild，无 chrome API）、`extension-chat-transport.ts`、`ai` SDK、`state-db.ts` / `project-write.ts` / `project-store.ts`、`conversation-store.ts`，以及 `offscreen-bridge.ts`（把「读模型配置」等封装成 `chrome.runtime.sendMessage` 调用）。

这条规则的价值：它把「能不能在 offscreen 里跑」变成编译器可查的问题——import 了只有 SW 能跑的模块就会在运行时报 `chrome.storage is undefined`，而不是等到某个冷门分支才暴露。

## 写入契约

- 脚本用**整文件写**，不用 patch：文件小、多文件之间要一致、改完必须整体重构建，patch 产生的中间态没有意义。
- **`script_apply` 把「写」和「验证」合并成一步**：入参 `{ target: uuid | null, summary, config, files, entry }`，返回 `{ ok: true }` 或 `{ ok: false, errors: [{ file, line, column, text }] }`。拆成「写」「构建」两个工具的话，AI 会在写完后以为已经成功。
- **`script_apply` 只写 offscreen 的内存文件树并构建，不落盘**：构建通过后由编排层经 `userscript:createProject` 落盘（写归 offscreen 单写方）+ git 快照（note = AI summary），**不由 AI 显式调用保存**，避免「AI 忘了存」。
- Agent 工具三件套：`script_spec`（拉规范全文）/ `script_read`（读当前任务内存文件树，或带 uuid 读已保存项目）/ `script_apply`（写内存 + 构建 + 返回诊断）。

## 页面上下文与 `matches`

### 页面上下文档位

只发当前页 URL / 标题（档 0，由侧边栏采集后随指令发给 offscreen）与用户主动点选的那一块（档 2，元素拾取器），**不自动抓整页 DOM**。档 1（扩展页直接 `fetch` 目标 URL）只作零成本增强（对客户端渲染的 SPA 基本无效）；档 3（自动 DOM 摘要探针）后置。

### `matches`：权限而非配置

浏览器不给脚本侧白名单机制（`window.DL` 全量可用），所以只能做「可见 + 可撤回」：

1. AI 提议 `matches`，**默认收窄到当前标签的 host**（`*://<host>/*`）；`*://*/*` 只在用户明说「所有网站」时用，并在卡片上高亮。
2. 卡片展示**生效范围 + 脚本会做什么**——后者由静态扫描 bundle 里的 `DL.` 用法得出（用到 `fetch` = 可跨域请求、`store` = 读写私有存储、`notify` / `download` / `tabs.open` 各自对应）。展示级软审查，成本极低。
3. 兜底靠 git 一键回滚（见「生成结果行为」）。

## 生成结果行为

- **落盘即未启用**：`userscript:createProject` 收 `{ name, config, files, entry, bundle, enabled: false }` → 写状态库 + git 快照（note = AI summary），**不调用 `registerScript`**。于是「生成」与「生效」彻底解耦，AI 的产物默认**零影响**。
- **启用复用现成能力**：`userscript:toggle(uuid, true)`。bundle 已随项目落盘，启用是纯注册动作，**无构建等待**。
- **卡片讲清三件事**：①「尚未启用」；②生效范围（`matches` 原文）；③「脚本会做什么」（静态扫描）。三个出口：「启用并生效」/「进编辑器看一眼」/「删除」。
- **撤销**：回滚走管理页 git 历史（`restoreToCommit`，整树物化 + 新提交），卡片不设回滚按钮，也不做 reset——回滚能力已在管理页，缺的只是卡片入口。
- **代价（接受）**：用户可能忘了启用，管理页里堆一批关着的脚本。缓解：卡片主按钮就是「启用」。
- **额外收益**：未启用 = 未注册 = 不注入，用户能在启用前读一遍源码——比「自动生效 + 事后回滚」稳得多。

**失败产物不留「草稿」，它本来就在对话记录里。** loop 期间 AI 生成的是普通的 `ScriptProject` 文件树（入口 `.ts` / 被 import 的模块 / 构建产物 `bundle`），与用户手写的脚本同一种结构：loop 期间只在 offscreen 的内存文件树里，收敛成功才一次性落盘（`enabled: false`）。失败那一份不必另存——`Message.parts` 存的是完整 `UIMessage.parts`（reasoning / text / tool），回复完成时（`onFinish`）整条 assistant 消息连同 parts 落盘；`script_apply` 的入参（完整文件树）与返回（构建诊断）本就随对话保存，用户在对话里能看到 AI 试过哪些文件、卡在什么错误上。要「接着改」就在同一条对话里继续说，`useChat` 会把整条 messages（含工具调用历史）带回模型。

## 执行宿主

offscreen document 的平台约束：

- **版本与权限**：Chrome 109+（MV3）；manifest 声明 `"offscreen"`。
- **API 面**：`createDocument({ reasons, url, justification })` / `closeDocument()`；`chrome.runtime` 是它唯一可用的扩展 API，消息必须走 runtime 那套成员。存在性检查用 `chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [...] })`（Chrome 116+；项目 `minimum_chrome_version: 133` 够用），比老的 `clients.matchAll()` 直接。
- **`reason` 是必填声明，而且就是寿命开关**：取 `BLOBS`（拿 `URL.createObjectURL`）+ `WORKERS`（派生 worker 跑构建）。这两个 reason 都不带自动关闭（只有 `AUDIO_PLAYBACK` 带 30 秒无声自关），故容器可长活。
- **另三条约束**：offscreen 的 URL 必须是打包进扩展的静态 HTML 文件（注意 WXT 的 `x.html` / `x.ts` 同名冲突规则）；不能聚焦；`opener` 恒为 `null`。
- **每扩展同时只能有一份**（隐身与普通模式各一份）。
- **调试路径**：offscreen 的 `console` 落在 SW 的 inspector（`chrome://extensions` → Service Worker），不再是侧边栏 DevTools。
- **容器管理**：生命周期集中在 `src/lib/offscreen.ts` 一个模块（`createDocument` 调用不散落别处）。`ensureOffscreen()` 用 `getContexts` 查存在性 + 在途 promise 防并发创建出多份；**触发点放在「收到生成请求」的入口**（Chrome 不会自动启动 offscreen，必须显式 `createDocument`，而安装 / 启动那一刻 SW 未必有机会跑），另在 SW 冷启动 / `onInstalled` / `onStartup` 都挂，生成入口与文件客户端再兜底；`ensure` 幂等。采用**常驻策略**：不设自关退出条件（空闲 / 任务结束 / 面板关闭均不自关），仅在调试命令 `offscreen:close` 时主动关；极端内存压力下被关则由请求方 `ensure` 兜底重建。

构建与对话 loop 需要同一组宿主条件：能派生 Worker（`URL.createObjectURL`）且宿主寿命不随 UI 页面结束。Service Worker 两条都不满足——它拿不到 `URL.createObjectURL`（只能 `initialize({ worker: false })`，构建压在其单线程上），且空闲约 30 秒即被回收，而 loop 天然存在停顿点（等用户看卡片、两次构建之间），恰会在最需要存活时被杀；故 esbuild 与 loop 同址，都在 offscreen document。

被否宿主（SW / content script / Dedicated Worker / sandbox iframe）的逐项核查与代价分类见[一期收编提案](proposals/done/ai-userscript-phase1-archive.md)。

## script_spec 约束清单

1. 没有 `==UserScript==` metadata、没有 `@grant` / `@require` / `unsafeWindow`——配置走 `config` 对象（`matches` / `excludeMatches` / `includeGlobs` / `excludeGlobs` / `allFrames` / `runAt`）。
2. 入口文件**不得有顶层 `export`**（iife 格式约束）。
3. 依赖只能 `import 'https://…'`（CDN 直链，会被逐条 fetch 并持久化进项目），**裸包名 `from 'lodash'` 会报错**。
4. `DL` **全 async**——照抄油猴的 `if (GM_getValue('x'))` 写法会恒真；存储值必须是 Json。
5. `DL.page.*` **尚未可用**：脚本能操作 DOM，但**看不到页面 JS 全局**（框架实例、页面变量），不要写依赖它们的代码。
6. `allFrames` 默认 `true`，脚本可能在同页多个 frame 各跑一次，初始化逻辑要幂等。
7. 能力清单（一期）：`DL.info` / `DL.style` / `DL.log` / `DL.store.{get,set,delete,keys,clear}` / `DL.fetch` / `DL.notify` / `DL.download` / `DL.clipboard.write` / `DL.tabs.open`；`store.watch` 与 `menu` 为二期（调用抛 `NOT_AVAILABLE`，不要用）。
8. 生成的脚本**不会自动生效**——落盘为未启用状态，由用户确认后启用；不要在脚本里假设「已经跑起来了」。
