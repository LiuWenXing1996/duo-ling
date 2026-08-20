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
7. **脚本分类**：一次性补丁/迁移脚本放 `tmp/`（已 gitignore，不入库、用完即删）；可复用探针/调试工具放 `scripts/`，文件名以 `probe-` 开头（kebab-case），用 **TS 编写**（已纳入 `tsconfig.node.json`，`pnpm typecheck:node` 会检查），**不挂 npm script**，用 Node 22.6+ 直接 `node scripts/probe-<名称>.ts` 运行（type stripping，无需编译）；探针产生的输出（坐标、日志等）写 `tmp/`。分层：`probe-eval.ts` 是通用执行器（传表达式现查，临时排查用，不写文件）；高频固定能力沉淀为专用探针（如 `probe-window-bounds.ts`），复用走专用脚本。
8. **测试覆盖（强制）**：凡是**需求改动**或 **bug 修复**，必须编写对应测试用例——**单测优先**（组件逻辑/工具函数），**端测尽量补充**（涉及跨进程链路、持久化、真实浏览器行为时必须有）。修改已有需求后跑旧用例，失败时需判断是「旧用例过期（应更新/删除）」还是「真实回归（应修 bug）」，不得静默绕过。

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

## 调试方法论

> 接到 bug 后，**先判断 bug 在哪一层，再选最直接的工具**，不要默认只做静态分析或写探针。

| bug 层级 | 首选工具 | 说明 |
| --- | --- | --- |
| 渲染层（界面/交互/状态） | **CDP 复现 + Runtime.evaluate 观察** | dev 模式已开 9222 端口；直接读组件状态/DOM 真实文本（如某元素的 `textContent`），比读源码猜快 |
| IPC 层（数据跨进程流转） | 主进程日志 + 单测 | 在 handler 边界打点，确认数据形状 |
| 持久化/落盘 | 一次性探针读磁盘 JSON | 以落盘数据事实为准（放 `tmp/`，用完即删） |
| 主进程/模型 | 主进程日志 + node 调试端口 | 断点看调用栈，或 `chrome://inspect` |

CDP 的边界：需要应用在 dev 模式运行；只覆盖渲染进程；生成类时序 bug 需真实模型复现。

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
- **Popover 与 Tooltip 共用触发按钮的 PopperRoot 冲突**：PopoverRoot 和 TooltipRoot 各渲染一个 PopperRoot，trigger/content 锚点按「最近的 PopperRoot」注入，且 `TooltipProvider inheritAttrs:false` 会吞掉外层 asChild 传入的事件。两者不能简单嵌套：TooltipTrigger 包 PopoverTrigger 时点击能到按钮、但 PopoverTrigger 锚点注册进 Tooltip 的 PopperRoot → 弹窗定位不可见（真实浏览器才暴露，jsdom 测不出）；反过来 PopoverTrigger 包 Tooltip 时点击被吞、弹窗不打开。**正解**：结构保持 `Popover → Tooltip → TooltipTrigger → PopoverTrigger → 按钮`（点击能到按钮），同时给 `ui-popover-content` 显式传 `:reference="按钮元素"`（模板 ref + `$el` 解析，`reference` 类型为 `ReferenceElement | undefined`，不接受 null）绕过 context 锚点。**另两个坑**：① tooltip 内容会悬浮在弹窗按钮上方拦截点击，弹窗打开时需 `:disabled="弹窗open"` 禁用 tooltip；② **经验**：reka-ui 的定位问题 jsdom 单测测不出来，必须靠 e2e 在真实浏览器点开验证；`getByRole` 的 name 默认是子串匹配，要精确匹配需 `{ exact: true }`。
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
  - 模型目录约定：优先读取全局环境变量 `$LLM_MODELS`（未设置或该目录下无模型时回退），其次开发模式 `<项目根>/llm-models/`、打包后 `<userData>/models`（`app.getAppPath()` 在开发模式即项目根）；解析逻辑集中在 `src/main/model-path.ts`（纯函数，已配单测）；
  - `llama.gpu` 类型为 `LlamaGpuType`（可能为 boolean），写入 IPC 状态前需转成 string 或过滤。
