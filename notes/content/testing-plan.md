# 测试方案

> 一句话：单测与端测各自的命令、写法、如何 mock、覆盖范围与注意事项。  
> 源文档：[docs/testing-plan.md](../../docs/testing-plan.md)

## 现状

### 单测

#### 命令

- `npm run test`。

#### 写法

- **纯逻辑**
  - `src/**/*.test.ts`
- **UI 组件**
  - `src/**/*.component.test.ts`

#### 如何 mock

- chrome.storage 系用 `fakeBrowser.reset()`；IndexedDB 系用 `fake-indexeddb/auto` + 用例前后清库。
- **模块**：源码里的 `#imports` 在预处理时被替换，mock 时要写替换后的路径（如 `wxt/utils/inject-script`），对照表 `.wxt/types/imports-module.d.ts`。
- **offscreen 写侧**：`vi.mock('./builder')` / `vi.mock('./us-git')` 隔掉 esbuild-wasm 与 lightning-fs。
- **UI 组件**：只 mock IPC 客户端（`@/lib/userscripts/ui-client` 三个全 mock）与重组件子树（FileTree / UserscriptTreeNode）；**CodeMirror 6 用真实实现**（happy-dom 下可跑），mock 它会连坐 `@codemirror/lint` 等内部 import。

#### 注意事项

- 组件测试**必须命名 `*.component.test.ts`**，否则会被当成 node 用例误跑。
- 不要用 `stubs: { teleport: true }`，会吞掉 Dialog 的子内容。
- 卸载路径会真的调 `writeDraft`：`beforeEach` 须给它一个 resolved mock，否则 unmount 报 `Cannot read properties of undefined (reading 'catch')`。
- 依赖卸载时序的断言要在 unmount 前完成（编辑器卸载即 flush 草稿）。
- 构建冒烟需 CSP 放开 wasm 编译：`wxt.config.ts` 已声明 `wasm-unsafe-eval`。

### 端测

#### 命令

- `npm run build` 后 `npm run test:e2e`（跑构建产物、不依赖 dev server；串行 `workers: 1`）。
- 首次需 `npx playwright install chromium`（CDN 限速，可设 `PLAYWRIGHT_DOWNLOAD_HOST` 换镜像）。

#### 写法

- **载体 → 测法**：
  - `workbench.html`：`page.goto` 扩展页 → UI 断言。
  - SW 命令面：从一个扩展页发（`page.evaluate` → `chrome.runtime.sendMessage`）——SW 给自己发 runtime 消息不回环（报 `Receiving end does not exist`）。
  - SW 内部状态：`context.serviceWorkers()` 取句柄 `evaluate()`。
  - 用户脚本注入：本地探针页 → `window.DL` 桥与脚本执行。
  - side panel：只能验页面可加载（标题 + `#app` 挂载）。

#### 如何 mock

- **不 mock**：跑真实构建产物 + 真实 Chromium + 真实持久化，链路上不放替身。
- **外部站点**用本地静态探针页代替（`127.0.0.1` 随机端口）——用户脚本的 `*://*/*` 只匹配 http(s)，`file://` 不行。
- **前置数据**走命令面造（`userscript:create` / `updateFiles` / `remove`），不点 UI、不预置库。
- **干净状态**靠每次新建临时 profile，扩展状态库天然为空。

#### 注意事项

- 必须用 Playwright 捆绑 Chromium 且全无头。
- side panel 的真正打开（`sidePanel.open()` 需 user gesture）无头下不可行，转手测。
- 无头下 `chrome.userScripts` 默认不可用，须先引导（fixture 已实现，见 `e2e/extension.ts`）；引导失败时注入面自动 skip 转手测。

## 本文档不包括什么

- 已有哪些测试：看代码就行，不是复杂的事
- 测试基建的具体实现（`vitest.config.ts` / `playwright.config.ts` 里怎么配）：看代码就行
- 测试代码实现时已说明的实现逻辑：代码已经说明，没必要再重声明
- 官方文档已有的、业界已共识的说明：那些已经是准则了，没必要再描述一遍

## 决策记录

| 决策时间 | 决策点（≤100字） | 结论（≤100字） | 依据（≤100字） |
| ---------- | ------------------- | -------------------------------- | ----------------------------------- |
| 2026-09-15 | CSP 拦截 esbuild-wasm | manifest 显式放开 `wasm-unsafe-eval` | E2E 实跑必炸，真机同样                       |
| 2026-09-15 | E2E 加载方式            | Playwright 捆绑 Chromium + 全无头     | 本机 branded Chrome 已删 side-load flag |
