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
- `meta.json` 增加可选 `icon: string` 字段，接受两种格式：**单个字符**（emoji / 字母 / 汉字等，按码点计 1）或 **`lucide:<名称>`**（kebab-case）。
- 主进程 `normalizeToolIcon(icon)`：非法的单个字符 / lucide 名称返回 `''`；渲染层 `tool-icon.vue` 为空时回退工具名首字符，两者皆空则用 `✨`。
- **渲染层统一组件** `tool-icon.vue`：主页卡片 / 标签栏 / 搜索下拉 / 工具详情头部共用（4 处展示位）；`lucide:` 前缀时按需动态加载允许列表内图标（见 `src/renderer/src/lib/lucide-icons.ts`），不在列表回退名称首字符。
- **手动编辑入口**：工具卡片右上角编辑按钮 → 编辑弹窗（名称 / 图标 / 描述）；图标字段旁提供 **lucide 选择面板**（搜索 + 网格预览，与 emoji 面板互斥）。
- **为何从三态简化为字符 + lucide 两种**：最初方案为 lucide/emoji/svg 判别联合，后确认不支持 SVG（XSS 风险）；lucide 采用**允许列表 + import.meta.glob 按需加载**（约 277 个常用），避免全量映射（3554 个）的打包体积。
- **兼容性**：旧数据仅单字符，新格式 `lucide:*` 向后兼容；主进程只做宽松格式校验，名称是否可用由渲染层允许列表裁决。

**状态**：已实现。主进程 `tool-page.ts` 新增 `normalizeToolIcon` / `updateToolMeta`；`src/main/index.ts` 注册 `tool:updateMeta` IPC（替换原 `tool:setIcon`）；preload 暴露 `tool.updateMeta`；新增 `src/renderer/src/components/tool-icon.vue`、`src/renderer/src/lib/lucide-icons.ts`、`src/renderer/src/components/lucide-icon-picker.vue`；`tool-workspace.vue` 卡片右上角编辑弹窗（名称/图标/描述 + emoji / lucide 面板）、删除内联编辑；4 处展示位接入。单测覆盖 `normalizeToolIcon` / `updateToolMeta`（`src/main/__tests__/tool-page.spec.ts`）与 `tool-icon.vue`（`src/renderer/src/components/tool-icon.spec.ts`）。

---

## 会话与工具解耦：会话提升为一等公民（实施中 · P1 基本落地）

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

**状态**：实施中（部分已落地，依据本次代码核查）：
- **P1 解耦与契约 · 基本落地**：`EditIntent` 模型（含 `error` / `createdAt`）、多工具 manifest `intents[]`、`Conversation` 独立存储与会话解耦（零工具纯聊天 / 一次改多工具）、会话一等公民均已实现。只读锁查询 `tool.lock.status` 以 capability + `agent_tools_lock_status` 形式可用（无独立 IPC 通道，走通用 `capability:run`）。
- **P2 执行管线 · 部分落地**：每个 `EditIntent` 一个 commit、移除弹窗确认（自动落盘留痕）已实现；但「每条 intent 独立撤销到父 OID」未打通（`EditIntent` 不存 commit oid）、待办清单（多条 intent + 每项可撤销）、锁前提示、持锁后重读重生成、优雅中断均未实现，且执行期不可打断（`streaming` 只覆盖 AI 生成，不覆盖落盘执行）。
- **P3 并发协调 · 未实现**：per-tool 全局锁（带 holder + acquiredAt）纯只读占位，无 acquire / release，AI 落盘 / 回滚 / meta 编辑 / 直接文件编辑等写路径均未加锁；查-执行两步 + 失败重试未实现。
- **数据区**：`tools-data`（key 白名单 / manifest / AI 不写数据区）已实现。
- **webview 重写编排**：仅基础 `reload()`，无「停旧页 → 写文件 → 加载新页」、无过渡占位、非批量写 + 单次 reload。

**关键缺口（按影响排序）**：① 写路径无任何锁（P3，安全边界）；② `EditIntent` 与 git commit 未打通（无法一键撤销到父 OID）；③ 执行期不可打断。

---

## 工具快捷方式：置顶/收藏（已实现）

**背景**：用户提出在左侧边条支持工具快捷方式。现状：侧边条为窄图标条（`src/renderer/src/app.vue` 的 `workspace-nav`，仅「新建工具」「设置」「开发者」三项）；工具目前经主页网格 + 顶栏 ⌘K 全局搜索打开。已与用户确认：**形态 = 组合 A+B**（主页「常用」分区 + 侧边条顶部置顶图标区），**入口 = 主页卡片 pin 按钮 + 编辑弹窗「置顶」开关**。

