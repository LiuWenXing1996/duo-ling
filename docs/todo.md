# 待办清单

> 记录后续要做的功能事项，先在这里收敛方案，再动手实现。
> 2026-09-14 清理：已实现条目压缩为索引（详情见各自提交与 git 历史）；部分条目为 Electron 时期撰写，落地前需按扩展架构重写（已标 ⚠️）。

## 会话与工具解耦（实施中 · P1 基本落地）

**背景**：当前会话/对话强绑定工具，无法跨工具、无法在一次对话中修改多个工具。已与用户确认将「会话」提升为一等公民，与工具解耦；同一会话可改任意工具、可一次改多个，并支持多个 AI 会话并行思考 + 对同一工具串行写入。

**方案要点（已确认）**：
- **绑定下沉到 EditIntent**：`Conversation → Message → EditIntent { toolId, summary, actions[], status }`，会话从不拥有工具。`Conversation { id, title, createdAt, lastMessageAt }`、`Message { id, conversationId, role, content, createdAt }`、`Tool`（磁盘目录）独立于会话。
- **多工具 manifest**：AI 输出 `{ intents: [{ toolId, summary, actions[] }] }`，天然支持一次改多个工具。
- **无感确认 = 事后可逆而非事前阻塞**：靠 git 版本化 + 回滚兜底；每个 EditIntent 一个 commit，撤销 = revert 到父 OID。
- **单写者全局 per-tool 锁**：锁带持有者标识 `{ toolId, holder: { conversationId, messageId, intentId }, acquiredAt }`；查锁只读畅通、拿锁排他串行。
- **执行管线（Plan B）**：待办清单只展示意图（intents），执行时逐工具持锁重读当前内容 + 重生成 + 落盘，避免覆盖用户手动修改、识别「已无需改动」；每改一个工具锁一个工具，支持锁前提示。
- **多 AI 并发（B 方案）**：不做并发上限调度器（3-4 个 AI 是用户自然上限）。规划时 AI 先查锁，被锁则跳过+提示用户；执行时被锁则视为执行失败并告知原因 + 重试出口。
- **中断**：执行期间禁发新消息 + 停止按钮；优雅中断 = 收尾当前项 → 释放锁 → 取消剩余 → 恢复输入。
- **数据区**：`tools-data/<id>/`，单 key 原子、AI 不写数据区、不锁数据区（用 schema 版本 + 读容错兜底语义漂移）。
- **工具页重写编排**：停旧页 → 写文件 → 加载新页，用「过渡占位」而非遮罩/白屏；批量写 + 单次 reload。

**详细文档**：见 [conversation-tool-decouple.md](./conversation-tool-decouple.md)。

**状态**：实施中（部分已落地，依据 2026-09-14 代码核查）：
- **P1 解耦与契约 · 基本落地**：`EditIntent` 模型（含 `error` / `createdAt`）、多工具 manifest `intents[]`、`Conversation` 独立存储与会话解耦（零工具纯聊天 / 一次改多工具）、会话一等公民均已实现。只读锁查询以 capability 形式可用（无独立 IPC 通道，走通用能力调用）。
- **P2 执行管线 · 部分落地**：每个 `EditIntent` 一个 commit、移除弹窗确认（自动落盘留痕）已实现；但「每条 intent 独立撤销到父 OID」未打通（`EditIntent` 不存 commit oid）、待办清单（多条 intent + 每项可撤销）、锁前提示、持锁后重读重生成、优雅中断均未实现，且执行期不可打断（streaming 只覆盖 AI 生成，不覆盖落盘执行）。
- **P3 并发协调 · 未实现**：per-tool 全局锁（带 holder + acquiredAt）纯只读占位，无 acquire / release，AI 落盘 / 回滚 / meta 编辑 / 直接文件编辑等写路径均未加锁；查-执行两步 + 失败重试未实现。
- **数据区**：`tools-data`（key 白名单 / manifest / AI 不写数据区）已实现。
- **工具页重写编排**：仅基础 `reload()`，无「停旧页 → 写文件 → 加载新页」、无过渡占位、非批量写 + 单次 reload。

