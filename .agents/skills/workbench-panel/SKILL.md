---
name: workbench-panel
description: Use when adding, changing, or debugging a workbench tab/panel in this extension — wiring a new WorkspaceTabKind end to end (left nav button → tab bar icon → WorkspaceHost panel → README lists), picking a data source that extension pages can actually import (offscreen-only modules like us-git / builder / script-tools break the workbench bundle), or writing the 3-piece test set (drift test from runtime reflection / component test / e2e assertion).
---

# 工作台标签页（新增 / 改动一个面板）

工作台 = `WorkbenchApp.vue`（左侧图标导航）+ `WorkspaceHost.vue`（多标签宿主）+ 各面板组件。
新增一个标签页是**机械接线 + 一个面板组件**，没有路由、没有注册表。

## 接线固定 6 处（缺一处就静默不生效）

| # | 文件 | 改什么 |
| --- | --- | --- |
| 1 | `src/shared/types.ts` | `WorkspaceTabKind` 加 kind 字面量（如 `'agent-tools'`） |
| 2 | `src/types/tab.ts` | 顶部注释里的标签清单（项目习惯，改了顺手补） |
| 3 | `src/components/WorkspaceTabs.vue` | 标签栏图标分支 —— **必须插在 `v-else` 兜底之前**（兜底是 settings 图标，插后面永远走不到） |
| 4 | `src/components/WorkspaceHost.vue` | ① `openXxxTab()`（幂等：已开则 activate，不重复 push）；② `<ui-tabs-content>` 里 `v-else-if="tab.kind === 'xxx'"`；③ `defineExpose` 补上方法名 |
| 5 | `src/entrypoints/app/WorkbenchApp.vue` | 左侧导航 `<button class="workspace-nav-item" aria-label="…">` + `ui-tooltip`（`TooltipProvider > Tooltip > TooltipTrigger as-child > button`，顺序不能反）+ `@click="workspaceRef?.openXxxTab()"` |
| 6 | `README.md` | 载体分工表的「承载内容」列 —— **标签页清单唯一登记处**（UI 复用段只链接、不罗列，别再加第二份） |

标签 id 约定：全局唯一视图用固定 id（`'agent-tools'`）；每实体一个的用 `前缀:<uuid>`（如 `us-edit:<uuid>`）。

## 面板数据源（最容易翻车的一步）

工作台是**扩展页**上下文，而很多库只在 offscreen 可用：

- ❌ 不能 import：`userscripts/us-git.ts`（duoling-fs，只许 offscreen 碰）、`userscripts/builder.ts`（esbuild）、`offscreen-chat/script-tools.ts`（拉了前者两个 + 裸 IDB 读侧）、任何 `offscreen-chat/*` 编排件。
- ✅ 可以直接用：只读 IDB 的 `lib/*-store.ts`（`conversation-store` / `project-store` 读侧）、`chrome.storage`、纯数据模块。
- 需要 offscreen 才有的数据，两条路：
  - **新增 IPC 命令**（走 SW / offscreen；代价是唤醒 offscreen、链路变长）；
  - **抽一份纯数据模块**（首选，见 `lib/agent-tools-catalog.ts`）：把文本 / 常量放进去，运行时与 UI 共用同一份，**再配一条从运行时对象反射比对的单测**（`Object.keys(tools)`、`schema.shape`）防漂移 —— 不要靠人工对照。
- 数据会变的面板：接 `useDataSync(域, reload)`；写侧一律走既有的写入口（写侧埋 `broadcastDataChange` 是铁律，别绕过）。

## 复用 vs 手写

- 先搜现成实现：`src/components/`（业务组件）、`src/components/ui/`（shadcn）、`src/components/ai-elements/`（对话类）。
- 只读调试视图的骨架照抄 `ChatDataPanel.vue`：外层 `flex h-full min-h-0 min-w-0`，左栏 `w-72 shrink-0 border-r`，滚动区 `min-h-0 flex-1 overflow-y-auto`。
- 展示 tool part 用 `ai-elements/tool` 的 `Tool` / `ToolHeader` / `ToolStatusBadge`（轻，只依赖 Collapsible + Badge）；
  **别用 `ToolInput` / `ToolOutput`** —— 它们走 `CodeBlock` → shiki（按需 ~200KB、动态 import），工作台里不值当。大 payload 自己 `<pre>` + 截断。
- 样式：只语义 token（`bg-muted` / `text-muted-foreground` / `border-border` / `bg-destructive/10`），不写 `space-x-*` / `space-y-*` / 手写 `dark:`。
- **长区块一律可折叠**（`src/components/ui/collapsible`，默认收起）：详情 / 契约 / 表格这类内容长度不可控（实测某工具的入参表有 10 项），一旦铺开会把它下方更该看的半屏（调用轨迹 / 日志）整块顶出屏幕。折叠标题行保留「一句作用 + 规模提示」（如「契约详情 · 10 个入参」），收起时也不失信息。
  - 测试要跟着改：reka-ui 的 `CollapsibleContent` **收起时不渲染**，断言内容前先点 `[data-testid="...-toggle"]` 再 `flushPromises()`（组件测试）/ `click()`（e2e）。

## 测试三件套

1. **防漂移单测**（logic project，`src/lib/xxx.test.ts`，参考 `agent-tools-catalog.test.ts`）：UI 展示的元数据若与运行时共用常量，就断言二者一致 —— 工具名集合、参数名集合（`inputSchema.shape` 在 zod v3/v4 都可用）、description 相等。
2. **组件测试**（component project，`*.component.test.ts`，参考 `AgentToolsPanel.component.test.ts`）：`vi.mock` 掉 store 与 `use-data-sync`，用 `data-testid` 断言；**空态必须断言**（空白 vs 有内容的空态是两种 bug）。
3. **e2e 冒烟**（`e2e/smoke.spec.ts`）：`page.locator('button[aria-label="<导航名>"]').click()` → 断言面板 `data-testid` 可见 + 关键文本渲染。跑 `npm run test:e2e`（Playwright 捆绑 Chromium、全程无头、跑 `.output/chrome-mv3` 产物，**先 `npm run build`**）。

## 坑（实证）

- **Edit 后 typecheck 报 `'Xxx' is declared but its value is never read`** = 模板里的标签根本没插进去（组件 import 了但没用上）。别怀疑 vue-tsc，回去读模板。
- `data-testid` 挂在 `ai-elements/tool` 的 `Tool` 上能落到根元素（它 `v-bind="$attrs"`），e2e 里可用来数轨迹行。
- e2e 环境**几乎不会是空会话库**：`openMessengerPage()` 打开 `sidepanel.html`，侧边栏初始化时会确保存在一个会话。所以「会话库为空」类空态别当必然分支断言 —— 要么断 `count = 0`，要么正则接受两条分支。
- **反复 `npm run build` 会撞安全删除闸**：wxt 每次构建前 `rm -rf .output/<target>`，产物约 490 个文件，远超「单轮 50 文件」阈值 → 第二次构建可能中途失败（不是代码改坏了）。构建前先把旧目录 `mv` 到仓库外（`mv .output/chrome-mv3 /tmp/<name>-$(date +%s)`），构建后再挪走新产物 —— 让每次构建都面对「一个不存在的目标」。
