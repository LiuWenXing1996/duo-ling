# AI Agent 协作指南

本文档面向在本仓库内工作的 AI 代理（及协作者），约定任务执行方式与注意事项。

## 项目速览

- **架构**：electron-vite 三进程结构（main / preload / renderer）
- **渲染层**：Vue 3.5 + TypeScript，`@` 别名指向 `src/renderer/src`
- **UI**：shadcn-vue（`src/renderer/src/components/ui/`），基于 reka-ui
- **样式**：Tailwind CSS v4（CSS-first）+ Less
- **测试**：单测 Vitest（`src/**/*.spec.ts`），端测 Playwright（`e2e/`）

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` | 开发模式（热更新 + 自动打开 Electron） |
| `pnpm build` | 构建产物到 `out/` |
| `pnpm typecheck` | node 与 web 两侧类型检查 |
| `pnpm test` | 运行 Vitest 单测 |
| `pnpm test:e2e` | 构建后运行 Playwright 端测 |
| `pnpm build:mac/win/linux` | electron-builder 打包 |

## 硬性约定

1. **文件名一律 kebab-case**（如 `tool-flow.vue`、`api-client.ts`），禁止 PascalCase / camelCase 文件名。
2. **模板中使用组件一律 kebab-case**（如 `<ui-button>`、`<ui-card-title>`）。导入时用别名对齐：`import { Button as UiButton } from '@/components/ui/button'`。
3. **props/emits 在脚本中用 camelCase 声明，模板中用 kebab-case 绑定**（如 `:user-id`）。
4. **IPC 约定**：
   - 只在 `src/main/` 注册 `ipcMain.handle`，通过 `src/preload/index.ts` 的 `api` 对象暴露到渲染层；
   - IPC 返回值只允许基本类型（string/number/boolean/array/object）构成的纯字面量，禁止函数、Symbol、类实例、循环引用；
   - 新增通道后同步更新 `src/preload/index.d.ts` 中的 `Window.api` 类型。
5. **安全**：渲染进程保持 `contextIsolation`，不要关闭 `sandbox`，外部链接一律交给 `shell.openExternal`。
6. **shadcn-vue 组件**：优先使用 `npx shadcn-vue@latest add <组件名>` 增量添加；若手动创建，需保持 `components.json` 别名（`@/components/ui`）与 `index.ts` 重导出结构一致。

## 隐私与脱敏规则（强制）

> 重要：**凡写入项目文档/项目文件的任何内容，落盘前必须先做隐私扫描，一律脱敏。** 本项目文档会随 git 仓库分发，隐私信息一旦进入 git 历史即不可逆。

必须脱敏的信息：

- **本机绝对路径** → 相对化/占位符（如 `<项目根>`、`<userData>`、`<用户配置目录>`）
- **用户名、邮箱、个人 ID** → `<用户名>` 等占位符
- **token、密码、API key 等凭据** → 只写"在哪个配置项中配置"，**不写值**
- **内网 IP / 主机名** → `<内网IP>` 等占位符
- **带账号密码的代理/镜像 URL** → 隐藏凭据部分
- **报错日志** → 保留错误类型、报错行号、项目内相对路径等诊断信息，删除路径/URL/环境变量中的隐私字段

不属于隐私、可原样记录：

- 项目内相对路径（`src/`、`out/`、`node_modules/` 等）
- 错误类型与信息、依赖名称与版本、架构决策、命令本身

## 踩坑记录

> 经验记录策略（随项目走）：所有项目经验只记录在本文件（及项目 docs/ 下），不写入 IDE 的 project_memory。经验一律随仓库分发、可被 git 跟踪；协作者或 AI 在开始任务前应阅读本文件获取历史经验。

- **Vite 版本**：electron-vite 5 的 peerDependencies 仅支持 `vite ^5 || ^6 || ^7`，**禁止升级到 Vite 8**（锁定 `^7.3.6`）。
- **pnpm 11 配置位置**：pnpm 11 只从 `.npmrc` 读取 auth/registry，其余设置（`nodeLinker`、`allowBuilds`）必须在 `pnpm-workspace.yaml`；构建授权用 `allowBuilds: { 包名: true }` 映射（旧 `pnpm.onlyBuiltDependencies` 已废弃）。若未授权，`pnpm install` 报 `ERR_PNPM_IGNORED_BUILDS` 且 electron 二进制不会下载。
- **electron 二进制下载**：国内网络需在 `.npmrc` 配置 `electron_mirror=https://npmmirror.com/mirrors/electron/`；若下载被卡住，手动执行 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js`。
- **pnpm lockfile**：`pnpm install` 默认 frozen-lockfile，修改 package.json 依赖后需 `pnpm install --no-frozen-lockfile`。
- **图标库**：`lucide-vue-next` 已弃用，使用 `@lucide/vue`。
- **废弃 @types 干扰类型检查**：`@types/minimatch` 等废弃包会触发 `TS2688`，渲染层 `tsconfig.web.json` 已设 `"types": []` 避免隐式引入。
- **端测 userData 隔离**：Playwright Electron 模式会写系统默认 userData（`~/Library/Application Support/<name>`），可能被权限拦截；主进程支持 `DUO_LING_USER_DATA_DIR` 环境变量覆盖，端测中指向 `test-results/user-data`。
- **端测断言**：Vue 组件标签（如 `<ui-card>`）不会出现在最终 DOM 中，端测需断言文本内容或类名，不要断言组件标签。
- **手动添加 popover 组件**：reka-ui v2 已提供完整 Popover 组件，按现有 ui 组件结构手动创建 `ui/popover/`（popover.vue 用 `useForwardPropsEmits` 包装 `PopoverRoot`，popover-content.vue 用 `PopoverPortal`+`PopoverContent`，popover-trigger.vue 直接包装 reka-ui 的 `PopoverTrigger` 并默认 `asChild`），无需 `npx shadcn-vue add`。
- **popover-trigger 包装坑**：用 `Primitive` 手写 trigger 时必须 destructure `forwardRef` 并绑定 `ref="forwardRef"`，否则点击不触发且 vue-tsc 报 `TS6133 unused`（`ref="forwardRef"` 字符串不被识别为使用）；最稳妥做法是直接包装 reka-ui 的 `PopoverTrigger`（内部已处理点击与 ref 转发）。
- **popover 单测**：reka-ui 的 `PopoverContent` 通过 `PopoverPortal` Teleport 到 body，`wrapper.text()` 拿不到弹窗内容；需用 `attachTo: document.body` 挂载、断言 `document.body.textContent`，点击弹窗内按钮用原生 DOM `click()` + `vi.waitFor` 等待。jsdom 下 floating-ui 定位返回 0 不影响弹窗渲染与交互测试。
- **tooltip 组件结构**：reka-ui v2 的 Tooltip 必须 `TooltipProvider` → `TooltipRoot` → (Trigger / Content) 三层，`TooltipProvider` 只提供上下文、不渲染 Root；根组件 `ui/tooltip/tooltip.vue` 需同时包装 Provider+Root，否则 TooltipTrigger/Content 报 `Injection Symbol(TooltipRootContext) not found` 并连带出现 "Component is missing template or render function" 的误导性警告（setup 抛错导致无 render 返回）。
- **tooltip 单测**：reka-ui TooltipContent 渲染 `role="tooltip"`，jsdom 中用 `trigger('pointermove')` 模拟悬停 + `vi.waitFor` 断言 `[role="tooltip"]` 出现；Provider 的 delayDuration 在 root 上配置（200ms 内由 waitFor 轮询覆盖）。
- **Popover 与 Tooltip 嵌套的 PopperRoot 冲突**：PopoverRoot 和 TooltipRoot 各渲染一个 PopperRoot，trigger/content 的锚点按「最近的 PopperRoot」注入。若把 Popover 包在 Tooltip 内部（TooltipRoot → PopoverRoot → TooltipTrigger），TooltipTrigger 锚点注册进 Popover 的 PopperRoot，而 TooltipContent 从 Tooltip 的 PopperRoot 取锚点 → 锚点丢失，tooltip 悬停不显示（浮层定位无参照）。**正确嵌套顺序：Popover 在外、Tooltip 在内**（`Popover → Tooltip → TooltipTrigger(PopoverTrigger(Button))` + `PopoverContent`），使各 trigger/content 归属同一 PopperRoot。
- **tooltip 在窗口顶部的翻转**：TooltipContent 默认 `side: top`，但触发按钮贴近窗口上缘时空间不足，floating-ui 会自动翻转到底部。要固定在上方需 `side-flip="false"`（该属性不在 TooltipContent 声明 props 中，经 `$attrs` 透传到 PopperContent），**同时必须为 header 顶部预留足够空间**（至少 tooltip 高度 + offset），否则 tooltip 会被窗口上缘裁掉。若 header 高度不能变（会拉高布局），则保持默认自动翻转即可。
- **electron-store v11+ 是 ESM-only**：主进程已切换为 ESM（`package.json` 设 `"type": "module"`），ESM-only 依赖可直接 import（electron-store 保持 externalize 即可）。若主进程仍是 CJS，需把 ESM-only 依赖排除出 `externalizeDepsPlugin` 打包进产物，否则 `ERR_REQUIRE_ESM`。
- **主进程切 ESM 要点**（electron-vite 自动识别 `"type": "module"`）：
  - 主进程产物为 `out/main/index.js`（`type: module` 下 `.js` 即 ESM），`package.json` 的 `main` 仍指向它，**不要改成 `.mjs`**；
  - preload 产物为 `out/preload/index.mjs`（Electron 要求 ESM preload 用 `.mjs` 扩展名），主进程里 preload 路径要同步改为 `.mjs`；
  - ESM preload 要求 `sandbox: false`（本项目已满足）；
  - 主进程代码里的 `__dirname` 改为 `import.meta.dirname`（Electron 43 / Node 22 原生支持）。
