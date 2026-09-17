# 测试方案

> 2026-09-15 与老大收敛定稿。测试体系已落地（层 1–5），进度与状态以本文为准。

## 现状与判断

- 测试体系起步空缺：早期只有 `typecheck` 一道静态关卡。
- **核心判断**：项目价值集中在「纯逻辑 + 消息协议」，不在 UI 自动化。桥接层（`src/lib/`）最易丢「默认值回退 / 入参守卫 / 先校验后落盘 / 无变化就不做」四类类型外语义（AGENTS.md 点名的历史坑），单测是钉死它们的唯一手段。

## 分层方案

| 层级 | 内容 | 工具 | 优先级 |
| --- | --- | --- | --- |
| 1. 纯逻辑单测 | `key-cipher.ts`（加解密往返）、`code-view.ts`、`lib/userscripts/` 解析/校验/兼容逻辑、store 层 | Vitest + `WxtVitest()` 插件（`wxt/testing/vitest-plugin`，内置 `@` 别名解析 / `extensionApiMock` / globals auto-import）+ `fake-indexeddb` + `fakeBrowser`（`wxt/testing/fake-browser`） | **首批** |
| 2. 协议一致性 | SW 端 handlers 表已是 `[K in SwRequest['kind']]` 映射类型，typecheck 已保证全覆盖，无需重复遍历；测试靶心在 **offscreen 端前缀路由**（`offscreen-main.ts` 的 `kind.startsWith('ai:'/'state:')` + `as` 断言那层）、`SW_KIND_PREFIXES` 与 `RuntimeRequest` kind 全集的**归属一致性**（有无 kind 既归 SW 又归 offscreen、或两边都不接）、以及 `{ok, data\|error}` 信封形状 | 表驱动 + 前缀路由覆盖率断言 | **首批**（高且便宜） |
| 3. 构建冒烟 | `builder.ts` 用 esbuild-wasm 构建最小项目出产物 | Vitest（wasm 代码按浏览器写，Node 下可能需小改加载方式） | ✅ **已完成**（2026-09-15，AI 生成 B 组开工前补齐；wasm 加载结论见下节） |
| 4. 组件测试 | 仅改动频繁组件按需（如编辑器抽屉保存/关闭确认） | `@vue/test-utils` + `happy-dom` | ✅ **已开工落地（2026-09-15，ConfirmDialog + UserscriptEditorPanel，见「层 4 实施结论」）** |
| 5. E2E | 扩展整体行为 | Playwright 捆绑 Chromium 无头加载扩展（见下） | 基建先行：fixture + 一条冒烟跑通 |

## E2E 关键结论

2026-09-15 核查 WXT `guide/essentials/e2e-testing` 与 Playwright `docs/chrome-extensions`：

- WXT 官方只推荐 Playwright，扩展路径传 `.output/chrome-mv3`；
- **`channel: 'chromium'`（Playwright 捆绑 Chromium，新 headless 内核）无头模式可加载扩展**——此前「无头加载不了扩展」的实测结论只对本机 branded Chrome 成立；
- **branded Chrome / Edge 已删除 side-load 扩展的命令行 flag**（`--load-extension` 等）→ 本机 Chrome 无论有头无头都加载不了外部扩展，E2E 必须用 Playwright 捆绑的 Chromium，且全程无头（不弹窗）；
- MV3 SW 30 秒空闲挂起由 Playwright 透明处理（同一 Worker 句柄，重启窗口里的 `evaluate()` 自动等待恢复）；
- `page.goto('chrome-extension://<id>/xxx.html')` 是官方姿势，extensionId 从 service worker URL 解析。

## E2E 测试面映射

