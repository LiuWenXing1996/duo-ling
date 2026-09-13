# 哆灵 · 转浏览器插件（Chrome MV3 扩展）迁移方案

> Migration Plan · V0.1（评审稿）
> 日期：2026-09-13 · 状态：待评审

## 0. 结论摘要（先看这）

**能做，但分三层难度：**

- ✅ **可直接平移（架构级优势）**：原子能力契约（`src/shared/types.ts`）、能力注册表（`capability-registry.ts`）、UI 层（Vue3 + shadcn-vue + Tailwind v4）、AI 编排逻辑（agent-orchestrator / agent-tools）、版本管理用的 `isomorphic-git`（本就是浏览器/Node 通用库）。这些不用重写，只换运行宿主。
- ⚠️ **需替换存储/承载（中等改动）**：每一个 `node:fs` 落盘点换成 IndexedDB / `chrome.storage.local`；`<webview>` + `tool://` 协议换成 sandbox `<iframe>` + `chrome-extension://` + `srcdoc`。
- ❌ **能力级缺口（必须改语义）**：凡是「静默读任意绝对路径文件」「打开系统文件夹」「进程级隔离」的 Electron 特性，浏览器里不存在或受限。尤其是 `local.file.read` 这类「读任意路径」能力，只能退化为「用户主动选/拖入文件」。这是产品形态而非实现细节的让步。

**一句话**：工具工厂的核心闭环（一句话生成 → 工具页运行 → 版本/回滚 → 维护自愈）在浏览器插件里成立，且 offline 能力会因跑在纯 JS 里而**比桌面版更彻底地离线**；代价是失去「无感访问本机任意文件」和「进程级崩溃隔离」。

---

## 1. 架构映射总表（Electron ↔ MV3）

| Electron 现有实现 | MV3 浏览器插件对应 | 改动量 | 备注 |
| --- | --- | --- | --- |
| `main` 进程（`src/main/index.ts` 窗口/IPC/系统能力） | **background service worker**（`background.ts`） | 中 | 无窗口概念；能力经 `chrome.runtime` 消息或 Offscreen Document 提供 |
| `preload`（`src/preload/index.ts` 暴露 `api`/`electron`） | 无 preload；能力由 background 经 `chrome.runtime.sendMessage` / 注入脚本直接提供 | 中 | 渲染进程不再有 Node，能力全部走消息协议 |
| `renderer` 主窗口 | **side panel**（`sidepanel.html`，AI 对话入口）+ **标签页工作区**（`workbench.html`） | 小 | Vue 技术栈整体复用。**产品定案**：side panel = 应用入口 = AI 对话界面；工具运行 / 代码 / 版本 / 设置等重界面开**独立标签页**（桌面版"工具工作区多标签"迁到这里），不用 options 页也不常驻面板 |
| `<webview>` + `tool://` / `tool-preview://`（`protocol.ts` / `tool-page.ts`） | **sandbox `<iframe>`** + `chrome-extension://<id>/tool-frame.html` + `srcdoc` | 中 | 见 §4.2 |
| `utilityProcess.fork` backend 能力（`capability-runtime.ts` / `capability-worker.ts`） | background 内直接执行，或 **Web Worker** 做软隔离 | 中 | 见 §4.3 |
| `node:fs` 工具目录 `<userData>/tools/<id>/`（`tool-page.ts`） | **IndexedDB**（工具页 HTML 字符串 + meta） | 中 | 见 §4.4 |
| `isomorphic-git` + `node:fs`（`tool-git.ts`） | `isomorphic-git` + **lightning-fs**（IndexedDB 后端） | 中 | 复用度高，但 lightning-fs 仅异步，需把同步 fs 调用改异步（见 §4.5） |
| `tool.data.*`（`tools-data.ts`，fs 目录） | **IndexedDB** / `chrome.storage.local` | 小 | 纯键值，`chrome.storage.local` 即可 |
| `shell.openExternal` / `shell.openPath`（`index.ts` / `tools-data.ts`） | `chrome.tabs.create`（URL）/ **下载** 或扩展内预览（无"打开文件夹"概念） | 小 | 系统文件夹浏览能力直接删除 |
| LLM 调用 `openai-client.ts`（`node fetch`） | background `fetch` 转发（绕 CORS） | 小 | 见 §4.7 |
| `BrowserWindow` 生命周期 / 多窗口 | 扩展生命周期（安装/side panel/options） | 小 | 无窗口管理 |
| `app.getPath('userData')` | `chrome.runtime.getManifest()` / `chrome.storage` 命名空间 | 小 | 仅路径语义替换 |

