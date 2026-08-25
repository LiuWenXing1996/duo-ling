# 待办清单

> 记录后续要做的功能事项，先在这里收敛方案，再动手实现。

## 工具版本管理：版本预览 + 回滚一体（已实现）

**背景**：工具（每个工具一个本地 git 仓库，自动 commit `index.html` + `meta.json`）目前「版本历史」只是只读列表，缺少「查看某版本效果」和「恢复到旧版本」。已讨论确认：**不做分支管理**（本地单用户、无远程协作，分支复杂度高、收益低），改为做「**版本预览 + 回滚一体**」。

**方案要点（已确认）**：
- **预览**：每条提交提供「预览」入口，弹出该版本的渲染效果（复用工具详情的 `<webview>` 机制），用户回滚前先看清历史版本长什么样。
  - 预览采用**物化方案**：把目标 commit 的**整棵树**（含 index.html 引用的 ESM 子模块，而非仅白名单）物化到 `<userData>/tools-preview/<id>/<oid>/`，用独立 `tool-preview://` 协议渲染，规避原先 `?oid` 随 ESM 子请求丢失的问题。预览文件视为缓存，**不做自动删除**（无孤儿兜底、启动不清、删工具不连带清），仅由设置面板手动清理。
- **回滚**：在预览浮层里提供「恢复到此版本」。回滚 = 把目标 commit 的文件内容写回工作区，并**产生一条新 commit**（message 形如「回滚到 `<shortOid>`」），**不直接 reset / 移动 HEAD**。
  - 这样历史完整可逆，旧提交不丢，回滚动作本身也留痕，回错了可再回滚。
- 不做 `reset`（会丢历史，对「后悔药」场景不可逆）。删除旧 `?oid` 协议分支。

**实现步骤**：
1. `src/main/tool-git.ts`：
   - 新增 `materializeToolSnapshot(id, oid)`：`git.walk` 遍历目标 commit 树全部 blob → 写入临时目录 → 原子 `rename` 落位至 `tools-preview/<id>/<oid>/` → 返回 `tool-preview://<id>/<oid>/index.html`；已物化时幂等复用。
   - 新增 `listPreviewCache()` / `clearPreviewCache()`：统计预览缓存占用（字节 + 版本数）/ 一键清空。
   - 新增 `rollbackTool(id, targetOid)`：读取目标 commit 的 `index.html` / `meta.json` → 写回工具目录 → `commitSnapshot(dir, '回滚到 <shortOid>')`。
   - 移除旧 `readToolSnapshotFile`。
2. `src/main/index.ts`：注册 `tool-preview` scheme（`standard + secure + supportFetchAPI`）与协议 handler（校验 host=工具 id、首段 oid、防目录穿越）；新增 IPC `tool:preview` / `tools-preview:list` / `tools-preview:clear`；删除 `tool://?oid=` 快照分支。
3. preload 暴露 `tool.preview` 与 `toolsPreview.list` / `toolsPreview.clear`。
4. `src/renderer/src/components/tool-history.vue`：每条提交加「预览」→ `openPreview` 调 `tool.preview` 拿 `tool-preview://` URL 交给 `<webview>` 渲染 → 浮层内提供「恢复到此版本」（回滚后刷新列表）。
5. `src/renderer/src/components/settings-panel.vue`：加「工具预览缓存」区块，显示占用 + 版本数 + 一键清理。

**备注**：若后续要「多方案并行」，优先考虑「工具副本/快照」，而非 git 分支。**diff 暂缓**：工具多为 AI 整文件重写，行级 diff 可读性差；预览已能覆盖「看版本变化」，待预览/回滚落地后按需再评估最小 diff（仅 `index.html`、单栏）。