- **e2e 勿在模型加载中关闭应用**：聊天面板挂载即自动触发 `llama:init`（加载 1.15GB 模型是异步的），若 e2e 断言完直接 `close()`，会中途终止 llama.cpp 原生初始化 → 进程 `SIGABRT`，macOS 弹「Electron 意外退出」崩溃框。e2e 必须先轮询 `llama:status` 直到非 loading（`expect.poll` 等到 `ready`）再关闭；这一步同时补上了"模型能否成功加载"的端测覆盖。判断崩溃是否由它引起：看 `~/Library/Logs/DiagnosticReports/` 下 Electron 崩溃报告的 `signal: SIGABRT` 且栈含 llama/ggml 帧。
- **开发环境 CDP 远程调试**：主进程在 `is.dev` 时自动 `app.commandLine.appendSwitch('remote-debugging-port', '9222')`，`pnpm dev` 即可用 `chrome://inspect` 或 `chromium.connectOverCDP('http://127.0.0.1:9222')` 远程调试渲染进程（Playwright 已安装，可直接写脚本 evaluate）。主进程另有常驻 IPC `window:getBounds`（preload 暴露 `window.api.window.getBounds()`），配合 CDP 可随时读窗口坐标。若跑构建产物做同样操作，启动时手动加 `--remote-debugging-port=9222` 即可。AppleScript(System Events) 读窗口位置会被 macOS 辅助功能权限拦截（-1743），优先用 CDP + IPC。
- **开发环境窗口默认位置（藏左下角）**：dev 时窗口主体藏在屏幕外，只露右上角一小块（右上角位于工作区左下角右上方 `DEV_CORNER_X/Y`，默认 100/100），避免启动弹窗打断操作。**坑①**：不要在 `BrowserWindow` 构造参数里传屏外 x/y，macOS 会把构造时的屏外坐标强制拉回屏内（如 `x=-1022` 会落地为 `x=0` 贴角）；**坑②**：手动拖拽可以把窗口拖到大部分屏外（此时 `getBounds()` 会返回屏幕外坐标），但这些坐标无法通过构造参数复现。**正解**：构造不传位置 → `ready-to-show` 后 `setOpacity(0)` + `showInactive()`（不抢焦点）→ `setBounds(屏外)` → `setImmediate` 恢复不透明，macOS 不会钳制显示后的 setBounds。窗口坐标实测：CDP 连上后读 `screenX/screenY` 或 `await window.api.window.getBounds()`（在 evaluate 里直接返回 Promise 会得到空对象，须用 `async () => await ...` 包一层）。
- **AI 终端环境跑 dev 需禁沙箱**：在无 TCC 权限的 AI 终端里直接 `pnpm dev` 启动 Electron，会报 `sandbox initialization failed: Operation not permitted`，GPU/网络子进程反复崩溃，最终 `GPU process isn't usable. Goodbye.` FATAL 退出。**正解**：`ELECTRON_DISABLE_SANDBOX=1 pnpm dev -- --no-sandbox`（与 e2e `electron.launch` 已带的 `--no-sandbox` 同理）。普通用户终端有 TCC 权限，无需此参数。
- **IPC 传参禁止 Vue 响应式 Proxy**：`ipcRenderer.invoke` 用结构化克隆序列化参数，Vue 的 `ref`/`reactive` 数组是 Proxy，直接传给主进程会抛 `An object could not be cloned`（错误会被渲染层 `try/catch` 静默吞掉，表现为**持久化从未生效**——删除全部后 UI 清空但 store 未写，旧数据残留、再创建新会话时不断叠加）。**修法**：发送前 `JSON.parse(JSON.stringify(x))` 转纯字面量。单测 mock 掉 IPC 测不出此问题，必须在 e2e 里**回读 store 断言持久化结果**（本项目的 e2e 在删除全部后 `listTasks()` 断言空数组，正是靠它抓到该 bug）。
- **生成中途退出会崩溃**：模型回复生成中（llama 的 NAPI AsyncWorker 在跑）直接退出应用（Cmd+Q），Node 环境清理（`RunCleanup`）时工作线程完成并 `ThrowAsJavaScriptException` → ggml 未捕获异常处理 `abort()` → SIGABRT 崩溃。**修法**：`app.on('before-quit')` 里若正在生成则 `preventDefault()` → `abort()` → 轮询等生成停止（上限 2s）→ 再 `app.quit()`；`chatAbortController` 提为模块级并暴露 `isGenerating()`/`abortCurrentGeneration()`。崩溃特征：macOS 崩溃报告 `signal: SIGABRT`，栈含 `node::Environment::RunCleanup` → `Napi::AsyncWorker::OnWorkComplete` → `ggml_uncaught_exception`。
- **对话功能（node-llama-cpp v3）要点**：
  - **MiniCPM 的 GGUF 自带 Jinja 模板与 `JinjaTemplateChatWrapper` 不兼容**：`chatWrapper: 'auto'` 检测到的 Jinja wrapper 渲染出的历史是空的（消息内容全丢，只有空 `<|im_start|>user` 标签），表现为多轮对话完全失忆。其模板本质是 ChatML 格式，**改用 `new ChatMLChatWrapper()` 实例**（注意传字符串 `'chatML'` 不会自动解析，会报 `supportsSystemMessages` undefined）。
  - **`prompt()` 默认 maxTokens 很小**，回复会被截断；需显式传 `maxTokens`（如 2048）。
  - **v3 的 `ChatHistoryItem` 是 `{ type: 'user', text }` / `{ type: 'model', response: [...] }`**，不是 v2 的 `{ role, text }`；`setChatHistory` 会整体替换历史。
  - 创建会话需要 `model.createContext()` → `context.getSequence()` → `new LlamaChatSession({ contextSequence, chatWrapper, systemPrompt })`（`model.createChatSession` 在 v3.20 不存在）。
  - **MiniCPM5-1B 是推理模型**，输出 `<think>...</think>` 思考块；UI 展示时用正则剥离，流式期间未闭合时显示"思考中…"。
  - 流式 IPC 模式：`chat:send` 里 `event.sender.send('chat:event', ...)` 推送 token/done/aborted/error，`AbortController` 中止，preload 用单例 listener 暴露 `onEvent/offEvent`（contextBridge 支持回调参数透传）。
  - 持久化用独立 electron-store 文件（`chat.json`，`sessions[taskId]` 数组），消息带 `{ id, role, content, createdAt }`；Schema 校验用 `additionalProperties` 校验会话字典。