**方案要点（已确认）**：
- **持久化**：收藏是用户偏好，**不入 meta.json**（避免随 AI 改动/回滚漂移）。仿 `tool-group-store.ts` 新建 `src/main/tool-pin-store.ts`（electron-store，`pinned: string[]`），提供 `listPinnedToolIds` / `setToolPinned(toolId, pinned)` / `clearToolPin(toolId)`（幂等）。
- **IPC**：新增 `tool-pin:list` / `tool-pin:set`（仿 `tool-group:list/set`）；`tool:delete` 同步清理 pin 映射（仿 `clearToolGroup`）。
- **主页（HomePanel）**：sections 最前插固定「常用」分区（默认展开、排最前、可折叠），pinned 工具**在原分组保留**（不消失、不困惑）；卡片 hover 操作区（现有 edit/delete 旁）加 pin 按钮，激活态高亮。
- **编辑弹窗（ToolEditDialog）**：加「置顶」开关，`saved` payload 带 `pinned`。
- **侧边条（app.vue `workspace-nav`）**：顶部（分隔线之上）加置顶图标区，pinned 工具图标竖排（复用 `ToolIcon` + tooltip，点击开 tab）；超过 N 个（默认 8）截断 + 溢出「更多」浮层入口。
- **删除工具**：`tool:delete` 里连带清理 pin 映射。

**状态**：已实现。主进程 `src/main/tool-pin-store.ts` 新增（`listPinnedToolIds` / `setToolPinned` / `clearToolPin`，electron-store 存 `pinned: string[]`）；`src/shared/ipc.ts` 新增 `tool-pin:list` / `tool-pin:set` 通道与类型映射、`tool` 类型加 `pin` 子对象；`src/main/ipc/tool.ts` 注册两 handler 且 `tool:delete` 连带 `clearToolPin`；preload 暴露 `tool.pin.list` / `tool.pin.set`；`HomePanel.vue` 「常用」分区排最前（置顶顺序、忽略不存在 id、原分组保留）+ 卡片 pin 按钮（激活态常显高亮）；`ToolEditDialog.vue` 加「置顶」开关；`ToolWorkspace.vue` 维护 `pinnedIds` 并透传，pin 变化后 emit `pinsChanged` 同步根布局；`app.vue` 侧边条顶部置顶图标区（直显上限 8、溢出「更多」popover 浮层、分隔线）。测试：`tool-pin-store.spec.ts`（5 条）+ `HomePanel.spec.ts`（5 条，覆盖常用分区排序/激活态/事件派发），`pnpm typecheck` / `pnpm test`（183 用例）通过。

---

## 工具档案：AI 主笔的每工具说明书（已实现）

**背景**：维护期 AI 只有 `index.html` + 一行 commit summary，丢失"当初为什么这么设计"，容易改跑偏。工具是资产、对话是过程，跨时间的稳定知识应落成可 git 跟踪、可回滚的文档。已与用户确认：每个工具一份**工具档案**，AI 主笔、用户把关、随 git 版本化、简短。

**方案要点（已确认）**：
- **命名**：UI 称「工具档案」，磁盘文件 `archive.md`（独立文件，不塞进 `meta.json`）。
- **定位**：与「版本历史（变更流水）」「数据管理（运行状态）」并列的第三个记录类面板，独立 tab、带 `toolId`、入口图标与版本历史图标并排（`ToolDetailPanel` 顶部）。
- **内容**：固定三段——一句话定位 / 关键决策·设计缘由 / 已知限制；不重复 changelog、不记运行时数据、严守隐私脱敏（详见 [tool-spec.md](./tool-spec.md) §8）。
- **渲染**：`ToolArchivePanel.vue` 只读，用 `vue-stream-markdown`（与对话消息渲染同源）；**不提供手动编辑**，档案由 AI 在对话中记录与更新，面板上提示「由 AI 记录，和 AI 对话即可增改」。
- **写入链路**：新建即创建 `archive.md`（初始为三段式占位骨架 `## 定位 / ## 关键决策 / ## 已知限制`）；AI 写档案与改工具一样走 `applyToolChanges` 的 `archive.md` 白名单，随 git 版本化。
- **AI 规则**：生成期首次实质改动且无档案时附初稿；维护期仅当改了定位/决策/限制才更新；动手前先读磁盘当前档案。
- **回滚**：接受 git 语义，回滚到无档案版本档案即消失；存量工具惰性回填，不做全量。

**权威规范**：见 [tool-spec.md](./tool-spec.md) §8 工具档案。

