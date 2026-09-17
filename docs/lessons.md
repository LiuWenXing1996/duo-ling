# 踩坑记录

> 经验记录策略（随项目走）：所有项目经验只记录在本文件（及项目 docs/ 下），不写入 IDE 的 project_memory。经验一律随仓库分发、可被 git 跟踪；协作者或 AI 在开始任务前应阅读本文件获取历史经验。

> 条目以代码现状为准；文件:行号可能随重构漂移，以符号名为准定位。

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

- **缺本机生成目录/生成物 → 同根因族（已踩两次）**。判据见 [conventions](dev-log/conventions.md)。
  - **① `.chrome-dev-profile/` 缺 → `npm run dev` ENOENT**：链条：`wxt.config.ts` 固定 `webExt.chromiumProfile` → `web-ext` `setupInstance`**只校验不创建** → `chrome-launcher` `Launcher.prepare()` **只自造临时目录时才建目录**，外部 `openSync` 报错。
  - **② `.wxt/` 缺 → typecheck/test 假红**：`typecheck` 报 `TS5083: Cannot read file '.wxt/tsconfig.json'`；`test` 报 `Transform failed`（vitest）。成因：缺 base `skipLibCheck`/`target`/`lib`，112 条 node_modules `.d.ts` 连坐。
  - **谁负责生成 / 本仓口径**：`.wxt/` 由 `npx wxt prepare` 生成（现 `postinstall` 自动跑；装依赖只用 `npm install`）；`.chrome-dev-profile/` 由 `wxt.config.ts` 顶层 `mkdirSync` 建。
  - **反例**：`--omit=dev` 致 wxt 缺 `command not found` 中断；`--ignore-scripts` 跳过 postinstall 致 `.wxt/` 不生成、必红；`wxt prepare` 非零退出让 `npm install` 整体失败。
  - **恢复 / 迁移**：手动删 `.wxt/` 或老 worktree 缺时，跑 `npx wxt prepare`（或 `npm install`）重建。
  - **排查手法（可复用）**：栈顶落在 node_modules 里的 ENOENT，直接读该处源码判断「谁该建目录 / 谁只读不建」，再用 `node -e` 构造最小复现（`new Launcher({ userDataDir }).prepare()`——只调 `prepare()`，不开浏览器、零副作用、秒级出结果），比反复跑整条 `npm run dev` 快且干净。
- **`chrome.userScripts.register` 没有 `persistAcrossSessions` 字段（2026-09-17 踩到）**：那是 `contentScripts` API 的属性；userScripts 注册传了直接报 `Unexpected property: 'persistAcrossSessions'` 且整个 register 拒收。userScripts 注册本身即跨 SW 会话持久，只有扩展更新后需重注册（走 recoverOnUpdate）。`@types/chrome` 对此报错无提示（字段缺了类型层反而安全），但手写交叉类型补齐会绕过这层保护——**不要给平台 API 类型手写「补齐」扩展**，运行时会用 TypeError 还债。

## Vitest / 测试基建（层 2 协议一致性，2026-09-15 落地时踩到）
- **vitest 5 与本项目 vite 8 兼容**（peer `^6 || ^7 || ^8`），直接 `npm i -D vitest` 即可；`vitest.config.ts` 只需 `plugins: [WxtVitest()]` + `test.include: ['src/**/*.test.ts']`。`fake-indexeddb` 虽在 devDependencies，协议测试用 mock 层挡住了 IDB 依赖，暂未用到。
- **任何 import 链会带到 `us-fs.ts` 的测试都必须 `vi.mock` 掉它（连带 `us-git`）**：`us-fs.ts` 模块顶层 `new LightningFS('duoling')`，Node 下无 `indexedDB` 时构造出的实例在异步 init 阶段抛未处理 rejection（能直接炸掉 vitest 进程，且报错点在 `@isomorphic-git/idb-keyval` 内部、与业务代码无关，极难定位）。同理 mock `builder` 可避免 import 链拉进 esbuild-wasm（13MB，纯拖慢收集）。
- **import 入口文件是安全的**：`defineBackground()` 只包装不执行（返回 `{ main }`），offscreen-main 的启动自证（announceReady / refreshActiveProfile / reconcileFs）全部尽力而为 + catch——协议测试可直接 `import { SW_KIND_PREFIXES } from '@/entrypoints/background'`、动态 `import('@/entrypoints/app/offscreen-main')`。`#imports` 虚拟模块在 WxtVitest 下由 unimport 插件解析，无需手配。
- **端到端测 offscreen 的 onMessage 处理器不用捕获监听器**：`fakeBrowser.runtime.sendMessage(msg)` 会触发全部已注册监听器——监听器 `return true` 并 `sendResponse` → promise resolve 该包；`return false` 让路 → resolve `undefined`；无任何监听器 → throw「No listeners available」。信封测试全靠它。注意 fakeBrowser 事件对象无 `resetState` 之外的监听器枚举口，**别在 import offscreen-main 之后调 `fakeBrowser.runtime.resetState()`**（会把监听器清空）。
- **`vi.clearAllMocks()` 只清调用记录、不清 mock 实现**（`mockResolvedValue` 会残留到后续用例）——要重置实现用 `mockReset` / `mockResolvedValue(undefined)` 显式覆盖，或改用 `vi.restoreAllMocks`。
- **协议一致性测试的穷尽性三件套**（新增 RuntimeRequest kind 时不改测试就会挂）：① `as const satisfies readonly RuntimeRequest['kind'][]` 防「表里混进不存在的 kind」；② `Exclude<RuntimeRequest['kind'], (typeof 表)[number]> extends never` 的类型闸防「union 新增 kind 漏登记」（typecheck 阶段即报错）；③ 运行时 `it.each` + 归属 XOR 断言。`Record<Kind, Case>` 键控表可以让「少一个 case」直接变成编译错误。