**状态**：已实现。`src/main/tool-git.ts` 新增 `materializeToolSnapshot`（整树物化 + 幂等复用）、`listPreviewCache` / `clearPreviewCache`、`rollbackTool`（写回目标 commit 内容并产生「回滚到 `<shortOid>`」新提交，用 HEAD oid 对比避免空提交/stat 缓存漏判）；`src/main/index.ts` 注册 `tool-preview` 协议与 `tool:preview` / `tools-preview:*` IPC；preload 暴露 `tool.preview` 与 `toolsPreview`；`tool-history.vue` 每条提交加「预览」入口 → `<webview>` 渲染浮层 → 「恢复到此版本」；`settings-panel.vue` 加预览缓存清理区块。已通过 `pnpm test`（`src/main/tool-git.spec.ts` 单测更新为 7 条）。

---

## 工具能力声明：meta.capabilities + 运行时拦截（已实现）

**背景**：工具目前由 `extractCapabilities` 用正则扫描 html 源码里的 `cap.run('id')` 来预判覆盖（见 `src/renderer/src/lib/tool-generator.ts`）。两个软肋：① 一旦支持 ESM 拆分，调用散落到 `.js` 子模块后正则扫不到 → 漏检；② 正则抓不住动态拼接（如 `` cap.run(`${id}`) ``）。已与用户确认改为**在 meta.json 中声明能力清单** + 双层校验，并适当放开 ESM 拆分。

**方案要点（已确认）**：
- `meta.json` 增加 `capabilities: string[]` 字段（当前仅 `id/name/title/description`，见 `src/main/tool-page.ts` 的 `ToolPageMeta` 与 `writeToolPage`）。AI 产出工具时必须声明用到的能力清单；meta 是权威来源，天然兼容 ESM 拆分（与文件数无关）。
- **第一层 · 生成期校验（AI 自调试主战场）**：本期**不做**。用户确认「用户看不明白这个的」，生成期硬拦截先不加，聚焦运行时拦截。
- **第二层 · 运行时拦截（兜底）**：`cap.run(id, args)` 内检查 `id` 是否在 meta.capabilities 中，不在则拒绝并返回结构化错误 `{ ok:false, error }`。拦截放主进程 `capability:run` handler，用 `event.sender.getURL()` 定位工具来源（`tool://` → `{toolId}`，`tool-preview://` → `{toolId, oid}`），preload 零改动；旧工具未声明 `capabilities` 时拒绝一切。
- 错误消息规范是本方案的质量线，实现时需细化文案。

**实现步骤**：
1. `src/renderer/src/lib/tool-generator.ts`：`GeneratedToolDef` 加 `capabilities` 字段；`extractCapabilities` 由「扫 html」改为「读 meta」；`buildCoverage` 同步；生成期对「未知/缺失能力」硬拦截。
2. `src/main/tool-page.ts`：`ToolPageInput` / `ToolPageMeta` / `writeToolPage` 增加并落盘 `capabilities`；工具创建/生成链路端到端透传。
3. `src/preload/tool.ts`：`cap.run` 增加运行时拦截，对照 meta 声明的 allowlist；拒绝结果回传给工具运行器。
4. 生成器系统提示词（`src/main/index.ts`）：引导 AI 在 meta 中准确声明能力清单；跑工具时若报「未声明能力」，AI 应能据此自修正。
5. 与 ESM 拆分互相关联：放开 3 处 `ALLOWED_TOOL_FILES`/`TOOL_FILES` 白名单、git 遍历目录需动态化；能力检测因改读 meta 而天然适配。
6. 测试：单测覆盖 `buildCoverage` 读 meta、运行时拦截返回结构化错误；提示词改动补充端测。

**备注**：运行时拦截是安全边界，一旦启用，AI 声明错误会真实让工具跑挂——这正是让「AI 自调试 + 良好报错」能兜住的设计动机，故报错信息必须清晰到 AI 无需猜测即可修复。