---

## 2. 分层迁移方案

### 4.1 进程 / 入口层

- 删除 `electron.vite.config.ts`、`electron-builder.yml`、`src/main`、`src/preload` 的 Electron 专属部分。
- 改用 **WXT**（Vite 驱动的 WebExtension 框架，最贴合本项目 Vite 习惯）或 Plasmo 作为构建壳。推荐 WXT：多 entry、HMR、自动生成 `manifest.json`，与现有 Vite 7 栈一致。
- 入口：
  - `entrypoints/background.ts` → 原 `main` 进程职责（IPC 服务端、能力路由、LLM 转发、git 操作）。
  - `entrypoints/sidepanel.html` + `src/sidepanel/` → 原 `renderer` 主窗口（工作台：工具列表 + 对话 + 工具页标签页）。
  - `entrypoints/options.html` → 设置面板（沿用 `SettingsPanel`）。
  - `entrypoints/popup.html` → 图标点击的轻量入口。
  - `entrypoints/tool-frame.html` → 工具页承载页（等价 `<webview>` guest 宿主）。

### 4.2 工具页承载层（最核心替换）

现状：`<webview>` 经 `tool://` 加载 `index.html`，guest preload（`preload/tool.ts`）注入 `window.cap`，2s 心跳报活。

目标映射：

- 工具页 HTML/CSS/JS 存 **IndexedDB**（按 `toolId`，等价 `toolsRoot()`）。
- 承载页 `tool-frame.html` 用 `chrome.storage` / IndexedDB 读出工具 HTML 字符串，注入 `<iframe sandbox="allow-scripts allow-same-origin allow-forms">` 的 `srcdoc`。
- `sandbox` 属性让 AI 生成的**内联脚本**可运行（MV3 扩展页默认 `script-src 'self'` 禁止内联），且 iframe 与主扩展上下文隔离——这正好等价于 Electron `webview sandbox:true`。
- **cap 桥接**：在 `tool-frame.html` 内放一段桥接脚本，监听 iframe 的 `postMessage('cap.run', …)`，转发到 background（`chrome.runtime.sendMessage`），回执再 postMessage 回 iframe；iframe 内脚本据此挂 `window.cap`。等价于 `preload/tool.ts` 的 `contextBridge.exposeInMainWorld('cap', …)`。
- **版本预览**：`materializeToolSnapshot` 改为从 IndexedDB 读目标 commit 的 blob → 注入另一个 `srcdoc` iframe，等价 `tool-preview://`。
- **心跳/卡死检测**：保留 iframe → 承载页的 2s `postMessage` 心跳，承载页据此判定工具页死循环（逻辑原样搬）。
- **CSP**：在 `manifest.json` 的 `content_security_policy` 与 `web_accessible_resources` 中声明工具页允许 `self` + `inline`，等价 `TOOL_PAGE_CSP`。

> 注意：`srcdoc` + `sandbox` iframe 内的脚本**无法访问扩展 API**，所有 `cap.run` 必须经 postMessage 走 background——与现有「工具页零 Node、全经 cap 抽象层」的设计一致，迁移无语义破坏。

### 4.3 原子能力执行层

现状：`backend` 能力 `utilityProcess.fork` 进程隔离；`frontend` 能力（markdown render）+ `tool.data.*` 主进程直跑；`runCapability` 统一抽象层。

目标：

- 删除 `utilityProcess` / `capability-worker.ts`。
- 把 `capability-runtime.ts` 的「转发到子进程」改为「调用 background 内 `backendImpls`」。
- **软隔离**：对长耗时/易崩的能力（如 PDF 处理、批量文件）用 **Web Worker**（Offscreen 思路）跑，崩了不影响 side panel UI；普通轻量能力直接在 background 同步执行。
- 能力契约（`CapabilityDefinition`）与 `runCapability` 抽象层**完全复用**，生成器/编排层无感。
- **⚠️ `toolId` 来源解析需重做**：桌面版后台靠调用方 `<webview>` 的 URL（`tool://<id>/…`）解析出 `toolId`，用于 `tool.data.*` 等按工具隔离的能力；插件里 `cap.run` 来自 sandbox iframe，background 无法从 URL 直接拿。改为：承载页 `tool-frame.html` 在注入 iframe 时把 `toolId` 作为 iframe URL 参数（如 `tool-frame.html?tool=<id>`），cap 桥接转发 `postMessage` 时一并将 `toolId` 带给 background。这是方案中此前遗漏的链路，必须补。
- `frontend-impls.ts`（markdown render）改为在工具页 iframe 内或 background 用 `marked`/`markdown-it` 实现（浏览器原生，无需主进程）。

