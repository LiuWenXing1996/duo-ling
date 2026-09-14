# 踩坑记录

> 经验记录策略（随项目走）：所有项目经验只记录在本文件（及项目 docs/ 下），不写入 IDE 的 project_memory。经验一律随仓库分发、可被 git 跟踪；协作者或 AI 在开始任务前应阅读本文件获取历史经验。

> 2026-09-15 清理：Electron 时期条目（electron-vite / pnpm / electron-store / 主进程 ESM / Electron 端测与 CDP 调试等）已删除——原桌面版已整体归档 `legacy/`（只读、不参与构建），这些经验对扩展工程不再适用。需要时 git 历史可查。保留的条目以「工具链路移除前后的代码现状」为准，文件:行号可能随重构漂移，以符号名为准定位。

## 工具与组件（reka-ui / shadcn-vue）

- **图标库**：`lucide-vue-next` 已弃用，使用 `@lucide/vue`。
- **手动添加 popover 组件**：reka-ui v2 已提供完整 Popover 组件，按现有 ui 组件结构手动创建 `ui/popover/`（popover.vue 用 `useForwardPropsEmits` 包装 `PopoverRoot`，popover-content.vue 用 `PopoverPortal`+`PopoverContent`，popover-trigger.vue 直接包装 reka-ui 的 `PopoverTrigger` 并默认 `asChild`），无需 `npx shadcn-vue add`。
- **popover-trigger 包装坑**：用 `Primitive` 手写 trigger 时必须 destructure `forwardRef` 并绑定 `ref="forwardRef"`，否则点击不触发且 vue-tsc 报 `TS6133 unused`（`ref="forwardRef"` 字符串不被识别为使用）；最稳妥做法是直接包装 reka-ui 的 `PopoverTrigger`（内部已处理点击与 ref 转发）。
- **popover 单测**：reka-ui 的 `PopoverContent` 通过 `PopoverPortal` Teleport 到 body，`wrapper.text()` 拿不到弹窗内容；需用 `attachTo: document.body` 挂载、断言 `document.body.textContent`，点击弹窗内按钮用原生 DOM `click()` + `vi.waitFor` 等待。jsdom 下 floating-ui 定位返回 0 不影响弹窗渲染与交互测试。
- **tooltip 组件结构**：reka-ui v2 的 Tooltip 必须 `TooltipProvider` → `TooltipRoot` → (Trigger / Content) 三层，`TooltipProvider` 只提供上下文、不渲染 Root；根组件 `ui/tooltip/tooltip.vue` 需同时包装 Provider+Root，否则 TooltipTrigger/Content 报 `Injection Symbol(TooltipRootContext) not found` 并连带出现 "Component is missing template or render function" 的误导性警告（setup 抛错导致无 render 返回）。
- **tooltip 单测**：reka-ui TooltipContent 渲染 `role="tooltip"`，jsdom 中用 `trigger('pointermove')` 模拟悬停 + `vi.waitFor` 断言 `[role="tooltip"]` 出现；Provider 的 delayDuration 在 root 上配置（200ms 内由 waitFor 轮询覆盖）。
- **Popover 与 Tooltip 共用触发按钮的 PopperRoot 冲突**：PopoverRoot 和 TooltipRoot 各渲染一个 PopperRoot，trigger/content 锚点按「最近的 PopperRoot」注入，且 `TooltipProvider inheritAttrs:false` 会吞掉外层 asChild 传入的事件。两者不能简单嵌套：TooltipTrigger 包 PopoverTrigger 时点击能到按钮、但 PopoverTrigger 锚点注册进 Tooltip 的 PopperRoot → 弹窗定位不可见（真实浏览器才暴露，jsdom 测不出）；反过来 PopoverTrigger 包 Tooltip 时点击被吞、弹窗不打开。**正解**：结构保持 `Popover → Tooltip → TooltipTrigger → PopoverTrigger → 按钮`（点击能到按钮），同时给 `ui-popover-content` 显式传 `:reference="按钮元素"`（模板 ref + `$el` 解析，`reference` 类型为 `ReferenceElement | undefined`，不接受 null）绕过 context 锚点。**另两个坑**：① tooltip 内容会悬浮在弹窗按钮上方拦截点击，弹窗打开时需 `:disabled="弹窗open"` 禁用 tooltip；② **经验**：reka-ui 的定位问题 jsdom 单测测不出来，必须靠 e2e 在真实浏览器点开验证；`getByRole` 的 name 默认是子串匹配，要精确匹配需 `{ exact: true }`。
- **tooltip 在窗口顶部的翻转**：TooltipContent 默认 `side: top`，但触发按钮贴近窗口上缘时空间不足，floating-ui 会自动翻转到底部。要固定在上方需 `side-flip="false"`（该属性不在 TooltipContent 声明 props 中，经 `$attrs` 透传到 PopperContent），**同时必须为 header 顶部预留足够空间**（至少 tooltip 高度 + offset），否则 tooltip 会被窗口上缘裁掉。若 header 高度不能变（会拉高布局），则保持默认自动翻转即可。
- **端测断言**：Vue 组件标签（如 `<ui-card>`）不会出现在最终 DOM 中，端测需断言文本内容或类名，不要断言组件标签。

## WXT / 扩展工程

- **WXT dev 在全新 worktree / clone 下 ENOENT 起不来**：`npm run dev` 构建成功（685ms）后立刻退出，报 `ENOENT: no such file or directory, open '<项目根>/.chrome-dev-profile/chrome-out.log'`，栈顶在 `chrome-launcher.js:151` 的 `Launcher.prepare`。链条：`wxt.config.ts` 用绝对路径固定 `webExt.chromiumProfile` 且开 `keepProfileChanges: true`（为保住「Allow User Scripts」这类每扩展开关）→ `web-ext` 的 `ChromiumExtensionRunner.setupInstance`（`web-ext/lib/extension-runners/chromium.js:282-285`）在该分支**只校验 userDataDir、不创建它** → `chrome-launcher@1.2.0` 的 `Launcher.prepare()` 里 `this.userDataDir = this.userDataDir || this.makeTmpDir()` **只在自己造临时目录时才建目录**，外部传入的路径直接 `openSync(<dir>/chrome-out.log)`。该目录被 `.gitignore` 忽略，**新 clone / 新建 git worktree 必然缺失**（主仓库那份存在，所以在主仓库跑没事）。**已修**：`wxt.config.ts` 顶层 `const chromiumProfileDir = resolve(process.cwd(), '.chrome-dev-profile')` + `mkdirSync(chromiumProfileDir, { recursive: true })`，`webExt.chromiumProfile` 改用该常量。**排查手法（可复用）**：栈顶落在 node_modules 里的 ENOENT，直接读该处源码判断「谁该建目录 / 谁只读不建」，再用 `node -e` 构造最小复现（`new Launcher({ userDataDir }).prepare()`——只调 `prepare()`，不开浏览器、零副作用、秒级出结果），比反复跑整条 `npm run dev` 快且干净。