- **主进程 store 惰性初始化**：electron-store 实例若在模块顶层创建，会早于 `app.setPath('userData')`（含 `DUO_LING_USER_DATA_DIR` 覆盖）执行而拿到错误目录。做法：store 模块导出业务函数（`listTasks/saveTasks`），内部用 `store ??= new Store(...)` 惰性创建，首次调用发生在 IPC 处理时（app 已就绪）。
- **node-llama-cpp 集成**：
  - 安装需在 `pnpm-workspace.yaml` 的 `allowBuilds` 加 `node-llama-cpp: true`；原生二进制在独立的平台包 `@node-llama-cpp/<平台>-<gpu>/bins/`（含 `llama-addon.node` 与 dylib/so），electron-builder 需 `asarUnpack: ['**/node_modules/@node-llama-cpp/**']`；
  - 该包是 ESM 且含顶层 await，CJS `require()` 会报 `ERR_REQUIRE_ASYNC_MODULE`，ESM 主进程 `import` 正常；
  - 验证二进制是否就绪：`node --input-type=module -e "import {getLlama} from 'node-llama-cpp'; const l = await getLlama(); console.log(l.gpu)"`；
  - 模型目录约定：开发模式 `<项目根>/llm-models/`，打包后 `<userData>/models`（`app.getAppPath()` 在开发模式即项目根）；
  - `llama.gpu` 类型为 `LlamaGpuType`（可能为 boolean），写入 IPC 状态前需转成 string 或过滤。
