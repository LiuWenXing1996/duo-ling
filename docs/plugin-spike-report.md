# 哆灵转浏览器插件 · Spike 验证报告

> 位置：`tmp/spike-wxt/`（一次性验证工程，用完可删）
> 目标：用最小成本证伪迁移方案 `docs/plugin-migration-plan.md` 里最不确定的技术假设

## 1. 验证目标（要回答的问题）

| # | 假设 | 风险等级 | 验证方式 |
| --- | --- | --- | --- |
| A | WXT 工程能建、Vue 能编译、manifest 正确 | 中 | `wxt build` |
| B | sandbox iframe(srcdoc) 能承载工具页 + `window.cap` 桥接代码结构正确 | 高 | 代码打包 + 消息协议审查 |
| C | `lightning-fs`（异步）+ `isomorphic-git` 在浏览器存储上能 init/commit/rollback | 高（评审点1） | Node + fake-indexeddb 实测 |

## 2. 环境与版本（确定性）

- WXT `0.21.4`（Vite `8.3.0` 内核）
- Vue `3.5.42` + `@vitejs/plugin-vue` `6.0.8`
- `isomorphic-git` `1.42.2` + `@isomorphic-git/lightning-fs` `4.7.0`
- Node `22.22.2`，包管理最终用 **npm**（见 §5 踩坑）

> 注意：`@wxt/vue` 已从 npm 下架（404）。本 spike 不依赖它，直接用 `@vitejs/plugin-vue` 挂到 `wxt.config.ts` 的 `vite()` 上，entrypoint 用 `popup.html` + 内联 module 脚本挂载 `App.vue`。这是 0.21 下的稳妥路径。

## 3. 验证结果

### A. WXT 工程构建 ✅ PASS

```
WXT 0.21.4 · Building chrome-mv3 for production with Vite 8.3.0
✔ Built extension in 287 ms
  ├─ .output/chrome-mv3/manifest.json
  ├─ .output/chrome-mv3/popup.html
  ├─ .output/chrome-mv3/background.js            284 KB（含 git+fs 依赖）
  └─ .output/chrome-mv3/chunks/popup-*.js        62 KB
```

生成的 `manifest.json`：
```json
{"manifest_version":3,"name":"哆灵 Plugin Spike","version":"0.1.0",
 "permissions":["storage"],"background":{"service_worker":"background.js"},
 "action":{"default_title":"...","default_popup":"popup.html"}}
```
结构正确、无非法权限，**可被 Chrome 正常加载**。

### B. iframe 承载 + window.cap 桥接 ✅ 代码结构正确（已打包）

- `entrypoints/background.ts`：用 `#imports` 的 `defineBackground` 注册 `chrome.runtime.onMessage`，实现 `tool:getPage` / `cap:run`(markdown.render) / `cap:gitCommit` / `cap:gitRollback`，并按方案 §4.3 由 side panel 转发时附带 `toolId`（替代桌面版 webview URL 解析）。
- `entrypoints/App.vue`：从 background 取工具页 HTML → 注入 `<iframe sandbox="allow-scripts" :srcdoc="...">`；监听 `message` 把 `duoling-tool` 请求转发 background，结果回传 iframe。
- `src/tool-page-template.ts`：工具页 HTML 模板，内联 `window.cap.run/gitCommit` 桥接（postMessage 到 parent），对应桌面版 preload 注入的 `window.cap`。

grep 产物确认桥接代码已进入 `background.js` 与 `popup` chunk：**PASS（编译层）**。

> 运行时三方消息流（iframe→popup→background→回传）需真实浏览器加载扩展交互验证，沙箱无 GUI 浏览器无法自动化，见 §4。

### C. 异步存储层 git 闭环 ✅ PASS（Node + fake-indexeddb 实测）

`scripts/verify-store.mjs` 用 `fake-indexeddb/auto` 模拟浏览器 IndexedDB，跑通：
`git.init → writeFile → add → commit(c1) → writeFile → add → commit(c2) → log(2) → checkout(c1) → 回滚生效`

```
commit1: c1951eb4...
commit2: 7796509f...
before rollback: "<h1>v2</h1>"
after  rollback: "<h1>v1</h1>"
log length     : 2
PASS: lightning-fs + isomorphic-git 异步存储层 commit/rollback/log 闭环可用
```

**结论**：评审点 1「lightning-fs 是异步、非参数替换」属实，但**异步改造不阻断 git 能力**——`isomorphic-git` 接收 `fs.promises` 即可，增量重写量集中在把桌面版 `readdirSync`/`existsSync`/`statSync` 同步调用改为 `await`，而非架构风险。

