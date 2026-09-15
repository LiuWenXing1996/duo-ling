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
| 3. 构建冒烟 | `builder.ts` 用 esbuild-wasm 构建最小项目出产物 | Vitest（wasm 代码按浏览器写，Node 下可能需小改加载方式） | 后置：AI 生成 B 组开工前补（届时构建是链路核心验证器） |
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

- 依赖新增（**开工前与老大确认**）：`vitest`（+ 一次性 `npx playwright install chromium`）；组件测试阶段再加 `@vue/test-utils`、`happy-dom`。`fake-indexeddb` 已在 devDependencies，**无需再装**；`WxtVitest()` 插件已顺带解决 `@` 别名与 `chrome.*` mock，不必手配 vitest alias。
- 测试文件**跟源码同目录**（`*.test.ts`，不进构建产物）；`npm run test` 独立命令，不并入 typecheck；
- E2E 跑 `npm run build` 产物，不依赖 dev server（dev server 仍由老大自管）。

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