**关键缺口（按影响排序）**：① 写路径无任何锁（P3，安全边界）；② `EditIntent` 与 git commit 未打通（无法一键撤销到父 OID）；③ 执行期不可打断。

---

## 工具页风格统一：与主应用 UI 一致（⚠️ 已废弃）

> ⚠️ **已废弃**：工具链路（UserTool 生成/管理：`tool:*` IPC、`tools-data`、`meta.capabilities`、`archive.md`）已在 68b70128 移除，`src` 内已无 UserTool 工具页代码、`tool-spec.md` 已删。本条描述的「AI 生成工具页风格」场景已无载体，故废弃。
> 注：仍存在的 `kind:'tool'` 仅指 chat agent 的**函数调用**（LLM 在对话里调函数），与 UserTool 工具页无关，不在本条范围内。
>
> ⚠️ 本条按 Electron 时期撰写，落地前需按扩展架构（sandbox iframe + srcdoc 承载工具页）重写背景描述；档位决策本身仍有效。

**背景**：工具页由 AI 直接写原生 HTML（纯 CSS、无 Tailwind），导致工具页 UI 与主应用（shadcn-vue 风格）严重不搭。要让 AI 产出与主应用一致的界面。

**已查实的关键事实**：
- shadcn-vue 是**源码复制式**（`npx shadcn-vue add` 拷 `.vue` 源码进 `components/ui/`），**官方不发 dist 包**；外观那层是源码 + Tailwind 类 + design tokens。
- 有官方 dist 的是**底层库**：reka-ui（无头组件，ESM-only、依赖树重，体积几十 KB 起）、@lucide/vue（有 UMD 全局产）。
- reka-ui 是**无头**组件，**不带样式**，本身无法提供「shadcn 外观」。

**已讨论的方案档位（成本递增）**：
- **档位A · 设计令牌 + 类名（倾向）**：与主应用共用一份 design tokens + 常用组件样式的 CSS 产物（放 vendor），AI 用原生标签 + 类名即得主应用风格。零依赖、零耦合、随主应用进化；代价是软约束、类名体系需维护。
- **档位C · 折中基元**：只把 Button/Card/Input/Select/Tabs 等基元打进 vendor 当真组件，其余 tokens+类名兜底。需 Vue 运行时 + reka-ui 依赖。
- **档位B · 整套组件库**：最完整但最重，性价比最低。

**核心结论 / 决策点**：
- 无论哪条路，「外观」都要靠自己定义 tokens/类名——reka-ui 只给无障碍交互，不解决风格问题。
- 性价比：**纯 A** 最优；**A 外观 + lucide 官方 UMD 图标 + 按需 reka-ui** 次之；默认给每个工具页装全套 reka-ui 亏。
- **待确认**：工具页对「复杂交互」（下拉框/弹层/标签页等有状态交互）的真实需求。若工具多为表单/展示类，档位 A 就够；仅当多数工具需要这类交互时才值得引入 reka-ui。

**状态**：尚未决定，倾向档位 A。待确认工具页复杂交互需求后再定，不予落地。

---

## 工具页严格沙箱化：opaque origin + 双层 iframe（⚠️ 已废弃）

> ⚠️ **已废弃**：同 UserTool 工具页，依赖已被移除的工具链路，场景已不存在。若未来 reintroduce 工具页再重新评估。
>
> ⚠️ 原条目「webview 显式沙箱化」为 Electron `<webview sandbox>` 形态，已按扩展架构改写为 iframe 沙箱议题（2026-09-14 清理时改写）。

**背景**：AI 生成的不可信工具页经 sandbox iframe + srcdoc 承载，但**现状仍是同源 sandbox**（见 AGENTS.md「CSP / 沙箱」行），与「工具页只能经 `window.cap` 桥调用能力」的消息协议约束配合，构成当前防线；严格沙箱化（opaque origin + 双层 iframe 分层）是补上进程级隔离的待办。

**方案要点（待确认，按扩展形态重写后待评审）**：
- 不可信工具页放**不透明 origin**（opaque origin）的 sandbox iframe，杜绝同源读写主应用存储。
- **双层 iframe 分层**：外层受信壳（持有 `window.cap` 桥）+ 内层不可信内容（srcdoc 注入），中间以 `postMessage` 单通道转发，桥代码不暴露给不可信层。
- 预览（版本预览）链路同步适用同一沙箱策略。
- 落地时验证：工具页加载 / 心跳 / 能力调用不受影响。