- **e2e 勿在模型加载中关闭应用**：聊天面板挂载即自动触发 `llama:init`（加载 1.15GB 模型是异步的），若 e2e 断言完直接 `close()`，会中途终止 llama.cpp 原生初始化 → 进程 `SIGABRT`，macOS 弹「Electron 意外退出」崩溃框。e2e 必须先轮询 `llama:status` 直到非 loading（`expect.poll` 等到 `ready`）再关闭；这一步同时补上了"模型能否成功加载"的端测覆盖。判断崩溃是否由它引起：看 `~/Library/Logs/DiagnosticReports/` 下 Electron 崩溃报告的 `signal: SIGABRT` 且栈含 llama/ggml 帧。
- **开发环境 CDP 远程调试**：主进程在 `is.dev` 时自动 `app.commandLine.appendSwitch('remote-debugging-port', '9222')`，`pnpm dev` 即可用 `chrome://inspect` 或 `chromium.connectOverCDP('http://127.0.0.1:9222')` 远程调试渲染进程（Playwright 已安装，可直接写脚本 evaluate）。主进程另有常驻 IPC `window:getBounds`（preload 暴露 `window.api.window.getBounds()`），配合 CDP 可随时读窗口坐标。若跑构建产物做同样操作，启动时手动加 `--remote-debugging-port=9222` 即可。AppleScript(System Events) 读窗口位置会被 macOS 辅助功能权限拦截（-1743），优先用 CDP + IPC。
- **开发环境窗口默认位置（藏左下角）**：dev 时窗口主体藏在屏幕外，只露右上角一小块（右上角位于工作区左下角右上方 `DEV_CORNER_X/Y`，默认 100/100），避免启动弹窗打断操作。**坑①**：不要在 `BrowserWindow` 构造参数里传屏外 x/y，macOS 会把构造时的屏外坐标强制拉回屏内（如 `x=-1022` 会落地为 `x=0` 贴角）；**坑②**：手动拖拽可以把窗口拖到大部分屏外（此时 `getBounds()` 会返回屏幕外坐标），但这些坐标无法通过构造参数复现。**正解**：构造不传位置 → `ready-to-show` 后 `setOpacity(0)` + `showInactive()`（不抢焦点）→ `setBounds(屏外)` → `setImmediate` 恢复不透明，macOS 不会钳制显示后的 setBounds。窗口坐标实测：CDP 连上后读 `screenX/screenY` 或 `await window.api.window.getBounds()`（在 evaluate 里直接返回 Promise 会得到空对象，须用 `async () => await ...` 包一层）。

## 工作流

1. 修改前先阅读相关文件，理解现有结构再动手。
2. 完成代码后必须运行 `pnpm typecheck` 与 `pnpm test` 验证，全部通过再交付。
3. **解决 bug 或完成需求后，尽量补充对应的单测与端测**，覆盖本次改动涉及的行为。
4. **过时的单测/端测要及时清理**：功能变更后同步更新或删除不再反映真实行为的测试，避免僵尸测试误导排查。
5. 涉及新增依赖、修改构建配置或改变环境的行为，先与用户确认再执行。
6. 不自动启动 `pnpm dev` 等常驻服务；如需要，告知用户命令由用户自行运行。
