# 工具档案（Tool Archive）方案

> 一句话：给每个工具一份由 **AI 主笔、用户把关、随 git 版本化** 的简短「档案」，让维护期 AI 带着"当初为什么这么设计"工作，而不是对着源码反推。

## 背景与问题

- 工具在生成期被 AI 产出后，到了**维护期**（改 bug / 改需求，见 [prd.md](./prd.md) §4.4/§6.5），AI 手里只有 `index.html` 源码 + 一行 commit message 的 summary。
- 行级 diff 对 AI 整文件重写的工具可读性差（见 [todo.md](./todo.md)「版本预览 + 回滚」备注），commit message 又只记"改了什么"——**"为什么这么设计"在跨时间后丢失**。
- 本应用核心哲学是「**工具是资产、对话是过程**」（git 版本化 + 事后可逆）。因此跨时间的稳定知识应落成**可被 git 跟踪、可回滚的文档**，而不是模型侧的隐性状态（向量库 / embedding 之类）。

## 定位与边界

「工具档案」是与工具强绑定、可独立切换的**记录类面板**，与另两者互补、互不重叠：

| 面板 | 记什么 |
| --- | --- |
| 版本历史 | 变更流水（git 提交、回滚） |
| 数据管理 | 工具运行状态（`tools-data` 键/大小/时间） |
| **工具档案** | **设计意图：一句话定位 / 关键决策（为什么）/ 已知限制** |

**不属于档案**：运行时数据（`tools-data`）、工具代码（`index.html`）、变更流水（git——重复会漂）。

## 文件与存储

- **独立文件**：`<工具目录>/archive.md`（**不**塞进 `meta.json`，避免机器契约文件被长文污染）。
- 随工具 git 仓库版本化；回滚时随版本一致回退。`materializeToolSnapshot` 走全树物化，预览某版本时天然带上该版档案。
- **内容三段**：一句话定位 → 关键决策/设计缘由 → 已知限制。
- **红线**：简短；不重复 changelog；不记运行时数据；**严守隐私脱敏**（不写本机路径/用户名/环境变量/token，见 [AGENTS.md](../AGENTS.md)）。

## UI / 交互

- **独立 tab**：`tool-archive` kind，带 `toolId`，每工具独立（仿 `tool-history`）。
- **入口**：工具详情栏（`ToolDetailPanel.vue`）顶部、版本历史图标旁，加一个 lucide 图标（建议 `Archive`），点击打开该工具档案 tab。
- **tab 内**：默认 markdown 渲染预览；右上角「编辑」切换 textarea；保存写回 `archive.md` 并**触发一次 commit**（用户把关纳入版本，message 如「更新工具档案」）。

## 渲染与安全（新增依赖）

- 主渲染器需要 markdown 渲染，当前主应用**没有**渲染器（`docs.markdown.render` 是注入工具 webview 的原子能力，主 UI 不可用）。
- 引入 **markdown-it** 渲染 + **DOMPurify** 消毒（档案内容来自模型/用户，**必须消毒防 XSS**）。版本与类型包（`@types/*`）在安装时确认；**新增依赖需经确认后再装**。

## IPC / 数据链路

- 新增通道 `toolArchive:read` / `toolArchive:write`；主进程落盘 `<toolsRoot>/<工具id>/archive.md` + 轻量脱敏校验。
- 按 [design.md](./design.md) §4 走 preload 暴露 `api`，同步更新 `src/shared/ipc.ts` 类型与注册处。

## AI 写入规则

- **生成期初稿**：AI 首次对某工具做实质改动、且尚无 `archive.md` → 本次改动内附带档案初稿（取材生成结论 + 澄清阶段锁定的决策）。
- **维护期更新**：仅当真的改了「定位/关键决策/已知限制」才更新；AI 动手前**先读磁盘当前档案**（尊重手改、不倒退既定决策）。
- **生成器系统提示词改动**：允许改的文件从 `index.html`/`meta.json` 扩为含 `archive.md`；补充档案写入/更新规则。

## 实现清单（改动点）

1. `src/main/tool-page.ts`：`ALLOWED_TOOL_FILES` 增 `archive.md`；`writeToolPage`/`applyToolChanges` 支持该文件（自由文本，不进 `META_FIELDS`，校验仅"允许该文件 + 路径安全"）。
2. `src/main/tool-git.ts`：`TOOL_FILES` 增 `archive.md`（commit 展示、`rollbackTool` 回写据此覆盖）。
3. 生成器系统提示词：`src/main/ipc/generator.ts` 补档案规则 + 允许文件列表。
4. IPC + preload + `src/shared/ipc.ts`：新增 `toolArchive:read/write` 通道与类型。
5. 渲染层：新建 `ToolArchivePanel.vue`（预览/编辑/保存）；`ToolWorkspace.vue` 加 `tool-archive` kind 与打开逻辑；`ToolDetailPanel.vue` 加入口图标。
6. 依赖：`markdown-it` + `dompurify`（+ 类型包）。
7. 测试：见下。

## 边界与留意

- **回滚到无 `archive.md` 的历史版本**：`git checkout` 会删掉档案，**接受 git 语义**（代码与档案严格对齐），不额外保留。
- **存量工具（无档案）**：**惰性回填**——AI 下次改动该工具时发现缺档案、顺手补一份；**不做**全量一次性回填（成本高、收益低）。
- 文件命名与档案 UI 一致用 `archive.md`；用户界面只叫「工具档案」，文件名对用户不可见。

## 测试覆盖

按 [style.md](./style.md) §6 补：IPC 读写 (`toolArchive:read/write`)、`applyToolChanges`/`rollbackTool` 对 `archive.md` 白名单与回写、生成器系统提示词含档案规则；渲染层编辑/保存链路尽量补。

## 待确认

- markdown 渲染库具体版本、入口图标（`Archive` vs `BookOpen`）最终选择。

## 状态

方案已写入本文档，待评审。