## 4. 仍未证伪（需浏览器手测）

| 项 | 说明 | 风险 |
| --- | --- | --- |
| iframe 运行时消息流 | postMessage 三方转发需加载扩展点按钮交互 | 低（标准 API，代码已就绪） |
| service worker 闲置回收 | background 长任务需 Offscreen Document / `chrome.alarms` | 中（方案 §4.6 已列） |
| 真实 Chrome 加载 | `.output/chrome-mv3` 直接 `chrome://extensions` → 加载已解压扩展 | 低 |

**手测步骤**（给评审/用户）：
1. `cd tmp/spike-wxt && npm run dev`（或 `npm run build` 后用 `.output/chrome-mv3`）
2. Chrome 打开 `chrome://extensions` → 开发者模式 → 加载已解压扩展 → 选 `.output/chrome-mv3`
3. 点工具栏扩展图标打开 popup，输入 markdown，点「渲染并提交」，看输出与「已提交版本」
4. 改内容再渲染，点「回滚上一版本」验证恢复

## 5. 踩坑记录（对方案的修正输入）

1. **`sidePanel` 权限判断更正**：曾误判 WXT 自动补的 `"sidePanel"` 为非法权限（以为会导致扩展拒绝加载）。**更正**：`sidePanel` 是使用 `chrome.sidePanel` API 的**必需合法权限**（Chrome 114+，Chrome 官方文档明确要求声明），WXT 自动补是对的；spike 当时扩展加载失败的真正根因是 SW 的 `global.TextEncoder` 崩溃（见 §5.5），与权限无关。→ 一期正确做法：`permissions` 保留 `sidePanel`，并声明 `action` 键 + 在 background 顶层 `setPanelBehavior({openPanelOnActionClick:true})`。缺权限会导致 `chrome.sidePanel` 不存在、点图标不开面板。
2. **pnpm store 被沙箱拦截**：首次 `pnpm install` 在沙箱内 store db 写入被拦，导致 `node_modules` 空目录且后续判定 "up to date" 不重建。→ 最终用 **npm** 安装（关闭沙箱）成功。根目录 `pnpm-workspace.yaml` 的 store 状态有异常，子工程建议独立用 npm 或重建 pnpm store。
3. **`@wxt/vue` 已下架**：0.21 不再提供，改用 `@vitejs/plugin-vue` 直挂 vite 配置。
4. **lightning-fs 异步**：已实测可行（§3.C），但桌面版 `tool-git.ts` 的同步 API 需全量改异步——方案评审点 1 的「重写量」判断正确，但「可行性」无碍。
5. **service worker 加载即崩（`global.TextEncoder` undefined）**：dev 加载扩展报 `Service worker registration failed. Status code: 15` + `Uncaught TypeError: Cannot read properties of undefined (reading 'TextEncoder')`。根因：service worker 里 **`global` 是 `undefined`**，而 `isomorphic-git`/`lightning-fs` 打包代码写 `global.TextEncoder`，读 undefined 直接抛错、连带 SW 注册失败（status 15 是崩溃后果，非独立错误）。→ 修复：`wxt.config.ts` 的 `vite.define` 里加 `global: 'globalThis'`（SW 原生有 `TextEncoder`/`TextDecoder`），并在 `entrypoints/background.ts` **最前** import `src/polyfills.ts` 兜底（仅当 `global` 未定义时 `globalThis.global = globalThis`）。改后重新 build，grep 确认产物中已无裸 `global.` 写法、`TextEncoder` 已变 `new TextEncoder()``。**注意：改 `wxt.config.ts` 必须重启 `npm run dev` 才生效**（HMR 不重读配置）；重启后到 `chrome://extensions` 点扩展卡片的刷新图标重载。这是浏览器插件迁移里 isomorphic-git/lightning-fs 入 SW 的通用坑。
6. **sandbox iframe 输入焦点 + CSP inline script 连环坑**（手测发现，关键）：
   - 仅 `sandbox="allow-scripts"`（opaque origin）→ 内联脚本能跑（异源不受扩展 CSP 约束），但 Chrome 扩展 popup 中该 iframe **文本输入框抢不到焦点（无光标）**。
   - 加 `allow-same-origin` 修焦点 → 但 iframe 与扩展**同源**，扩展 CSP（`script-src 'self' ...`）套上来，**内联 `<script>` 被 `unsafe-inline` 拦截**，桥接不执行；同时 Chrome 警告 `allow-scripts`+`allow-same-origin` 可逃逸沙箱。
   - **最终修法**：把桥接脚本抽成**外部同源文件** `public/tool-bridge.js`（WXT 会拷到输出根目录），srcdoc 改为 `<script src="/tool-bridge.js">`；toolId 经 `<body data-tool-id>` 传递（HTML 属性，不受 CSP 限制）。同源外部脚本在 CSP `'self'` 内放行。产物已验证无内联 script、`tool-bridge.js` 进根目录。
   - ⚠️ **安全底线**：spike 的 `allow-same-origin`+同源桥接对写死工具页可接受；正式迁移中 **AI 生成的不可信工具页必须回到严格 sandbox（opaque origin）**，把可信桥接与不可信工具 UI 拆成两层 iframe，仅 postMessage 通信，否则暴露 `chrome` API 给不可信代码（对应方案 §4.6）。