**状态**：已实现（仅运行时拦截）。`meta.json` 落盘 `capabilities`；主进程 `capability:run` 用 `event.sender.getURL()` 定位来源并对未声明能力的工具拒绝；预览版走该 commit 物化出的 meta；生成器系统提示词加入能力声明要求。已提交 `d0634d3`。

---

## 工具页风格统一：与主应用 UI 一致（待讨论，未决定）

**背景**：工具页由 AI 直接写原生 HTML（现为纯 CSS、无 Tailwind，见 `src/main/tool-page.ts` 的 `newToolScaffoldHtml`），导致工具页 UI 与主应用（shadcn-vue 风格）严重不搭。要让 AI 产出与主应用一致的界面。

**已查实的关键事实**：
- shadcn-vue 是**源码复制式**（`npx shadcn-vue add` 拷 `.vue` 源码进 `components/ui/`），**官方不发 dist 包**——「官方打包好的按钮/卡片」不存在；外观那层是源码 + Tailwind 类 + design tokens。
- 有官方 dist 的是**底层库**：reka-ui（无头组件，ESM-only、依赖树重：vue peer + `@floating-ui/*`/`@vueuse/core`/`@tanstack/vue-virtual` 等，体积几十 KB 起）、@lucide/vue（有 UMD 全局产）。
- reka-ui 是**无头**组件，**不带样式**（靠 `--reka-` 变量 / `data-reka-` 属性），**本身无法提供「shadcn 外观」**。

**已讨论的方案档位（成本递增）**：
- **档位A · 设计令牌 + 类名（倾向）**：与主应用共用一份 design tokens + 常用组件样式的 CSS 产物（放 vendor），AI 用原生标签 + 类名即得主应用风格。零依赖、零耦合、随主应用进化；代价是软约束、类名体系需维护。
- **档位C · 折中基元**：只把 Button/Card/Input/Select/Tabs 等基元打进 vendor 当真组件，其余 tokens+类名兜底。需 Vue 运行时 + reka-ui 依赖 + CSP `unsafe-eval`。
- **档位B · 整套组件库**：最完整但最重，性价比最低。

**核心结论 / 决策点**：
- 无论哪条路，「外观」都要靠自己定义 tokens/类名——reka-ui 只给无障碍交互，不解决风格问题。
- 用官方 reka-ui dist **不能绕开依赖**（省了 Vite lib 打包，多了 ESM 依赖树 + Vue 运行时 + 体积）。
- 性价比如下：**纯 A** 最优；**A 外观 + lucide 官方 UMD 图标 + 按需 reka-ui** 次之；默认给每个工具页装全套 reka-ui 亏。
- **待确认**：工具页对「复杂交互」（下拉框/弹层/标签页等有状态交互）的真实需求。若工具多为表单/展示类，档位 A 就够；仅当多数工具需要这类交互时才值得引入 reka-ui。

**状态**：尚未决定，倾向档位 A。待确认工具页复杂交互需求后再定，不予落地。

---

## 生成器审批模式：默认 auto（去掉手动审批）（已实现）

**结论**：把 `GeneratorApprovalMode` 的默认值从 `manual` 改成 `auto`，让 AI 变更工具清单直接落盘 + 自动 commit，不再每步都要用户确认。「去掉」仅作用于「AI 改单个工具内 index.html/meta.json」这条链路，不是删掉整套机制。

**依据（为何现在能去手动审批）**：
- 清单内天然低风险：`ToolChangeList` 只有 `write`/`patch`、作用于单个工具、白名单限 `index.html`/`meta.json`（见 `src/main/tool-page.ts` 的 `ToolChangeOp`/`ToolChangeList`）。AI 删不了数据、碰不了别的工具。
- commit + 回滚兜底：改坏可回滚到上一版本，成本摊得平（`src/main/tool-git.ts` 的 `commitToolChanges`）。
- 高副作用已被结构隔离：删工具走 `tool:delete`（`src/main/index.ts`），已有 UI 侧独立确认弹窗；碰电脑环境属于另一类系统动作，走安全边界确认，不在 `GeneratorApprovalMode` 管辖内。

