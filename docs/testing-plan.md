# 测试方案

> 2026-09-15 与老大收敛定稿。进度与状态以 [todo.md](./todo.md) 的「测试体系搭建」条目为准，本文承载方案全文。

## 现状与判断

- 测试体系空缺：原 Vitest/Playwright 配置随 Electron 归档到 `legacy/`，本工程目前只有 `typecheck` 一道静态关卡。
- **核心判断**：项目价值集中在「纯逻辑 + 消息协议」，不在 UI 自动化。桥接层（`src/lib/`）最易丢「默认值回退 / 入参守卫 / 先校验后落盘 / 无变化就不做」四类类型外语义（AGENTS.md 点名的历史坑），单测是钉死它们的唯一手段。

## 分层方案

| 层级 | 内容 | 工具 | 优先级 |
| --- | --- | --- | --- |
| 1. 纯逻辑单测 | `key-cipher.ts`（加解密往返）、`code-view.ts`、`lib/userscripts/` 解析/校验/兼容逻辑、store 层 | Vitest + `WxtVitest()` 插件（`wxt/testing/vitest-plugin`，内置 `@` 别名解析 / `extensionApiMock` / globals auto-import）+ `fake-indexeddb` + `fakeBrowser`（`wxt/testing/fake-browser`） | **首批** |
| 2. 协议一致性 | SW 端 handlers 表已是 `[K in SwRequest['kind']]` 映射类型，typecheck 已保证全覆盖，无需重复遍历；测试靶心在 **offscreen 端前缀路由**（`offscreen-main.ts` 的 `kind.startsWith('ai:'/'state:')` + `as` 断言那层）、`SW_KIND_PREFIXES` 与 `RuntimeRequest` kind 全集的**归属一致性**（有无 kind 既归 SW 又归 offscreen、或两边都不接）、以及 `{ok, data\|error}` 信封形状 | 表驱动 + 前缀路由覆盖率断言 | **首批**（高且便宜） |
| 3. 构建冒烟 | `builder.ts` 用 esbuild-wasm 构建最小项目出产物 | Vitest（wasm 代码按浏览器写，Node 下可能需小改加载方式） | ✅ **已完成**（2026-09-15，AI 生成 B 组开工前补齐；wasm 加载结论见下节） |
| 4. 组件测试 | 仅改动频繁组件按需（如编辑器抽屉保存/关闭确认） | `@vue/test-utils` + `happy-dom` | 按需，不铺开（UI 是平移件、本体零改动，性价比低） |
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

- 依赖新增（**开工前与老大确认**）：`@playwright/test`（+ 一次性 `npx playwright install chromium`）；组件测试阶段再加 `@vue/test-utils`、`happy-dom`。`fake-indexeddb` 已在 devDependencies，**无需再装**；`WxtVitest()` 插件已顺带解决 `@` 别名与 `chrome.*` mock，不必手配 vitest alias。
- ✅ 测试基建已就位（2026-09-15，随层 3 落地）：`vitest` 已装，`vitest.config.ts`（根目录，`WxtVitest()` 插件 + node 环境 + 只收集 `src/**/*.test.ts`），`npm run test` 独立命令；
- 测试文件**跟源码同目录**（`*.test.ts`，不进构建产物）；`npm run test` 不并入 typecheck；
- E2E 跑 `npm run build` 产物，不依赖 dev server（dev server 仍由老大自管）。

## 层 3 实施结论：esbuild-wasm 在 Node 下的加载方式

`builder.ts` 按浏览器写（wasmURL + 默认 worker 模式，offscreen 宿主），直接在 vitest node 环境跑不起来，三层原因：

1. **Node 入口根本不是 wasm**：esbuild-wasm 无 exports 字段，Node/vitest 解析命中 `lib/main.js`（node 入口）——它不加载 wasm，而是 spawn 原生 esbuild 二进制，且 `initialize({ wasmURL })` 直接抛 `The "wasmURL" option only works in the browser`。真正的 wasm 实现在 `lib/browser.js`（package.json 的 browser 字段）。
2. **worker 模式不可用**：browser.js 默认 worker 模式要 `Blob` + `URL.createObjectURL` + `Worker`（offscreen 有、node 没有）；`worker: false` 的主线程分支才是 node 可走的路，但其 wasm 引导代码会**从 `self` 原型链重建 globalThis**（纯浏览器假设，node 没有 `self`）→ 需 stub `self = globalThis`。
3. **wasmURL fetch 不可用**：主线程分支经 `fetch(wasmURL)` 拿 wasm 字节，node 的 fetch 不支持 `file://` / `chrome-extension://` URL。

**走通姿势**：`initialize({ wasmModule: new WebAssembly.Module(wasm 字节), worker: false })` + `self = globalThis`——wasmModule 直接传编译好的 Module 可同时绕开 fetch 与 `location.href`。测试侧用 `vi.mock('esbuild-wasm')` 拦截 initialize 完成这组转换，`builder.ts` 本体零改动，offscreen（有 Worker，`chrome.runtime.getURL` 可 fetch）行为不变。

详见 `src/lib/userscripts/builder.test.ts` 头注释。

## 顺序建议

1️⃣2️⃣ 首批 → E2E 冒烟（fixture + 一条用例跑通）→ 3️⃣ → 4️⃣ 按需。