| 扩展载体 | 测法 |
| --- | --- |
| `workbench.html`（标签页） | `chrome-extension://<id>/workbench.html` 直接打开 → 脚本列表 / 编辑器 / 设置过 UI 断言 |
| SW 行为 | `context.serviceWorkers()` 拿句柄 `evaluate()` → 验证 `userscript:*` 命令面、`offscreen:ensure` 就绪探测 |
| 用户脚本注入 | 本地静态探针页 → 验证 `window.DL` 桥与脚本执行 |
| side panel | 面板页 `chrome-extension://<id>/sidepanel.html` 可加载 + `setOptions` 可配置即可；`sidePanel.open()` 需 user gesture 且无头 Chromium 无浏览器 UI，**改手测覆盖**，不进无头断言 |

## 基础设施

- 依赖：`vitest`（5.0.1）、`fake-indexeddb`、`@playwright/test`、`@vue/test-utils`、`happy-dom` 均已在 devDependencies。`WxtVitest()` 插件已顺带解决 `@` 别名与 `chrome.*` mock，不必手配 vitest alias；E2E 需一次性 `npx playwright install chromium`（国内 CDN 限速，卡死可设 `PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright/` 换镜像）。
- **层 1 已落地（2026-09-15）**：`vitest.config.ts` 用 `import { WxtVitest } from 'wxt/testing/vitest-plugin'`（**具名导出，无 default**）。用例隔离：chrome.storage 系用 `fakeBrowser.reset()`；IndexedDB 系用 `fake-indexeddb/auto` + 用例前后清库；offscreen 写侧（project-write）用 `vi.mock('./builder')` / `vi.mock('./us-git')` 隔离 esbuild-wasm 与 lightning-fs。**层 3 也已落地（2026-09-15，`builder.test.ts` 3 例全绿，见「层 3 实施结论」）**。
- **层 4 已落地（2026-09-15）：vitest projects 双环境分离**——配置从单 `test` 块改为 `test.projects`：
  - **project `logic`（层 1/2/3）**：`environment: 'node'`，include `src/**/*.test.ts`，exclude `src/**/*.component.test.ts`（防止组件测试在 node 环境重复跑挂）；
  - **project `component`（层 4）**：`environment: 'happy-dom'`，include 仅 `src/**/*.component.test.ts`，plugins 额外挂 `@vitejs/plugin-vue`（.vue SFC 编译必需，已入 devDependencies）。
  - **命名约定（强制）**：组件测试文件一律 `*.component.test.ts`，与纯逻辑 `*.test.ts` 并存不冲突；两个 project 的 include/exclude 共同保证互不重复收集。新增组件测试时照此命名，否则会被 logic project 在 node 环境误跑。
  - **⚠️ projects 模式下顶层 `plugins` 不下传给各 project**（实测：WxtVitest 放顶层时 extensionApiMock 失效，`chrome is not defined` 全灭）——**WxtVitest() 必须在每个 project 的 `plugins` 里各放一份**。
  - 新增 devDependencies：`@vue/test-utils`、`happy-dom`（除 `@vitejs/plugin-vue` 原有外无其他新增）。
  - mock `#imports` 的注意点不变（见下）：`vi.mock` 写真实路径；组件自身 import 的 `@/...` 路径可直接 `vi.mock`（@ 别名由 tsconfigPaths 解析）。

### 层 4 实施结论（2026-09-15，22 例全绿）

覆盖组件与靶心（只验交互逻辑，不测样式/像素，组件源码零改动）：

- `ConfirmDialog`（9 例）：确认/取消回调（confirm + `update:open: false`）、默认与自定义按钮文案、danger 形态、description 缺省。
- `UserscriptEditorPanel`（13 例）：加载渲染与失败错误条、dirty 上报（宿主关标签前确认的依据）、保存链路（matches 必填前端拦截 / 构建失败 buildError 行内展示不落盘且 dirty 保持 / 保存成功 config 表单解析 + note 落 updateFiles + dirty 归零 + 备注清空）、构建中禁用保存按钮防双击、草稿恢复（不等才恢复 / draftEquals 相等不提示 / 读草稿失败 best-effort 不挡打开 / 丢弃草稿先用 baseline 重写工作区、失败不动编辑态）。

组件测试写法要点（新写用例前必读）：