**前提（与能力声明配套才闭环）**：去掉 manual 后，AI 直接落盘，出错要靠「AI 自调试 + commit 回滚」兜底——即前面「工具能力声明」那条的**运行时拦截 + 报错自诊断**需先到位，否则 auto 出错 AI 不好自己修。故这两项应绑定实现。

**注意 / 边界**：
- 「删工具」的确认不属于 `GeneratorApprovalMode`，它属于 UI 主动删除动作，保留自身确认，不要因本项改动而一起去掉。
- 改完后需同步设置面板 UI（`src/renderer/src/components/settings-panel.vue` 的审批模式选项），避免出现「选了 manual 却不能被触发」的悬挂状态；同时确认 `tool-page.vue` 读取 approvalMode 的分支逻辑随默认值正确表现。

**涉及改动**：`src/main/online-llm.ts` 的 `DEFAULT_APPROVAL_MODE` 改为 `'auto'`；同步检查相关设置 UI 与渲染层分支。

**状态**：已实现。直接移除 `manual/auto` 审批模式全套链路（类型、IPC、preload API、设置面板与会话页开关），AI 变更清单产出后固定自动落盘；变更清单卡片保留作留痕提示。已提交 `238dd3b`。

---

## 工具数据管理：独立数据区 + 设置概览表格 + 详情页（已定方向）

**背景**：工具目前无「产出数据持久化」能力（仅 `local.file.read` / `docs.markdown.render` 两个原子能力）。工具运行产出的数据、工具自身状态/草稿需要持久化。已确认用**独立数据区**而非塞进工具目录，与工具二进制/源码分离。

**方案要点（已确认）**：
- 独立数据区 `<userData>/tools-data/<id>/`，与工具目录分离（孤儿数据保留在此，删除工具不影响数据）。
- 结构：每个工具一个 `manifest.json`（`{ title, createdAt, dataKeys[], sizeBytes }`）+ **按 key 一个 JSON 文件** `<key>.json`。`manifest.json` 用于面板「不开工具就能拿概览」（孤儿态时工具目录已无、只剩 data 目录）。
- **删除工具二选一**：`tool-page.vue` 删除确认弹窗改为「保留数据 / 连带删除」；选保留则工具目录删除、数据留在 `tools-data/` 成孤儿。
- **设置面板加「工具数据概览表格」**：列 = 工具名 · 数据量（条数/大小）· 最近使用 · 孤儿标记；点击某行 → 打开独立 `tool-data` tab 看详情。
- **详情 tab**：新增 `tool-workspace.vue` 的 `OpenTool` kind `'tool-data'`（仿 `tool-history` 的 `openToolHistory` 用法）；新建 `tool-data-detail.vue` 展示 manifest 概览 + key 级明细（大小/修改时间）+ 操作「打开数据目录 / 清空」。
- **孤儿数据**：设置表格中以 orphan 标记区分，提供清理入口（`tools-data:deleteOrphan`）。
- **导出**：**本期不做**。先提供「打开数据目录」让用户自行拷贝；导出打包（zip）后续按需评估（仅在「单工具多 key 想一次性拿走」时值得做）。

**实现步骤**：
1. `src/main/` 新增 `tools-data` 模块：`listToolsData()`（扫 `tools-data/`、读 manifest 汇总）、`getToolDataDetail(id)`、`clearToolData(id)`、`deleteOrphanToolData(id)`、`openToolDataDir(id)`。
2. 主进程注册 IPC：`tools-data:list` / `tools-data:detail` / `tools-data:clear` / `tools-data:deleteOrphan` / `tools-data:open`（仿 `src/main/index.ts` 现有 IPC 风格与异常返回 `{ ok, error }`）。
3. `src/renderer/src/components/tool-workspace.vue`：`OpenTool` 增加 `kind: 'tool-data'`，新增 `openToolData(id)`（仿 `openToolHistory`，可复用 `toolId`/`toolTitle` 字段）。
4. 新建 `src/renderer/src/components/tool-data-detail.vue`（仿 `tool-history.vue` 的 props 接收方式）：渲染详情 + 操作。
5. `src/renderer/src/components/settings-panel.vue`：加「工具数据」区块表格，读 `tools-data:list`，点击行触发开 tab。
6. `src/renderer/src/components/tool-page.vue` 删除链路：删除确认浮层加「保留数据 / 连带删除」二选一，选保留则数据落入 `tools-data/` 留孤儿。