### 4.4 持久化层（fs → IndexedDB）

| 原 fs 落盘点 | 新存储 |
| --- | --- |
| `toolsRoot()/tools/<id>/`（工具页 + meta.json） | IndexedDB 库 `tools`：`<id> → { html, meta }` |
| `toolsDataRoot()/tools-data/<id>/`（tool.data.*） | `chrome.storage.local` 或 IndexedDB 库 `toolsData`：`<id> → { entries }` |
| `previewRoot()/tools-preview/`（版本预览缓存） | 不落盘，按需从 git blob 读取注入 iframe（见 §4.5） |
| `app.getPath('userData')` | 扩展 storage 命名空间，无绝对路径概念 |

读写函数（`tool-page.ts` / `tools-data.ts`）内部替换 `node:fs` 为 IndexedDB 异步 API，**对外签名保持**（除同步改异步）。

- **⚠️ 安全白名单必须随存储层平移**：`applyToolChanges` 当前依赖 `isAllowedToolFile`（白名单）、防目录穿越、patch 需 `find` 精确命中（未命中整单失败）三道校验（见 `tool-page.ts`）。换 IndexedDB 时这些校验逻辑**不能丢**——只是把「路径合法性」换成「key/记录 id 合法性」，写前仍需全量校验再原子提交。
- **⚠️ git 数据与工具记录清理要一致**：桌面版 git 仓在 `tools/<id>/.git`，删工具即连同历史删。IndexedDB 里 git 数据（lightning-fs 虚拟文件系统）与工具记录（库 `tools`）是两份存储，删工具须**同时清两者**，否则留孤儿数据（对应 `tools-data.ts` 的「孤儿标记」逻辑要保留并适配）。

### 4.5 版本管理（isomorphic-git + lightning-fs）

- `tool-git.ts` 的 `git.init/commit/log/readBlob/walk` 全部保留，仅把 `fs` 参数换为 **`lightning-fs`**（`@isomorphic-git/lightning-fs`，IndexedDB 后端）。
- `materializeToolSnapshot`：不再 `writeFileSync` 到磁盘缓存，改为 `git.walk` 收集目标 commit 的 blob → 直接注入 `srcdoc` iframe（或生成 Blob URL）。逻辑结构不变。
- 版本预览缓存清理（`clearPreviewCache`）改为「不物化即无缓存」，或保留内存缓存计数。
- 这是复用度最高的一块，但**不是零改动**：lightning-fs 只提供**异步** API，而 `tool-git.ts` 目前大量使用 `readdirSync` / `existsSync` / `statSync` 等同步调用（如 `listToolFiles`、`hasToolChanges`）。迁移时这些辅助函数与 `git` 调用都要改为 `await` 异步写法；且 `materializeToolSnapshot` 的「临时目录 + rename 原子落位」逻辑改为直接注入 iframe（无磁盘可 rename）。印证当初选 `isomorphic-git`（而非系统 git）的前瞻性，但工作量记为「中」更准确。

### 4.6 文件 / 系统能力（最大缺口，必须改语义）

| 能力 | 桌面现状 | 浏览器插件可行方案 | 让步 |
| --- | --- | --- | --- |
| `local.file.read` | 读任意绝对路径 | 用户经 `<input type=file>` / 拖拽 / `showDirectoryPicker`（File System Access API）主动授权 | **不能静默读任意路径**；Firefox 不支持 `showDirectoryPicker` |
| `local.file.write` | 写任意路径 | `chrome.downloads.download`（存到下载目录）或 `showSaveFilePicker` | 输出落到"下载"，非任意目录 |
| `local.file.choose` | 系统文件框 | `<input type=file>` / `showOpenFilePicker` | 原生对话框，体验一致 |
| `docs.pdf.*` | 主进程 PDF 库 | 浏览器内 **pdf-lib / pdfjs**（纯 JS） | 反而更离线、无需 Node 依赖 |
| `shell.openPath`（打开文件夹） | 直接开资源管理器 | **删除**该能力 | 系统文件夹浏览在 Web 无对应物 |
| `schedule.task`（定时） | 主进程定时器 | **chrome.alarms API**（service worker 闲置后仍能触发） | 最小间隔 1 分钟，精度下降 |

