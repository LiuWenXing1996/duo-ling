# 当前架构与关键约定

提炼自 2026-09-13 的一期落地过程。这些是**仍然生效**的约定，改之前先读一遍。

## 单端架构：只服务浏览器扩展

仓库只有浏览器扩展（Chrome MV3）这一个运行形态。既然只有一个端，就**不需要**抽 `packages/shared` 之类的"双端共用"层——所有代码只服务扩展。

## UI 复用原则：先查现有实现，不重写

**改 UI 先查 `src/components/` 是否已有实现，禁止照着界面重写**——手搓只会丢功能和观感。

现状：对话层（`ChatPanel` / `SessionHistoryPanel` / `ModelFormDialog`）与工作台（`WorkspaceHost` / `WorkspaceTabs` / `SettingsPanel` / `UiTestPanel` / `components/userscript/`）都是现成组件；宿主 `entrypoints/app/WorkbenchApp.vue` 负责装配左侧导航 + `WorkspaceHost`。

复用姿势：依赖体系整体引进（Tailwind v4 + shadcn-vue/reka-ui + ai-elements + AI SDK），组件本体不动，用 `src/lib/window-api.ts` 按 `PreloadApi` 契约桥接 `window.api`，使组件**零改动**。

## 手写数据层必须逐条自检语义

桥接层（`src/lib/*.ts`，如 `model-store.ts`、`window-api.ts`）是**从零手写**的，最容易丢的是**回退 / 守卫 / 规范化**这三类"看不见的语义"——它们不在类型里，只在源码里。

**下面四类各补单测覆盖**，靠测试兜住，不靠人工比对：

1. 展示/默认值回退
2. 入参守卫（空标题、非法 id、未知 op、空清单）
3. 先校验后落盘的原子性
4. 「无变化就不做」的幂等短路径（空提交、重复置顶）

另有一类不写在函数里而写在**常量表**里——服务商预设曾少 7 个就是这么漏的，改 `src/lib/providers.ts` 这类数据表要逐个字段核对（表以现有实现为准）。

已踩实例：展示名为空未回退模型 ID，导致模型 chip 与下拉渲染空白项。**诊断信号**：同一个数据在一个界面显示、另一个界面空白（SettingsPanel 自己带了 `name || model` 所以看不出问题，ChatPanel 才暴露）。

## 主题：跟随系统深浅色

`src/lib/theme.ts` 用 `prefers-color-scheme` 驱动 `html.dark`（`main.css` 的 `.dark` 变量与组件 `dark:` 变体都挂在这个类下）。

两个载体 html **不要**写 `class="dark"`——曾因此把界面固定成纯黑（桌面版 `index.html` 没有这个类，`:root` 才是浅色）。`main.css` 两个作用域都补了 `color-scheme`。

新增 UI 用主题变量（`var(--background)` 等），**不硬编码颜色**。

## 仓库结构

- 仓库根 = WXT 扩展工程本体（`wxt.config.ts`、`package.json`、`tsconfig.json`、`components.json`、`src/`、`docs/`）。
- **`srcDir: 'src'` 是必须的**：WXT 内置 `@`/`~` 别名硬编码指向 srcDir 且**覆盖用户 alias**（`wxt/dist/core/resolve-config.mjs`），而平移来的组件全用 `@/...` 引用。同理 `publicDir` 默认基于项目根而非 srcDir，必须显式 `publicDir: 'src/public'`，否则 `tool-bridge.js` 不进产物。
- 包管理用 **npm**。构建产物 `.output/`，开发 `npm run dev`。
- 交付前验证：`npm run typecheck`（vue-tsc，`noUncheckedIndexedAccess: false`）+ `npm run build`。
- 文档：根 `README.md`、`AGENTS.md`、[docs/plugin-migration-plan.md](../plugin-migration-plan.md)。

## 已否决方案

讨论过但**决定不做**的方向。记在这里的唯一目的：避免同一个问题被重新提出、再讨论一遍。

> **边界**：本表只记**没进提案流程**的小决策（一句话能说清的取舍）。**走完提案流程被拒绝的 → 提案留在 `docs/proposals/rejected/`，不抄到这里**，两边都写就又变成同一件事说两遍。

新增一条时写全「触发问题 → 结论 → 为什么不」，**只写结论等于没写**（半年后没人记得为什么）。

| 日期 | 议题 | 结论 | 为什么不这么做 |
|---|---|---|---|
| 2026-09-14 | 用户脚本「保存为草稿」按钮 | 不做 | 它想服务的每个需求都已有载体：看 AI 试过什么→对话历史；让 AI 接着改→同一条对话继续说；宿主被杀别丢产物→任务快照。再加只是凭空造一个并不存在的产物类型 |
| 2026-09-15 | 工具页风格统一 / 沙箱化 / UserTool 改造 | 不做 | 依赖的 UserTool 工具链路已整体移除，场景无载体 |
| 2026-09-15 | 会话与工具解耦 | 不做 | 同上；已落地部分（会话一等公民、独立存储）已转正常青约定 |

维护规则：

- **否决的当下就记一行**，别等清理 `todo.md` 时补——那时候理由已经丢了。
- 加新约定前先搜本文件有没有被**取代**的旧条目，有就删旧的，别让两条都留着互相打架。
- 反悔重做时，把该行移到上面的正文里，不要留在表中。