**关联**：与「UserTool 文件结构与运行环境改造」同一批运行环境加固。

**状态**：待办。方向已确认（AGENTS.md 已登记），详细方案需按扩展架构重写后评审。

---

## UserTool 文件结构与运行环境改造（⚠️ 已废弃）

> ⚠️ **已废弃**：UserTool 工具链路已在 68b70128 移除，`tool-spec.md` 已删，本条目标态不复存在。

**背景**：`docs/tool-spec.md` 为「工具规范」权威契约，只描述目标形态、**不谈进度**；以下为落地 `tool-spec.md` 所需实现的改造项，统一登记于此（按 tool-spec 章节归组）。

> ⚠️ 子项完成状态以 Electron 时期记录为准，扩展侧现状（能力声明 / CSP / 档案链路已平移）需逐项核对后再动工。

**方案要点（目标态见 tool-spec.md）**：
1. **CSP 权威层（tool-spec §6.2/§6.3）**：协议层权威下发 CSP（不依赖生成端 AI 写 meta）——桌面版已落地；脚手架 `<meta>` CSP 已移除（避免双写交集不一致）。
2. **`.css` MIME（tool-spec §3.3/§6.2）**：协议层扩展名→Content-Type 映射补充 `.css` → `text/css`。
3. **文件白名单放开 + 版本管理动态遍历（tool-spec §3.2/§5.2）**：编辑白名单、生成器侧文件白名单从「两文件」放开为「两个固定文件 + 三个目录 + 工具档案」；git 提交/回滚遍历动态化（排除 `.git/`），防目录穿越。
4. **脚手架改造为目录骨架（tool-spec §5.1 创建）**：新建 UserTool 从「自包含单文件」改为「入口页 + 脚本/样式目录 + 空静态资源目录」。
5. **工具档案 `archive.md` 落地（tool-spec §8）**：桌面版已实现并平移（档案随 git 版本化，AI 主笔）。
6. **`local.file.choose`（tool-spec §4.2）**：系统文件选择框能力，建立「用户授权选文件」边界。
7. **CSP violation 反馈闭环（tool-spec §6.3）**：把运行时 CSP violation 反馈给生成端 AI 自检（增量可选）。

**关联**：与「工具页严格沙箱化」同一批运行环境加固；落地顺序可按依赖排（先 2/3，再 4，6/7 独立）。

---

## 用户脚本编辑器：CodeMirror 6 高亮（后置增强，待动工）

**背景**：v2 用户脚本（docs/userscript-v2-plan.md）Phase 0–3 已落地，编辑器一期为裸 textarea（方案定稿：CodeMirror 6 作为独立增强后置）。2026-09-14 老大确认「等后面再说」，登记备查。

**方案要点**：
1. 依赖：`codemirror` + `@codemirror/lang-javascript`（js/ts/jsx/tsx 一包全覆盖）+ 深浅色主题（`@codemirror/theme-one-dark` 或 CSS 变量自适配，主题跟随系统）。**新增依赖，动工前与老大确认**。
2. 改动面：仅编辑抽屉 textarea → CodeMirror 组件，v-model 接 `editFiles[activeFile]`；构建报错、保存流程、文件树零改动。
3. 可选增强：构建失败行内错误标记（esbuild 的 file:line 映射到 CodeMirror lint/装饰器）。

---

## AI 生成用户脚本（已拍板，待实施）

**背景**：用户脚本 v2 新形态（多文件项目 + DL 能力 API + esbuild 构建）四阶段已落地，下一步的自然延伸是「让 AI 写脚本」——在侧边栏说需求，AI 产出 `ScriptProject`（文件树 + 配置）、构建、落盘。

**与「AI 生成工具」的关键差异**：工具的产物是自包含页面、AI 掌握全部上下文、无构建环节；脚本注入第三方页面、AI 只知 URL、**必须过 esbuild 构建**。由此得出主结论：脚本生成走 **Agent 工具链**而非单轮意图契约——esbuild 是廉价确定性验证器，把「写文件 + 构建」合成一个工具后，AI 能在一次会话内「写 → 编译 → 读错误 → 再写」自我收敛，这是单轮契约做不到的。