- **工具标准**（`src/main/tools/`）：
  - 每个工具 = `{ name, description, inputSchema, outputSchema, run }`，输入/输出均为 JS object（空 = `z.object({})`），两侧都用 zod 约束；`run` 同步/异步皆可；
  - 统一入口 `runTool(name, rawInput)`：`inputSchema.safeParse` → `run` → `outputSchema.safeParse`，任何失败返回 `{ ok: false, error }` 不抛异常；注册表 `registerTool` 禁止重名；
  - 新增工具：建 `src/main/tools/tool-<名>.ts` 并在 `index.ts` 的 `registerBuiltinTools()` 注册；
  - IPC 只暴露两个通用通道：`tools:list`（元数据 + 输入 JSON Schema）与 `tools:run`，preload 暴露 `api.tools`；UI 模式靠 `inputJsonSchema` 自动生成表单（`schema-form.vue` 递归渲染 string/number/integer/boolean/enum/array/object），无 UI 模式在主进程直接 `runTool`；
  - **zod v4 自带 `schema.toJSONSchema()`**（draft 2020-12），不要用 `zod-to-json-schema`（3.25.2 与 zod v4 运行时不兼容，转换结果字段全丢）；zod v4 的 `_def` 结构大改（无 `typeName`，`def.type` 为字符串标识、object 的 shape 是对象、description 是公开 getter）。

## 工作流

1. 修改前先阅读相关文件，理解现有结构再动手。
2. 完成代码后必须运行 `pnpm typecheck` 与 `pnpm test` 验证，全部通过再交付。
3. **解决 bug 或完成需求后，尽量补充对应的单测与端测**，覆盖本次改动涉及的行为。
4. **过时的单测/端测要及时清理**：功能变更后同步更新或删除不再反映真实行为的测试，避免僵尸测试误导排查。
5. 涉及新增依赖、修改构建配置或改变环境的行为，先与用户确认再执行。