**产品含义**：「把某文件夹里所有 PDF 第 3 页抽出来合并」这类场景，桌面版能静默扫目录；插件版需用户**先授权目录**（一次授权可记住），再批量处理。其余 offline 工具（markdown 渲染、键值持久化、纯前端 PDF 合并）体验不变甚至更好。

- **⚠️ 能力契约变更必须联动 AI 生成器**：`local.file.read` 的 `inputSchema` 从 `{ path: 绝对路径 }` 变为「用户拖入/选择的文件句柄」，相应的 `scenario` 检索元数据、生成器产出工具代码的模板（现假设 `cap.run('local.file.read', { path })`）都要同步改，否则新生成的工具仍按旧 path 语义写、运行时必错。这是「能力定义」与「生成器」的耦合点，迁移时一并评审。
- **⚠️ 工具页内 `window.open`（外部链接）需桥接**：桌面版拦截 `window.open` 交 `shell.openExternal`。插件版工具页是 sandbox iframe，内部 `window.open` 行为与权限受限，应通过 cap 桥接或 `postMessage` 让 background 用 `chrome.tabs.create` 打开——方案 §4.2 的 cap 桥接需增加「打开外部链接」一条能力或消息类型。

### 4.7 LLM 调用与 CORS

- `openai-client.ts` 用 `node fetch` 直连 OpenAI 兼容接口。浏览器里：
  - **方案 A（推荐）**：background service worker 发起 `fetch` 转发，绕过页面 CORS——工具的 online 能力（`web.fetch`/`web.search`）也走此通道。
  - API Key 存 `chrome.storage.local`（替代桌面版 env / 配置文件），首次使用引导用户填入。
- `web.fetch` 能力在插件里天然受限（跨域需经 background 转发），成本标注 `online` 不变。

### 4.8 UI 层复用

- `src/renderer/src/` 的 Vue 组件、`components/ui/`（shadcn-vue）、`assets/main.css`（Tailwind v4 + 主题）、`styles/*.less` **整目录平移**到 `src/sidepanel/`。
- `@` 别名、`tsconfig` 调整适配 WXT。
- WXT 内置 `<script setup>` + Vite，与现有 SFC 写法一致。
- 工作台标签页（ToolWorkspace/ToolFrame 组件）保留，仅把内部 `<webview>` 替换为 §4.2 的 iframe 承载。

---

## 3. 技术栈与构建替换

| 项 | 桌面版 | 插件版 |
| --- | --- | --- |
| 构建 | electron-vite 5 + Vite 7 | **WXT**（Vite 驱动） |
| 打包 | electron-builder | `web-ext build` / `wxt zip` → Chrome Web Store |
| 渲染 | Electron Chromium 渲染进程 | 扩展 side panel / options 页（Chromium） |
| 测试 | Vitest（单测）+ Playwright（Electron 模式） | Vitest（单测，shared/纯逻辑复用）+ **Vitest browser mode / @webextension/testing**（端测） |
| 存储 | node:fs | IndexedDB + lightning-fs + chrome.storage |
| 进程 | main/preload/renderer | background(sw) / side panel / iframe guest |

---

## 4. 实施路线（分三期）

**一期 · 核心闭环可达（MVP）**
- 脚手架：WXT 工程 + manifest + **side panel（对话入口）** + **workbench 标签页（工具工作区）**。一期不用 popup、也不用 options 页（spike 的 popup 仅作核心闭环验证产物，保留不动）。
- **载体分工（产品定案）**：
  1. **side panel = 应用入口 = AI 对话界面**：会话列表 / 消息流 / 输入区 / 模型选择。对话链路在扩展页直接 `fetch` OpenAI 兼容接口（SSE 流式），不经 background。
  2. **`workbench.html` = 工具工作区（独立标签页）**：hash 路由 `#/tools`、`#/tool/<id>/<run|code|history>`、`#/settings`；承载原桌面版「工具工作区多标签」的全部内容。
  3. 设置并入 workbench 的 `#/settings`（原 options 页取消）。