**已拍板（2026-09-14）**：
1. **编排形态**：Agent 工具链（`script_spec` / `script_read` / `script_apply`），不照搬工具的单轮意图契约；
2. **生成入口**：**侧边栏**（只做「下指令 + 看进度」的观察者；执行与构建都在 offscreen，§4.1 / §4.8）；现成替代 `esbuild-standalone` 已核查**不采用**（它本身不带 esbuild、靠 CDN `importScripts` 拉，扩展 CSP 禁止；详见方案 §3.2）；
3. **生效方式**：**先落盘不启用 + 一键启用**（落盘 `enabled: false` → 卡片给「启用并生效」按钮 → 复用现成的 `userscript:toggle`，零构建等待）；
4. **工具侧**：本次不动，脚本链路与工具链路解耦（不共用 `parseGeneratedIntents`、不经 `applyIntents`）；
5. **执行宿主 = 定位 B「下完单就走」**（老大 2026-09-14 拍板）：发起生成后**关掉侧边栏，任务照跑完、回来收结果** → **offscreen document 为一期必需，整条对话链路 + 构建一起搬进去**（方案 §4.8）。**只有一条对话链路**（老大同日纠正：全仓只有一个 `useChat` 实例、一处 `streamText` 调用，二者差别仅 `tools` 入参），而一次请求跑多久由模型运行时决定、用户不可预知 → **不按任务类型分流**（方案 §4.1）。技术上 B 无替代方案：搬 SW 有单次调用 5 分钟硬顶 + 空闲 30s 回收，搬 content script 随网页死，Dedicated Worker 随页面死。
6. **页面上下文隐私边界**：**档 0（当前页 URL / 标题）+ 档 2（元素拾取器）**；档 1 可选、档 3 后置。即**只发「当前页 URL / 标题」与「用户主动点选的那一块」**，不自动抓整页 DOM（方案 §4.2 / §6.1 #8）。
7. **新增 `"offscreen"` 权限**：**已批准**。定位 B 的硬前提；上架审查可见（方案 §6.1 #9）。

**为什么 B 的代价比预想小（本次核查）**：
- **SW 角色一字不改**：它的定位本来就是「能力运行时 + 唯一写入方」（`background.ts` 头注释），迁移只是**换个客户端调同一套 `userscript:*` 命令**；
- **存储双轨的分界线恰好在 offscreen 的能力边界上**：IndexedDB（会话历史 `duoling-chat`、lightning-fs 库 `duoling`）**同源共享、offscreen 直连可用**（`conversation-store.ts` 注释已明写同源共享是既有事实）；`chrome.storage.local`（55 处）读不到——但那半边今天**也已经全部经 SW**；
- **`chrome.userScripts` 本来就只在 SW 独占**（`background.ts` 导入 `engine.ts`）→ offscreen 拿不到，也无需搬。
- **反而更省**：offscreen 有 `URL.createObjectURL` → esbuild 可用**默认 worker 模式**（不必 `worker: false`）；不被回收 → wasm 常驻，14MB 只编译一次。**§3.1「构建宿主选谁」的纠结一并消失。**

**前置（9 条，按依赖顺序）**：

*A. 容器与通道*
1. **新增 `offscreen` entrypoint** + manifest 加 `"offscreen"` 权限（**老大 2026-09-14 已批准**）；`reason: ['BLOBS', 'WORKERS']`；
2. **`ensureOffscreen()`**（SW 侧：`chrome.runtime.getContexts` + 在途 promise 防竞态），挂在**生成请求入口**处——Chrome 不会自动启动 offscreen，安装时 SW 未必有机会跑；
3. **配置通道**：SW 新增 `model:getActiveProfile`（复用现成 `getActiveProfileState()`）+ `storage.onChanged` 转发给 offscreen（它收不到该事件）；
4. **offscreen 侧桥接层**（新文件）：把「读配置 / createProject / toggle / 读脚本」封装为 runtime 消息；守住**模块归属规则**（`userscripts/store.ts`、`model-store.ts`、`fs-store.ts`、`engine.ts` 等**只许 SW import**——lightning-fs 有内存索引层，双实例会互相看不见写入）。

