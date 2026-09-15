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

- 依赖新增（**开工前与老大确认**）：`vitest`、`@playwright/test`（+ 一次性 `npx playwright install chromium`）；组件测试阶段再加 `@vue/test-utils`、`happy-dom`。`fake-indexeddb` 已在 devDependencies，**无需再装**；`WxtVitest()` 插件已顺带解决 `@` 别名与 `chrome.*` mock，不必手配 vitest alias。
- **层1已落地（2026-09-15）**：`vitest` 已装（5.0.1），`vitest.config.ts` 用 `import { WxtVitest } from 'wxt/testing/vitest-plugin'`（**具名导出，无 default**），include 收窄到 `src/**/*.test.ts`（默认 include 会扫到 legacy 旧 spec）。用例隔离：chrome.storage 系用 `fakeBrowser.reset()`；IndexedDB 系用 `fake-indexeddb/auto` + 用例前后清库；offscreen 写侧（project-write）用 `vi.mock('./builder')` / `vi.mock('./us-git')` 隔离 esbuild-wasm 与 lightning-fs。
- **mock `#imports` 的注意点**（官方文档）：源码 `import { x } from '#imports'` 在 vitest 预处理时被替换为真实路径（如 `wxt/utils/inject-script`），故 `vi.mock` 必须写**真实路径**而非 `'#imports'`；对照表在 `.wxt/types/imports-module.d.ts`（缺失先跑 `wxt prepare`）。
- 测试文件**跟源码同目录**（`*.test.ts`，不进构建产物）；`npm run test` 独立命令，不并入 typecheck；
- E2E 跑 `npm run build` 产物，不依赖 dev server（dev server 仍由老大自管）。

## 顺序建议

1️⃣2️⃣ 首批 → E2E 冒烟（fixture + 一条用例跑通）→ 3️⃣ → 4️⃣ 按需。
