# 测试方案

> 2026-09-15 与老大收敛定稿。进度与状态以 [todo.md](./todo.md) 的「测试体系搭建」条目为准，本文承载方案全文。

## 现状与判断

- 测试体系空缺：原 Vitest/Playwright 配置随 Electron 归档到 `legacy/`，本工程目前只有 `typecheck` 一道静态关卡。
- **核心判断**：项目价值集中在「纯逻辑 + 消息协议」，不在 UI 自动化。桥接层（`src/lib/`）最易丢「默认值回退 / 入参守卫 / 先校验后落盘 / 无变化就不做」四类类型外语义（AGENTS.md 点名的历史坑），单测是钉死它们的唯一手段。

## 分层方案

| 层级 | 内容 | 工具 | 优先级 |
| --- | --- | --- | --- |
| 1. 纯逻辑单测 | `key-cipher.ts`（加解密往返）、`code-view.ts`、`lib/userscripts/` 解析/校验/兼容逻辑、store 层 | Vitest（Node 环境）+ `fake-indexeddb` + WXT `wxt/testing` 的 fakeBrowser | **首批** |
| 2. 协议一致性 | `SwRequest` 命令面 ↔ background handlers ↔ `offscreen-bridge` ↔ `window-api` 三方对齐 | 表驱动测试：遍历命令表断言各端实现存在 | **首批**（高且便宜） |
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
| side panel | 从 SW `evaluate` 调 `chrome.sidePanel.open()` → 检查目标 |

## 基础设施

- 依赖新增（**开工前与老大确认**）：`vitest`、`fake-indexeddb`、`@playwright/test`（+ 一次性 `npx playwright install chromium`）；组件测试阶段再加 `@vue/test-utils`、`happy-dom`；
- 测试文件**跟源码同目录**（`*.test.ts`，不进构建产物）；`npm run test` 独立命令，不并入 typecheck；
- E2E 跑 `npm run build` 产物，不依赖 dev server（dev server 仍由老大自管）。

## 顺序建议

1️⃣2️⃣ 首批 → E2E 冒烟（fixture + 一条用例跑通）→ 3️⃣ → 4️⃣ 按需。