*B. 编排与构建*
5. **整条对话链路与构建搬进 offscreen**（**不做任务类型分流**——只有一条链路，§4.1）：`streamText` + `tools` + `stopWhen` + `maxSteps` 上限；`builder.ts` 随 offscreen 入口 import（wasm 懒加载 + 首次构建 loading 态）；
6. **`reconnectToStream` 真实现 + 事件缓冲**：per-task 事件带 `eventId`，侧边栏按 `lastEventId` replay 后续订（B 的体验命门，现在是 `return null` 的桩）；
7. **`userscript:createProject`**（收 name/config/files/entry/bundle，**支持 `enabled: false`**；顺带把 `userscript:install` 收敛为它的单文件快捷调用）；
8. **Agent 工具三个**：`script_spec` / `script_read` / `script_apply`（在 offscreen 内构建，构建通过后由编排层经 SW 落盘）；
9. **生成卡片 + 可恢复状态**：卡片（未启用 + 生效范围 + 「会做什么」+ 启用 / 编辑器 / 回滚）；**每步把文件树快照进 IndexedDB 任务记录（覆盖写、只留一份）**（只为「宿主被杀」后的续跑）+ **收尾一次 git 快照**（全链路唯一非幂等动作）+ 孤儿判定提示「继续 / 丢弃」；**失败那轮的产物就地留在对话历史里，不做「草稿」落盘**（方案 §4.5）；面板关闭期间的进度走 `chrome.notifications`。

**可直接复用**：`builder.ts`（esbuild 管线，wasm 资产零新增）、`updateFiles`（全量落盘 + **仅在 enabled 时注册**，正好是「落盘不启用」要的语义 + 返回 CSP 警告）、`userscript:toggle`（一键启用零新增后端）、`us-git.ts`（`snapshotProject` **已支持 note → 提交信息**，正好回答 git 历史方案里待定的 commit message 格式；`restoreToCommit` 即回滚）、`us:errors`（二期运行期错误回喂）、**SW 现成的全部 `userscript:*` 命令面**（loop 换宿主后照旧调用）。

**无待老大拍板项**（2026-09-14 清空）：

1. ~~构建失败后的半成品怎么处置~~ → **已决：不做「草稿」**。老大追问「为什么需要草稿」后复核：失败产物的四个相关需求**各已有载体**——追溯 AI 试过什么 → 对话历史（`onFinish` 落盘含 tool 调用的完整 `parts`）；让 AI 接着改 → 在同一条对话里接着说；抗中断 → 每步任务快照；自己手改 → **成功路径收敛即自动落盘**（未启用，可进编辑器）。唯一残留窄缝（最后一次构建成功、但 `maxSteps` 提前收尾）**也不为它加按钮**：失败率量级未知，而入口一旦可点就会往管理页混入「AI 没做成的东西」；将来实测确有此需，补起来只是「一次命令调用 + 一个按钮」（`saveProject()` 本就是按 uuid 覆盖写的 upsert）。详见方案 §4.5 / §6.1 #10。

> 原必答 ①「页面上下文档位」与 ②「`"offscreen"` 权限」**老大 2026-09-14 已拍板**，见上方「已拍板」第 6 / 7 条。

**可代定（我按建议执行，老大否决即改）**：脚本档案 `notes`（加）/ 内置脚本（拾取器）放管理页「内置」分组 / `script_spec` 载荷形态（由 `userscript-api.md` + 方案 §8 拼一段注入文本）/ `maxSteps` 沿用桌面版 8 / 任务进行中用户再发消息则排队。

**详细文档**：见 [userscript-ai-generation.md](./userscript-ai-generation.md)（含 §3.1 esbuild 放 SW 的技术核查与宿主筛选表、§3.2 `esbuild-standalone` 外部对照、§4.8 定位 B 的三容器架构与「谁写什么」表、§8 `script_spec` 禁止事项清单）。

**状态**：方案已拍板（含定位 B 与「整条链路搬」），**无待拍板项**，代码未动，前置 9 条待开工。

---

## ~~用户脚本数据改由 offscreen 单写~~ → **已落地（2026-09-15）**