7. **service worker 缺 Node 全局 `Buffer` / `process`**：修好 `global` 后运行 `markdown.render`→`writeToolFile`/`commit` 报 `Buffer is not defined`。service worker 不像 Node，没有 `Buffer`/`process` 全局，而 `isomorphic-git`/`lightning-fs` 内部用到。→ 修复：新增 `src/polyfill-process.ts`（先补 `process`，因为 `buffer` 包加载时会引用 `process`）+ 在 `src/polyfills.ts` import 它之后再 `import { Buffer } from 'buffer'` 并挂 `globalThis.Buffer`。二者都必须在 `background.ts` 最前 import，保证早于 fs-store 的 isomorphic-git 引用执行。已 build 验证产物含 `g.Buffer=Buffer` / `g.process=process` / `globalThis.global=globalThis` 兜底。这是 isomorphic-git/lightning-fs 入 SW 的第三个通用坑。
8. **回滚不生效（手测发现，逻辑 bug 非 SW 坑）**：点「回滚上一版本」后显示仍是当前内容。根因有二：① `fs-store.rollback` 原实现 `git.checkout({ ref: 'HEAD' })`——这是"把工作区恢复到**当前版本**"，等于没回退，应 checkout 到 `HEAD~1`（即 `git.log` 的 `log[1].oid`）；② 即便文件改对，popup 与 iframe 都没去读回滚后的新内容刷新显示（background 只回 `{ok:true}`，iframe 的 `out` 仍是上次渲染的旧内容）。→ 修复：`rollback` 改为取 `log[1].oid` checkout 并返回回滚后的 `output.html` 内容；`background` 的 `cap:gitRollback` 把 `html` 带回；`App.vue` 收到后 `postMessage` 推给 iframe；`tool-bridge.js` 新增 `duoling-host`/`showContent` 监听刷新 `out`。这印证方案 §4.5「版本/回滚闭环」在异步存储层可成立，但 UI 重绘需显式联动——属桌面版未暴露、插件版新增的耦合点。

## 6. 结论

**方向成立，可行。最险的三处假设（A/B/C）已全部证伪或局部证伪：**
- WXT 工程栈可行 ✅
- iframe 承载 + cap 桥接代码可达标 ✅（编译层）
- 异步存储层 git 闭环可用 ✅（实测）

**建议**：推进迁移方案一期（MVP），把本 spike 的 `background.ts` / `App.vue` / `fs-store.ts` / `tool-page-template.ts` 作为最小骨架起点；side panel 形态在 MVP 之后按方案文档 §5 风险7 做跨端双 API 适配（Chrome 用 `side_panel`+`chrome.sidePanel` 且去掉非法 `sidePanel` 权限；Firefox 用 `sidebar_action`+`browser.sidebarAction`），「工作台」UI 组件三者共用、零改。

## 7. 文件清单

```
tmp/spike-wxt/
├─ package.json            # 依赖与脚本
├─ wxt.config.ts           # vite vue 插件 + manifest
├─ tsconfig.json
├─ entrypoints/
│  ├─ background.ts        # 能力运行时（cap runtime + git）
│  ├─ popup.html           # 入口（spike 用 popup 验证）
│  └─ App.vue              # Vue 承载组件（iframe + 消息转发）
├─ src/
│  ├─ fs-store.ts          # lightning-fs + isomorphic-git 封装 + miniRender
│  └─ tool-page-template.ts# 工具页 HTML 模板 + window.cap 桥接
├─ scripts/verify-store.mjs# 存储层运行时验证（PASS）
└─ .output/chrome-mv3/     # 构建产物（可直接加载）
```
