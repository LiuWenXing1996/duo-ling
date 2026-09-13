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

## 工具页风格统一：与主应用 UI 一致（待讨论，未决定）

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

## 工具页严格沙箱化：opaque origin + 双层 iframe（待办）

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

## UserTool 文件结构与运行环境改造（待办）

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