**前置依赖（待联动）**：工具要能**写/读** `tools-data/` 需要新的原子能力——当前只有 read 类能力、无写能力。该依赖与「工具能力声明（meta.capabilities）」联动，落地时一并接上，单独评估。

**状态**：已实现（本期不含「导出打包」，仅提供「打开数据目录」）。主进程 `src/main/tools-data.ts` 新增 `listToolsData` / `getToolsDataDetail` / `clearToolsData` / `deleteOrphanToolsData` / `openToolsDataDir`，并实现 `tool.data.write/read/list/remove` 四个原子能力（key 白名单 `[A-Za-z0-9_-]+` 防目录穿越）；`capability-registry` 合并该分域、`capability:run` 经 meta.capabilities 白名单校验后路由到主进程（预览不拦截）；`src/main/ipc/tool.ts` 注册 `tools-data:*` 五个 IPC 且 `tool:delete` 增加 `keepData` 参数；preload 暴露 `toolsData` 子对象，`tool.delete(id, keepData)`；生成器系统提示词补充 `tool.data.*` 说明；渲染层 `tab.ts` 新增 `tool-data` kind、`settings-panel.vue` 加「工具数据」概览表格与孤儿清理入口、新建 `tool-data-detail.vue` 详情 tab、`tool-delete-dialog.vue` 改为「保留数据 / 连带删除」二选一。测试覆盖 `src/main/tools-data.spec.ts`，`typecheck` / `test`（97 用例）/ `build` 均通过。已提交 `eae135e`。

---

## 工具图标：meta.icon（已实现）

**背景**：工具为 AI 生成的单个 HTML，目前无图标概念。主页网格 / 侧边条 / 工具详情页需要可区分的视觉标识。与「工具页风格统一」同源。

**方案要点（实际落地，已相对原始构想简化）**：
- `meta.json` 增加可选 `icon: string` 字段，**仅接受单个字符**（emoji / 字母 / 汉字等，按码点计 1）。
- 主进程 `normalizeToolIcon(icon)`：非法（非单个码点）或为空时返回 `''`；渲染层 `tool-icon.vue` 为空时回退工具名首字符，两者皆空则用 `✨`。
- **渲染层统一组件** `tool-icon.vue`：主页卡片 / 标签栏 / 搜索下拉 / 工具详情头部共用（4 处展示位）。
- **手动编辑入口**：工具卡片右上角编辑按钮 → 编辑弹窗（名称 / 图标 / 描述）；图标字段旁提供常用**单码点** emoji 选择面板（避免 ❤️ / ⚙️ 这类带变体选择符 U+FE0F 的双码点 emoji 被归一化清空）。
- **为何从三态简化为单字符**：最初方案为 lucide/emoji/svg 判别联合，后确认仅支持单字符，避免 lucide 全量映射的打包体积与 SVG 的 XSS 风险；校验也随之简化为「单码点」。

**状态**：已实现。主进程 `tool-page.ts` 新增 `normalizeToolIcon` / `updateToolMeta`；`src/main/index.ts` 注册 `tool:updateMeta` IPC（替换原 `tool:setIcon`）；preload 暴露 `tool.updateMeta`；新增 `src/renderer/src/components/tool-icon.vue`；`tool-workspace.vue` 卡片右上角编辑弹窗（名称/图标/描述 + emoji 面板）、删除内联编辑；4 处展示位接入。单测覆盖 `updateToolMeta`（`src/main/__tests__/tool-page.spec.ts`）。