- **reka-ui Dialog 系（ConfirmDialog 等）**：内容经 Portal teleport 到 body 且**异步挂载**——`mount` 后 `attachTo: document.body` + `await flushPromises()` 再查 `document.body`；**不能用 test-utils 的 `stubs: { teleport: true }`**（teleport-stub 会吞掉子内容，渲染出来是空的）。
- **mock 粒度**：只 mock IPC 客户端（`@/lib/userscripts/ui-client`，三个 client 全 mock）与重组件子树（FileTree / UserscriptTreeNode）；**CodeMirror 6 用真实实现即可在 happy-dom 下跑**（EditorView 创建/销毁/替换 doc 均正常），不必 mock `@codemirror/*`——mock 它反而会连坐 `@codemirror/lint` 等内部 import。
- `vi.hoisted` + `vi.mock` 工厂组合提 mock 函数（mock 必须在 import 求值前注册）；beforeEach 里 `mockResolvedValue` 重设、clearAllMocks 清调用。
- 卸载路径（onBeforeUnmount flush 草稿）会真的调 `writeDraft`——beforeEach 必须给 `writeDraft.mockResolvedValue(undefined)`，否则 unmount 时报 `Cannot read properties of undefined (reading 'catch')`。
- 编辑器组件卸载即触发草稿 flush：依赖卸载时序的断言放在 `afterEach` unmount 之前完成。
- **mock `#imports` 的注意点**（官方文档）：源码 `import { x } from '#imports'` 在 vitest 预处理时被替换为真实路径（如 `wxt/utils/inject-script`），故 `vi.mock` 必须写**真实路径**而非 `'#imports'`；对照表在 `.wxt/types/imports-module.d.ts`。恢复路径见 [lessons](lessons.md) 的「WXT / 扩展工程」现象族。
- 测试文件**跟源码同目录**（`*.test.ts`，不进构建产物）；`npm run test`（vitest）独立命令，`npm run test:e2e`（playwright）分开；两者都不并入 typecheck。
- E2E 跑 `npm run build` 产物，不依赖 dev server（dev server 仍由老大自管）。

## 层 3 实施结论：esbuild-wasm 在 Node 下的加载方式

`builder.ts` 按浏览器写（wasmURL + 默认 worker 模式，offscreen 宿主），直接在 vitest node 环境跑不起来，三层原因：

1. **Node 入口根本不是 wasm**：esbuild-wasm 无 exports 字段，Node/vitest 解析命中 `lib/main.js`（node 入口）——它不加载 wasm，而是 spawn 原生 esbuild 二进制，且 `initialize({ wasmURL })` 直接抛 `The "wasmURL" option only works in the browser`。真正的 wasm 实现在 `lib/browser.js`（package.json 的 browser 字段）。
2. **worker 模式不可用**：browser.js 默认 worker 模式要 `Blob` + `URL.createObjectURL` + `Worker`（offscreen 有、node 没有）；`worker: false` 的主线程分支才是 node 可走的路，但其 wasm 引导代码会**从 `self` 原型链重建 globalThis**（纯浏览器假设，node 没有 `self`）→ 需 stub `self = globalThis`。
3. **wasmURL fetch 不可用**：主线程分支经 `fetch(wasmURL)` 拿 wasm 字节，node 的 fetch 不支持 `file://` / `chrome-extension://` URL。

**走通姿势**：`initialize({ wasmModule: new WebAssembly.Module(wasm 字节), worker: false })` + `self = globalThis`——wasmModule 直接传编译好的 Module 可同时绕开 fetch 与 `location.href`。测试侧用 `vi.mock('esbuild-wasm')` 拦截 initialize 完成这组转换，`builder.ts` 本体零改动，offscreen（有 Worker，`chrome.runtime.getURL` 可 fetch）行为不变。

详见 `src/lib/userscripts/builder.test.ts` 头注释。

### E2E 已落地（2026-09-15 冒烟开通，6/6 通过）