- ⚠️ **一期载体配置要点（务必照做）**：
  1. manifest 用 `side_panel.default_path` 声明面板页，并在 `permissions` 声明 **`sidePanel`**（使用 `chrome.sidePanel` API 的必需权限，Chrome 114+）；同时声明 `action` 键（`default_title`）。**缺 `sidePanel` 权限则 `chrome.sidePanel` 不存在、点击图标不开面板**。（更正：早期误判 `sidePanel` 为"非法权限"是错的。）
  2. 在 background **顶层**调用 `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` 控制点击图标打开面板（幂等，比只依赖 onInstalled 稳）；不要依赖 popup 入口。
  3. 扩展页 `fetch` 模型接口必须声明 `host_permissions`（可由服务商预设表推导，见 `src/lib/providers.ts`），否则跨域请求被拦。
  4. Firefox 侧三期再补 `sidebar_action`（见 §5 风险 7）：把「对话」与「工作台」都抽成独立组件，两套 API 共用组件、只分发打开方式，UI 零改。
- 平移：shared 类型、capability-registry、UI 层、agent 编排。
- 工具页承载：iframe + srcdoc + cap 桥接 + 心跳（§4.2）。
- 持久化：IndexedDB 工具目录 + chrome.storage 工具数据（§4.4）。
- 版本：isomorphic-git + lightning-fs（§4.5）。
- 离线能力：`docs.markdown.render`、`tool.data.*`、用户拖入文件的 `local.file.read`。

**二期 · 补齐能力**
- backend 全部 offline 能力（PDF 解析/合并用 pdf-lib）。
- online 能力经 background 转发（web.fetch/search）。
- 维护期自愈闭环、运行记录、成本标注 UI。
- 设置面板（数据管理、API Key）。

**三期 · 发布与跨端**
- Chrome Web Store 上架（zip + 审核材料）。
- Firefox / Safari 适配（注意 `showDirectoryPicker` 不支持 Firefox → 二期兜底用 `<input multiple>`）。
- 跨设备同步（可选，超出 MVP）。

---

## 5. 风险与限制（诚实清单）

1. **任意路径文件访问消失**：`local.file.read` 只能读用户主动授权/拖入的文件，影响「静默扫目录」类自动化。这是浏览器安全模型的硬限制，非实现可绕。
2. **进程级隔离降级**：Electron `utilityProcess` 的进程隔离在浏览器里退化为 Web Worker 软隔离，能力崩溃可能波及扩展上下文，安全边界靠能力白名单 + CSP 维持（比桌面版弱）。
3. **service worker 生命周期**：background 闲置约 30s 回收，长任务需 Offscreen Document 或拆小步；`schedule.task` 必须换 `chrome.alarms`（精度降至分钟级）。
4. **跨浏览器差异**：File System Access API 仅在 Chromium 系；Firefox 需 `<input>` 兜底，统一交互需抽象一层。
5. **CORS / 权限**：online 能力与 LLM 必须 background 转发；扩展需申请 `host_permissions`（如 `*://*.openai.com/*`）才能代理请求，上架需说明。
6. **体积**：纯 JS PDF/Markdown 库 + lightning-fs 会增大扩展包体，但换来真正离线，与产品定位一致。
7. **side panel 跨端是「两套 API」而非「无解」**（据 MDN Sidebars 文档修正原判断）：Firefox **有** sidebar，但用的是独立的 `sidebar_action` manifest key（`default_sidebar` / `default_title` / `default_icon`）＋ `browser.sidebarAction` API（用户经 Firefox「视图 ▸ 侧栏」菜单开启，安装后自动打开）；Chrome 用的是另一套 `side_panel` manifest key ＋ `chrome.sidePanel` API。二者**不互通**，WXT 的 `side_panel` entrypoint 只会生成 Chrome 一侧。→ 正确做法：（a）Chrome 侧**必须在 `permissions` 声明 `sidePanel`**（使用 `chrome.sidePanel` API 的必需权限，Chrome 114+；缺它则 `chrome.sidePanel` 不可用、点图标不开面板），并声明 `action` 键配合 `setPanelBehavior({openPanelOnActionClick:true})`；**更正**：早期把 `sidePanel` 误判为"非法权限"是错的——spike 当时加载失败的根因是 SW 的 `global.TextEncoder` 崩溃，与权限无关；（b）抽「工作台」为独立组件，由 side panel（Chrome）/ `sidebar_action` 面板（Firefox）/ options 页**共用同一组件**，按浏览器在 `manifest` 分别声明，代码层用 `chrome.sidePanel` / `browser.sidebarAction` 条件分发；（c）三期跨端时只补 Firefox 的 `sidebar_action` 声明与 API 适配，UI 组件零改。
8. **`host_permissions` 上架审查**：online 能力与 LLM 经 background 转发，需在 `manifest.json` 声明 `host_permissions`（如 `*://*.openai.com/*`）；Chrome Web Store 审核会要求说明数据用途，需提前准备隐私说明文案。
9. **测试改造工作量被低估**：端测从 Playwright Electron 模式换 `@webextension/testing` / Vitest browser mode，且需真实加载 unpacked 扩展到 Chromium；background/iframe 跨上下文消息链路难单测，建议补「cap 桥接消息协议」的集成测试。原方案标「中」偏保守，实际接近「中-高」。