> **2026-09-15 更新：主体已实现**，实现记录见
> [userscript-single-writer.md §9](./userscript-single-writer.md)。
>
> - 项目数据（源码 / 配置 / 产物 / enabled）迁到独立 IndexedDB 库 **`duoling-state`**
>   （`state-db.ts`）；**写只归 offscreen**（`project-write.ts` + `state:*` 命令面），
>   写状态与 commit git 仓在同一个函数里完成，消除了「已保存但没 commit」的偏差缝隙；
> - SW **直读** IDB 做注册（`engine.listProjects` / `userscript:list` / `getProject`），不经容器；
>   写命令经 `writeViaOffscreen`（先 ensure 可应答、仅对「容器没接上」类错误重试一次）转发；
> - **`chrome.storage.local` 只剩** `DL.store` 值（`us:gm:*`）、错误日志（`us:errors`）与旧 GM 记录的清理；
> - 按老大指示**不做数据迁移**（无旧数据）；
> - 顺带删掉随折叠变死的 `ai:snapshot` / `ai:deleteRepo`，`offscreenBridge` 收窄到只剩配置通道。
>
> **未做的残留项**：写失败的**可重试 UI 提示**——目前写失败会把错误冒泡到 UI 错误条，
> 但没有「重试」按钮；等真出现保存失败再补，避免为没发生的失败设计交互。

**详细文档**：见 [userscript-single-writer.md](./userscript-single-writer.md)（背景、方案、边界判据、
代价复核、前置项、工作量、实现记录）。本条目只留「前置项 + 边界结论」的索引，以文档为准。

> 2026-09-14 评审 `docs/userscript-draft.md` 时，由「为什么还需要 chrome.storage」追问出来的议题。
> 老大要求先把前置项记下。**2026-09-15：三条前置项全部收口**——
> - **前置项 1 已落地**：`sendAi` 里「ensure + `setTimeout(80)` 猜监听器注册」改为
>   `offscreen:ensure` 内部轮询 `ai:ping`、**容器可应答才返回**（`waitForOffscreenReady` / `ensureOffscreenReady`，
>   `src/lib/offscreen.ts`）。判据是「能应答」而非「文档存在」，无状态、SW 重启后也不失真。
>   顺带：移除协议里已废弃、全仓无调用的 `userscript:history*` 三命令；SW 的 handlers 表类型
>   收窄为 `SwRequest`（由 `SW_KIND_PREFIXES` 推导），不再为死命令补桩。
>   **手测通过（2026-09-15，记录见 userscript-single-writer.md §5.3）**：`close` 后 `ensure`
>   冷启 **58.4ms / ready:true**，稳态 **0.7ms**；`close` 后不走命令直接打开编辑器的 git 历史，
>   提交列表正常、恢复版本成功。手测前务必 `chrome://extensions` 点刷新——首轮曾打到旧包，
>   而 `offscreen:ensure/close` 要到 `9ac8c7e`（2026-09-14 17:43）才引入。
> - 前置项 2（SW 冷启动期 IDB 可读）**通过**：浏览器冷启动、offscreen 尚未创建时，SW 已读到上一轮
>   offscreen 写进 IDB 的数据（`ms: 0`）。计划外发现：**offscreen 每次浏览器启动都是重建的**，
>   「SW 冷启动时没有 offscreen」是常态，正是读路径必须 IDB 直读的依据。
> - 前置项 3（清站点数据的存活差异）**结论：两者都清不掉**——`browsingData.remove` 对本扩展 origin
>   返回成功，但 IDB 与 `chrome.storage.local` 里的金丝雀都还在 → 抗清理能力一致，方案不受影响。
>   附带实测：IDB 配额 ≈ **10 GiB**，而 `chrome.storage.local` 默认 **5 MiB**（本仓未声明 `unlimitedStorage`）。

**详细文档**：见 [userscript-single-writer.md](./userscript-single-writer.md)（背景、方案、边界判据、
代价复核、前置项、工作量）。本条目只留「前置项 + 边界结论」的索引，以文档为准。