**状态**：已实现。`archive.md` 随脚手架创建（三段式占位骨架）并可随 git 版本化；档案面板 `ToolArchivePanel.vue` 改为只读 `vue-stream-markdown` 渲染，移除手动编辑与 `writeToolArchive` IPC 链路；`tool-spec.md` §8（§8.1 定位与边界 / §8.2 内容三段 / §8.3 写入时机 / §8.4 文件与存储要点）作为权威规范，原 `tool-archive.md` 已删除（规范收敛避免双源）。已提交 `9ddc871`。

---

## webview 显式沙箱化：guest sandbox + preload 兼容验证（待办）

**背景**：`docs/prd.md` 8.4 声明工具页 `<webview>` 为 `sandbox: true`，但实际 `src/renderer/src/components/tool-frame.vue` / `tool-history.vue` 的 `<webview>` 标签**未写 `sandbox` 属性**，而 Electron 中 webview 的 `sandbox` **默认不开启**（默认仅在开启 nodeintegration 时才沙箱）——设计与实现存在出入。当前工具页防线为「无 Node（nodeintegration 默认关）+ CSP + cap 白名单 + 独立进程」，已构成基本安全；补沙箱是让渲染进程获得 OS 级隔离（崩溃/越权被关在独立沙箱进程内），与 CSP 管「资源加载」互补、管「运行环境」。

**方案要点（待确认）**：
- 给 `<webview>`（`tool-frame.vue` / `tool-history.vue` 两处）显式加 `sandbox` 属性。
- **关键前置验证**：`sandbox` 开启后 guest preload 变为 **sandboxed preload**（只能 `require` electron 受限子集），需确认现有 guest preload（注入 `window.cap` + 心跳 `sendToHost`）在沙箱环境下仍能工作；若受限，需将 preload 改为仅用 `ipcRenderer` / `postMessage` 等沙箱允许的 API。
- 主窗口 `webPreferences.sandbox: false`（见 `src/main/windows.ts`）与 guest 沙箱互不影响，无需改动。
- 顺带确认 `partition` 是否要引入（当前所有工具共享默认会话，存储未隔离；与沙箱化同属「webview 运行环境」加固，可一并评估）。

**关联**：与「工具 ESM 拆分（折中：仅限工具目录内相对 import）」同一批 webview 安全加固；落地时验证 e2e 中工具页加载 / 心跳 / 能力调用不受影响。

**状态**：待办。方向已确认（显式加 sandbox），guest preload 沙箱兼容性待验证。

---

## UserTool 文件结构与运行环境改造（待办）

**背景**：`docs/tool-spec.md` 为「工具规范」权威契约，只描述目标形态、**不谈进度**；以下为落地 `tool-spec.md` 所需实现的改造项，统一登记于此（按 tool-spec 章节归组）。

**方案要点（目标态见 tool-spec.md）**：
1. **CSP 权威层（tool-spec §6.2/§6.3）**：
   - `tool://` / `tool-preview://` 协议响应头统一下发 `content-security-policy`（权威兜底，不依赖生成端 AI 写 meta）——已落地；
   - 脚手架 <meta> CSP 已移除（原「对齐或移除」选择「移除」，CSP 仅由响应头权威下发，避免双写交集不一致）。
2. **`.css` MIME（tool-spec §3.3/§6.2）**：协议层扩展名→Content-Type 映射补充 `.css` → `text/css`。
3. **文件白名单放开 + git 动态遍历（tool-spec §3.2/§5.2）**：
   - 主进程编辑白名单、生成器侧文件白名单两处从「两文件」放开为「两个固定文件 + 三个目录 + 工具档案」；
   - git 提交 / 回滚遍历从固定两文件改为动态遍历工具目录（排除 `.git/`），并防目录穿越。
4. **脚手架改造为目录骨架（tool-spec §5.1 创建）**：新建 UserTool 从「自包含单文件」改为「入口页 + 脚本/样式目录 + 空静态资源目录」。
5. **工具档案 `archive.md` 落地（tool-spec §8）**：档案读写链路、随 git 版本化、生成规则（详见 [tool-spec.md](./tool-spec.md) §8 工具档案）。
6. **`local.file.choose`（tool-spec §4.2）**：系统文件选择框能力，建立「用户授权选文件」边界。
7. **CSP violation 反馈闭环（tool-spec §6.3）**：把运行时 CSP violation 反馈给生成端 AI 自检（增量可选）。

**关联**：与「webview 显式沙箱化」同一批运行环境加固；落地顺序可按依赖排（先 1/2/3，再 4/5，6/7 独立）。