- 依赖：`@playwright/test`（devDependencies）+ 捆绑 Chromium（一次性 `npx playwright install chromium`，装的是 Chrome for Testing 153.0.8010.12；国内 CDN 限速，下载 ~44 分钟属正常，卡死可设 `PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright/` 换镜像）。
- 命令：`npm run test:e2e`；配置在根 `playwright.config.ts`，用例在 `e2e/`（`extension.ts` fixture + `smoke.spec.ts` 冒烟，workers=1 串行）。
- 加载方式：`chromium.launchPersistentContext(userDataDir, { channel: 'chromium', headless: true, args: ['--disable-extensions-except=<产物>', '--load-extension=<产物>'] })`；extensionId 从 `context.serviceWorkers()` 的 URL 解析；E2E 用一次性临时 profile，跑完即删。
- 冒烟覆盖四条面：SW 命令面（`sw:buildInfo` / `userscript:list`）、`offscreen:ensure` 就绪、userScripts 可用性引导、workbench / sidepanel 页加载渲染、用户脚本注入 + `window.DL` 桥往返（含 `DL.store` 经 SW 落盘）。

#### 实测结论：userScripts 在无头 Chromium 下的可用性

**结论：可用，但必须程序化引导，且引导方式与文档普遍说法不同。** 全流程（无 UI、全无头）：

1. **全局开发者模式**：`chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true })`（chrome://extensions 页的 WebUI 后端，无头下 `page.goto('chrome://extensions/')` 后 `page.evaluate` 可调）。
2. **每扩展「允许运行用户脚本」开关（Chrome ≥138 的门槛）**：**不能走 `developerPrivate.updateExtensionConfiguration({ userScriptsEnabled: true })`** —— Chromium 153 实测报 `Unexpected property: 'userScriptsEnabled'`（该字段不存在，网上流传的 API 姿势过时/错误）。**可行姿势是操作 WebUI DOM**：Playwright 定位器穿透 open shadow DOM，在扩展详情页点「允许运行用户脚本」的 cr-toggle（`extensions-toggle-row`）。注意 `chrome://extensions/?id=<id>` 直达参数**在无头下不触发 SPA 路由切换**（视图停在列表页），必须像真人一样点卡片上的「详情」按钮再等 `extensions-detail-view` 渲染；开关文案跟随系统语言（`locale` 选项不影响 chrome:// 页），匹配用中英双正则。
3. **重启扩展上下文后生效**：开关随 profile 持久化，同一 profile 重新 `launchPersistentContext`，`chrome.userScripts` 即从 `undefined` 变为可用（fixture 先跑 Phase A 引导、再 Phase B 重拉验证，全在 4s 内完成）。

#### 冒烟过程发现并已修复的真 bug

- **esbuild-wasm 被 MV3 默认 CSP 拦截**：`docs/userscript-v2-plan.md` 曾记载「extension_pages 默认 CSP 已含 `'wasm-unsafe-eval'`，无需改 manifest」——实测证伪（Chromium 153 的 offscreen document CSP 就是 `script-src 'self'`，`WebAssembly.instantiateStreaming` 直接报 violates CSP，脚本构建链路必挂）。已在 `wxt.config.ts` manifest 显式声明 `content_security_policy.extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"` 修复（仅放开 wasm 编译、不放开 JS eval；老大 2026-09-15 批准）。**这是 E2E 首跑就抓到的产品级 bug——真机上同样会炸。**

#### fixture 层的两个坑（写用例前必读）

- **SW 不能给自己发 runtime 消息**：`chrome.runtime.sendMessage` 不回环到发送者自身上下文（报 `Receiving end does not exist`）。命令面测试必须从另一个扩展上下文发——fixture 用 `openMessengerPage()` 开一个 sidepanel.html 当发送端，正好复现真实链路（扩展页 → background）。
- 收尾 `context.close()` 偶发挂住：`afterAll` 每步独立 try/catch + 超时兜底（`e2e/smoke.spec.ts`），任何一步卡住不拖垮整个收尾。

## 顺序建议

1️⃣2️⃣ 首批 → E2E 冒烟（fixture + 一条用例跑通）→ 3️⃣ → 4️⃣ 按需。