---

## 会话与工具解耦：会话提升为一等公民（方案已写，待评审）

**背景**：当前会话/对话强绑定工具，无法跨工具、无法在一次对话中修改多个工具。已与用户确认将「会话」提升为一等公民，与工具解耦；同一会话可改任意工具、可一次改多个，并支持多个 AI 会话并行思考 + 对同一工具串行写入。

**方案要点（已确认）**：
- **绑定下沉到 EditIntent**：`Conversation → Message → EditIntent { toolId, summary, actions[], status }`，会话从不拥有工具。`Conversation { id, title, createdAt, lastMessageAt }`、`Message { id, conversationId, role, content, createdAt }`、`Tool`（磁盘目录）独立于会话。
- **多工具 manifest**：AI 输出 `{ intents: [{ toolId, summary, actions[] }] }`，天然支持一次改多个工具。
- **无感确认 = 事后可逆而非事前阻塞**：靠 git 版本化 + `tool.rollback` 兜底；每个 EditIntent 一个 commit，撤销 = revert 到父 OID。
- **单写者全局 per-tool 锁**：锁带持有者标识 `{ toolId, holder: { conversationId, messageId, intentId }, acquiredAt }`；查锁只读畅通、拿锁排他串行。
- **执行管线（Plan B）**：待办清单只展示意图（intents），执行时逐工具持锁重读当前内容 + 重生成 + 落盘，避免覆盖用户手动修改、识别「已无需改动」；每改一个工具锁一个工具，支持锁前提示。
- **多 AI 并发（B 方案）**：不做并发上限调度器（3-4 个 AI 是用户自然上限）。规划时 AI 先查锁，被锁则跳过+提示用户；执行时被锁则视为执行失败并告知原因 + 重试出口。
- **中断**：执行期间禁发新消息 + 停止按钮；优雅中断 = 收尾当前项 → 释放锁 → 取消剩余 → 恢复输入。
- **数据区**：`<userData>/tools-data/<id>/`，单 key 原子、AI 不写数据区、不锁数据区（用 schema 版本 + 读容错兜底语义漂移）。
- **webview 重写**：停旧页 → 写文件 → 加载新页，用「过渡占位」而非遮罩/白屏；批量写 + 单次 reload。

**详细文档**：见 [conversation-tool-decouple.md](./conversation-tool-decouple.md)。

**状态**：方案已写入 docs，待评审。

---

## 工具快捷方式：置顶/收藏（形态待定）

**背景**：用户提出在左侧边条支持工具快捷方式。现状：侧边条为窄图标条（`src/renderer/src/App.vue` 的 `workspace-nav`，仅「新建工具」「设置」两项）；工具目前经主页网格 + 顶栏 ⌘K 全局搜索打开。

**结论 / 决策点**：
- 价值在「高频工具一键直达 / 入口更短」，但需**工具图标体系**（见上一条 meta.icon）作为区分度支撑。
- 形态二选一，**尚未决定**：
  - **A（轻量，倾向）· 主页网格加「常用/置顶」分组**：给工具加收藏，收藏的排在主页网格最前；复用现有卡片，最自然，不动侧边条。
  - **B（较重）· 升级侧边条为置顶工具区**：把窄图标条扩成可放置顶工具的区域，每工具一个图标/首字母 + tooltip；图标区分度依赖图标体系，窄条信息密度低。
- 两种形态均需：① 一个「标记收藏」交互（工具详情页或主页卡片上放 pin 按钮）；② 收藏列表持久化（settings 存一个 `tool id` 数组）。

**状态**：形态 A/B 未定（图标体系已落地，可以此支撑从 A/B 中选定）。与「工具图标 meta.icon」绑定。
