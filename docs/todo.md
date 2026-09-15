# 待办清单

> 记录后续要做的功能事项，先在这里收敛方案，再动手实现。
> 2026-09-14 清理：已实现条目压缩为索引（详情见各自提交与 git 历史）。
> 2026-09-15 清理：删除三条「⚠️ 已废弃」条目（工具页风格统一 / 沙箱化 / UserTool 改造）——依赖的 UserTool 工具链路已在 68b70128 移除，场景无载体；原文 git 历史可查。
> 2026-09-15 清理：「会话与工具解耦」条目删除——工具链路已在 68b70128 移除（EditIntent / applyIntents / tools-data / per-tool 锁的挂载实体全无，方案文档 conversation-tool-decouple.md 已删），未落地缺口随之失去载体；已落地部分（会话一等公民、独立存储）转入下方已完成索引。

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
4. **offscreen 侧桥接层**（新文件）：把「读配置 / createProject / toggle / 读脚本」封装为 runtime 消息；守住**模块归属规则**（`userscripts/store.ts`、`model-store.ts`、`engine.ts` 等**只许 SW import**；项目数据写只归 offscreen——lightning-fs 有内存索引层，双实例会互相看不见写入）。

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

**状态**：方案已拍板（含定位 B 与「整条链路搬」），**无待拍板项**。前置 **A 组（容器与通道，1–4）已落地**：offscreen entrypoint + `"offscreen"` 权限、`ensureOffscreenReady`（`src/lib/offscreen.ts`）、`model:getActiveProfile` + 配置转发（`background.ts`）、`offscreen-bridge.ts`；**B 组（编排与构建，5–9）待开工**。

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

## 测试体系搭建（方案已定稿，待开工）

**背景**：测试体系空缺（原 Vitest/Playwright 配置随 Electron 归档），本工程目前只有 `typecheck` 一道静态关卡。2026-09-15 与老大收敛定稿：五层分层——纯逻辑单测 + 协议一致性（首批）、构建冒烟（后置至 AI 生成 B 组前）、组件测试（按需）、E2E（Playwright 捆绑 Chromium 无头加载扩展）。

**详细文档**：见 [testing-plan.md](./testing-plan.md)（分层方案、E2E 关键结论与测试面映射、基础设施、顺序）。本条目只留状态索引，以文档为准。

**状态**：方案已过稿（2026-09-15）。层 3 构建冒烟已完成（2026-09-15，`builder.test.ts` 3 例全绿，wasm 加载结论见 testing-plan「层 3 实施结论」）；层 1/2/E2E 待开工。

---

## 已完成（索引）

> 以下方案已实现（部分在 Electron 时期完成、随迁移平移到扩展），方案细节与实现记录见对应提交与 git 历史。

| 方案 | 结论 | 提交 |
| --- | --- | --- |
| 会话一等公民：与工具解耦 | `Conversation` 独立存储、零工具纯聊天可用（原「会话与工具解耦」P1；P2/P3 缺口随工具链路移除 68b70128 失去载体，条目 2026-09-15 删除） | — |
| 工具版本管理：版本预览 + 回滚一体 | 整树物化预览 + 回滚产生「回滚到 `<shortOid>`」新 commit，不做 reset | — |
| 工具能力声明：meta.capabilities + 运行时拦截 | meta 为权威来源，运行时按白名单拒绝未声明能力 | `d0634d3` |
| 生成器审批模式：默认 auto | 移除 manual/auto 审批全套链路，变更清单自动落盘 | `238dd3b` |
| 工具数据管理：独立数据区 + 设置概览 + 详情页 | `tools-data/<id>/` + `tool.data.*` 四原子能力 + 孤儿清理 | `eae135e` |
| 工具图标：meta.icon | 字符 / `lucide:<名>` 两格式，允许列表按需加载，4 处展示位统一组件 | — |
| 工具快捷方式：置顶/收藏 | 「常用」分区 + 侧边条置顶区，用户偏好不入 meta.json | — |
| 工具档案：AI 主笔的每工具说明书 | `archive.md` 三段式，随 git 版本化，面板只读渲染 | `9ddc871` |