---

## 6. 工作量粗估（相对桌面版代码量）

| 模块 | 工作量 | 说明 |
| --- | --- | --- |
| 构建/入口重构（WXT + manifest） | 中 | 删 Electron 配置，建 WXT 工程 |
| UI 层平移 | 小 | 整目录复制 + 别名调整 |
| 工具页承载（iframe/srcdoc/cap 桥接） | 中 | 等价 webview，模式清晰 |
| 持久化 fs→IndexedDB | 中 | 多文件内部替换 |
| git→lightning-fs | 中 | 异步改造（lightning-fs 无同步 API） |
| 能力语义改（文件/系统） | 中 | 需改产品交互，非纯移植 |
| LLM/online 转发 | 小 | background fetch |
| 测试改造 | 中 | 端测从 Electron 模式换框架 |
| **合计** | **约 0.6–0.8 × 桌面版总工作量**（核心逻辑复用率高） | 真正重写集中在承载/存储/文件三处 |

---

## 7. 建议的下一步

1. 评审本方案，确认「插件版是否接受 §4.6 的文件能力让步」（决定 PRD 是否需要补「浏览器版能力清单」）。
2. 选定构建框架（推荐 WXT）。
3. 先在一期范围做**最小 spike**：用 WXT 起工程 + 平移 UI + 跑通一个 `markdown.render` 工具的 iframe 承载 + IndexedDB 存储，验证可行后再铺开。

---

## 8. 评审记录（2026-09-13）

对照实际代码（`capability-runtime.ts` / `protocol.ts` / `tool-page.ts` / `preload/tool.ts` / `tool-git.ts` / `tools-data.ts` / `capability-backend.ts`）评审本方案，发现 7 处需修正/补充，均已就地修订正文（标 ⚠️）：

1. **`lightning-fs` 异步改造**：`tool-git.ts` 大量同步 `fs` 调用需改异步，非「参数替换」；映射表与工作量表由「小」更正为「中」。
2. **`toolId` 来源解析缺失**：插件里 `cap.run` 来自 sandbox iframe，background 须从 iframe URL 参数拿 `toolId`（§4.3 补）。
3. **安全白名单随存储层平移**：`isAllowedToolFile` / 防穿越 / patch `find` 命中校验换 IndexedDB 不能丢（§4.4 补）。
4. **git 数据与工具记录清理一致性**：删工具须同时清 lightning-fs 仓 + IndexedDB 记录（§4.4 补）。
5. **side panel 跨端是两套 API 而非无解**（据 MDN 修正）：Firefox 用 `sidebar_action` manifest key ＋ `browser.sidebarAction` API（经「视图▸侧栏」开启、安装自动打开），Chrome 用 `side_panel` key ＋ `chrome.sidePanel` API，二者不互通，WXT 只生成 Chrome 侧。→ 抽「工作台」独立组件，由 side panel / `sidebar_action` 面板 / options 共用，代码层按浏览器条件分发（§4.6 / §5 风险 7 补）。
6. **能力契约变更联动生成器**：`local.file.read` 的 `inputSchema` 改了，AI 生成器 scenario 与模板须同步；工具页 `window.open` 需 cap 桥接（§4.6 补）。
7. **`host_permissions` 上架审查 + 测试改造低估**：声明 host 权限并接受 Web Store 审核；端测工作量由「中」上调为「中-高」（§5 风险 8/9 补）。

**评审结论**：方案方向成立、可转，复用率判断准确；上述修正均属「实现细节补全」而非方向性推翻。修订后工作量评估上调至约 **0.8–1.0 × 桌面版**（主要来自异步改造 + 安全/清理一致性 + 测试链路）。建议按修订版推进一期 spike。