**背景**：`sendAi`（`ui-client.ts:42-58`）在 `ai:*` 命令失败后发 `offscreen:ensure` 唤起容器，
然后 `await new Promise(r => setTimeout(r, 80))`——注释自己写着「稍候其注册监听」，
**靠固定 sleep 猜 offscreen 的 onMessage 是否注册好了**，没有真正的就绪信号。

**为何现在无妨**：`ai:*` 目前只跑 git 历史侧车（历史列表 / 快照 / 恢复），低频且失败可重试，
猜错一次再试一次就是了。

**为何成了前置项**：若「用户脚本项目数据改由 offscreen 单写」落地，**每一次保存都要走这条路**
（写路径必经 offscreen），靠 80ms 猜时间不再可接受——猜短了写入失败，猜长了每次保存都白等。

**做法（已按此落地，但判据换了）**：原计划复用 `offscreen:ready` 握手（等通知 + 超时降级回重试）。
实际改成**把就绪判据定义成「容器能应答一条消息」**——新增 `ai:ping`，`offscreen:ensure` 内部
轮询到有应答才返回（`ensureOffscreenReady()`，`src/lib/offscreen.ts`）。理由：握手通知要维护
状态位，SW 重启后旧容器不会再通知一次、状态位会失真；而探测无状态，且测的正是在意的属性。

**关联议题（已决并落地）**：「用户脚本项目数据（源码 / 配置 / 产物 / enabled）是否改由 offscreen 单写、
SW 直读 IndexedDB 注册」→ **已做**（见本条目顶部）。讨论出的另两条待办状态：
- 写失败要有**可重试的 UI 提示** → **未做**（见顶部「未做的残留项」）；
- 边界划分：`DL.store` 值（`us:gm:<uuid>:<key>`）与错误日志 `us:errors` **是否也纳入单写方**。
  2026-09-14 结论：**按判据划出去，不纳入**——判据不是「频率高不高」，而是
  「写入方是否受我们控制」+「是否参与『脚本是什么』的真相判定」：
  - 项目数据（源码 / 配置 / 产物 / enabled）由**用户点保存**触发，低频、可预期、可重试，且参与真相判定 → 单写；
  - `DL.store` 由**注入页面的用户脚本**调 `set`，频率与时机完全不可控，且 `dl-bridge.ts:92-94`
    是 `await` 的（写入失败会冒泡成脚本可见的错误）→ 留在 SW 直写；
  - `us:errors` 由**脚本崩溃时**触发（爆发式，且恰恰是 offscreen 也可能不在的时刻），
    实现还是「读 50 条 → 改 → 写回 50 条」的整块读改写（`store.ts:210-215`，`MAX_ERRORS = 50`）→ 留在 SW 直写。
  两者都不参与「脚本是什么」的判定，划出去**不损害单写方的目标**（消灭源码/产物两份状态的偏差）。
  附带发现：`appendUserScriptError` 的读改写现在就会 lost update（崩溃风暴时并发写互相覆盖），
  与单写方无关，属独立缺陷，要修就先加串行化/批量合并。

---

## 已完成（索引）

> 以下方案已实现（部分在 Electron 时期完成、随迁移平移到扩展），方案细节与实现记录见对应提交与 git 历史。

| 方案 | 结论 | 提交 |
| --- | --- | --- |
| 工具版本管理：版本预览 + 回滚一体 | 整树物化预览 + 回滚产生「回滚到 `<shortOid>`」新 commit，不做 reset | — |
| 工具能力声明：meta.capabilities + 运行时拦截 | meta 为权威来源，运行时按白名单拒绝未声明能力 | `d0634d3` |
| 生成器审批模式：默认 auto | 移除 manual/auto 审批全套链路，变更清单自动落盘 | `238dd3b` |
| 工具数据管理：独立数据区 + 设置概览 + 详情页 | `tools-data/<id>/` + `tool.data.*` 四原子能力 + 孤儿清理 | `eae135e` |
| 工具图标：meta.icon | 字符 / `lucide:<名>` 两格式，允许列表按需加载，4 处展示位统一组件 | — |
| 工具快捷方式：置顶/收藏 | 「常用」分区 + 侧边条置顶区，用户偏好不入 meta.json | — |
| 工具档案：AI 主笔的每工具说明书 | `archive.md` 三段式，随 git 版本化，面板只读渲染 | `9ddc871` |
