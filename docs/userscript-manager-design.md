# 油猴脚本管理器 · 设计方案

> ⚠️ **2026-09-14 战略转向：已放弃油猴生态兼容。** 本文档 §6（GM API 桥接层）中关于
> `GM_*` 命名与同步语义的内容**已作废**，脚本改为自有形态（模块化 + 自有能力 API + 隔离世界 + 反向中继）。
> 新的能力 API 规范见 **[userscript-api.md](./userscript-api.md)**；
> **完整实施方案（含旧资产保留/改造/删除清单与四阶段计划）见 [userscript-v2-plan.md](./userscript-v2-plan.md)**，
> 本文档 §4–§5（注入引擎、存储）的实施细节以新方案为准。
> 本文档 §7–§8（管理 UI、background 命令）**部分沿用**（新方案 Phase 1 有命令面调整）。

> 状态：设计稿 v2（评审后更正）
> 范围决策（已与用户确认）：**Chrome + Firefox 双端** / 管理 UI 落 **工具页** / **GM 核心子集**
> 参考源码：本地克隆的 ScriptCat（GPL-3.0，仅作设计参照，不抄代码）、Violentmonkey（MIT，模式可借鉴）

---

## 1. 目标

在 duo-ling 扩展内提供一个**用户脚本管理器**：用户可安装/编辑/启停第三方 userscript，脚本按 `@match` 注入网页并执行，并通过 `GM_*` API 与扩展能力互通。

第一版定位：开发者向工具，跑通"存储 → 注册 → 注入 → GM 子集桥接 → 管理 UI"最小闭环，不追求兼容 Tampermonkey 全量生态。

---

## 2. 参考依据（已读真实源码）

### 2.1 ScriptCat = `chrome.userScripts` 标准范本
关键实现位于 `src/app/service/service_worker/runtime.ts`：
- `runtime.ts:1011` 注册前 `configureWorld({ csp: "script-src 'self' 'unsafe-inline' 'unsafe-eval' *", messaging: true })`；CSP 不被支持时降级为仅 `{ messaging: true }`（Firefox 分支）。
- `runtime.ts:747` **可用性检测**：`isUserScriptsAvailable` 为 false 时弹激活引导并轮询，直到用户开启权限后 `chrome.runtime.reload()`。证明 Chrome 的启用门槛真实存在且 ScriptCat 选择接受。
- 注册三个引导脚本：`scriptcat-inject`（`world: MAIN`，可访问 `unsafeWindow`）+ `scriptcat-content`（`world: USER_SCRIPT`，桥接世界）+ `scriptcat-scripting`（content script 层，经 `chrome.scripting.registerContentScripts`）。每个真实脚本按 `@inject-into` 选 `world` 并注入 `apiScript`（GM 包装）。
- 批量 `register`，失败回退逐条 `register` / `update`（Duplicate ID 时改 `update`）。
- GM 处理在 `gm_api/gm_api.ts`（40+ 函数，带 `@PermissionVerify` 权限校验）；存储用 Dexie(IndexedDB) + `chrome.storage`，DAO 模式。

> 本方案 v1 **不沿用**上述三引导脚本模型（见 §3/§4 说明），仅借用其 `configureWorld` + 注册/容错思路。

### 2.2 Violentmonkey = 免 dev-mode 的对照路线
- 主注入靠 **manifest `content_scripts`**（`injected-web.js` + `injected.js`，`document_start` / `<all_urls>` / `all_frames`），不走 userScripts，故普通用户**无需开 dev mode**。
- `preinject.js` 的 `GetInjected` 命令：content script 向 background 请求注入数据，再动态插 `<script>`。
- `injected/content/inject.js` 做 **realm 分流**：默认进 PAGE 世界，被 CSP 挡则掉 CONTENT 世界，用 "Vault" 保护扩展全局。
- 同时保留 MV3 的 userScripts 分支（`__.MV3 ? chrome.userScripts : contentScriptsAPI`），两条路都通。

### 2.3 合规红线
- **ScriptCat 为 GPL-3.0（强 Copyleft）**：只能看设计、自己重写，禁止把其代码并入 duo-ling（除非 duo-ling 也转 GPL，目前不是）。
- **Violentmonkey 为 MIT**：模式与少量工具函数可自由借鉴。
- 结论：本方案**参照两家架构、全部代码自写**。

---

## 3. 架构总览（v1 · Model B）

```
┌──────────────────────────── 管理 UI（工具页 / ToolWorkspace） ┐
│  脚本列表 · 启停开关 · 安装(URL/粘贴) · 编辑器 · 元数据预览      │
└───────────────────────────────┬──────────────────────────────┘
                                 │ window.cap → 面板 → background（沿用现有消息协议）
                                 ▼
┌────────────────────────  background SW（中枢） ────────────────┐
│  · 存储层（chrome.storage.local：记录含源码 + GM 值 + 设置）     │
│  · userscript 命令处理（list/install/update/remove/toggle）      │
│  · configureWorld({ messaging:true, csp })（启动 + onInstalled 重跑）│
│  · userScripts.register / update / unregister（每脚本 worldId） │
│  · 可用性检测（getScripts try/catch）+ 版本分支引导             │
│  · GM_api 桥：onUserScriptMessage 收 → 实现子集                 │
└───────────────┬─────────────────────────────────────────────────┘
                │ register（每脚本独立 USER_SCRIPT 世界）
                ▼
 USER_SCRIPT 世界（每脚本 worldId 隔离）
   ├─ js:[GM_api 包装, 用户脚本源码]   // 包装先行定义 GM_*
   └─ GM_* → chrome.runtime.sendMessage → onUserScriptMessage → 后台实现
```

> v1 **不做** ScriptCat 式三引导脚本（MAIN 桥 + USER_SCRIPT 桥 + content-script 兜底），也**不支持 MAIN 世界**（`@inject-into: page` / `unsafeWindow` 留后续阶段）。理由与取舍见 §4。

---

## 4. 注入引擎（核心 · v1 采用 Model B）

> **v1 不走 ScriptCat 式三引导脚本**，而是**直接 `userScripts.register` 每个脚本**，把 GM 包装作为 `js` 数组**第一个条目**、用户源码作为第二个条目，同世界内先定义 `GM_*` 再跑脚本。这样无需 `scripting` 权限、少一层桥接、正确性最高。
> **v1 仅支持 `USER_SCRIPT` 世界**，不支持 `@inject-into: page`（MAIN 世界）。原因：MAIN 世界无法干净地用 `runtime.onUserScriptMessage` 桥 GM（这正是 ScriptCat 另起 content-script 桥的代价），且 `worldId` 仅在 `USER_SCRIPT` 世界有效。MAIN / `unsafeWindow` 留作后续阶段。

### 4.1 世界配置（一次性，且扩展更新后需重配）
启动时（含 `onInstalled` 的 `update` 分支）调用：
`chrome.userScripts.configureWorld({ messaging: true, csp: "script-src 'self' 'unsafe-inline' 'unsafe-eval' *" })`。
- `messaging: true` 开启专用通道 `runtime.onUserScriptMessage`（不可信来源专用，天然区分用户脚本消息）。
- `csp` 不被支持时（部分 Firefox 版本）降级为 `{ messaging: true }`。
- **关键**：world 配置会随扩展更新被清空，因此 `configureWorld` 必须在每次 `onInstalled` 的 `update` 分支里**重跑**；顺序为**先 `configureWorld` 再 `register`**，否则脚本 messaging 会失败。

### 4.2 每脚本注册（直接 register，GM 包装内联）
- 每个启用脚本 → `chrome.userScripts.register([{ id, worldId, js:[{code: GM_API_WRAPPER}, {code: 用户源码}], matches, excludeMatches, runAt, allFrames }])`。
- `worldId`：为每个脚本分配独立 id（如 `us-<uuid>`），实现脚本间全局变量隔离（贴近 Tampermonkey 行为）。`worldId` 仅在 `USER_SCRIPT` 世界有效，故 `world` 固定省略（默认 `USER_SCRIPT`）。要求 **Chrome 133+ / Firefox 136+**（见 §9 `minimum_chrome_version`）；低于此版本退化为默认共享世界（脚本间会互相看到全局变量，v1 可接受，UI 需提示）。
- `js` 数组顺序：**GM 包装必须在前**，确保 `GM_*` 在用户源码执行前已定义。
- `id` 用稳定 uuid（避免重注册冲突；且不能以 `_` 开头——`_` 为 API 保留前缀）；改脚本用 `update`，删除用 `unregister({ids})`。
- 批量 `register` 失败回退逐条，`Duplicate ID` 时改 `update`（照搬 ScriptCat 容错）。

### 4.3 可用性检测 + 激活引导（必做）
- 检测用版本无关写法：`isUserScriptsAvailable()` 调 `chrome.userScripts.getScripts()` 包 try/catch，抛错即不可用（Chrome 官方推荐做法，全版本适用）。
- **Chrome < 138**：用户需在 `chrome://extensions` 开启**全局「开发者模式」**；不可用 → UI 置灰 + 弹引导 + 轮询，开启后 `chrome.runtime.reload()`。
- **Chrome ≥ 138**：改为扩展详情页的**「Allow User Scripts」按扩展开关**（`chrome://extensions/?id=<本扩展id>`），门槛更低；引导文案与上者不同，需按 `navigator.userAgent` 解析的大版本号分支展示。
- **Firefox**：`userScripts` 放 `optional_permissions`，首次使用时 `permissions.contains({permissions:['userScripts']})` 为假则 `permissions.request` 弹窗申请（无 dev-mode 要求）。

### 4.4 扩展更新恢复
`runtime.onInstalled` 的 `reason === 'update'` 分支：**先 `configureWorld` → 再从 storage 读回全部启用脚本重新 `register`**（userScripts 注册与 world 配置在扩展更新时都会被清空）。

---

## 5. 存储设计（复用 duo-ling 现有层，v1 单存储）

> v1 全部放进 `chrome.storage.local`，**不再拆 `lightning-fs`(IndexedDB)**。开发工具脚本数量少、单脚本源码通常远小于 storage.local 的 ~10MB 配额上限，单存储最简单；若后续出现大脚本/大量脚本再迁移到 IndexedDB（届时只改存储访问层，schema 不变）。

| 数据 | 位置 | 说明 |
|---|---|---|
| 脚本记录（含元数据 + 源码 + 开关） | `chrome.storage.local` 键 `us:script:<uuid>` | 单条记录带源码，整体读写 |
| `GM_setValue` 值 | `chrome.storage.local` 键 `us:gm:<uuid>:<key>` | 按 uuid 隔离脚本间值 |
| 黑名单 / 设置 | `chrome.storage.local` 键 `us:settings` | — |

**脚本记录 schema（storage.local 键 `us:script:<uuid>`）：**
```ts
interface UserScriptMeta {
  uuid: string
  name: string
  enabled: boolean
  matches: string[]
  excludeMatches?: string[]
  runAt: 'document_start' | 'document_end' | 'document_idle'
  // v1 仅实现 'content' / 'auto'（均 → USER_SCRIPT）；'page'(MAIN) 暂不支持，UI 提示
  injectInto: 'page' | 'content' | 'auto'
  grants: string[]          // 声明的 GM_* 权限
  requires?: string[]       // @require（Phase 2/3 实现，前置拼接为 js 条目）
  resources?: Record<string,string> // @resource（Phase 2/3，GM_getResourceText 提供）
  source: string            // 源码直接存 storage.local（v1 不再拆 IndexedDB）
  updateURL?: string
  homepage?: string
}
```

---

## 6. GM_api 桥接层

- **收口**：background 监听 `runtime.onUserScriptMessage`，按 `{ cmd, uuid, args }` 分发（专用不可信通道，天然区分来源）。
- **薄 RPC**：脚本侧 `GM_*` 函数 `chrome.runtime.sendMessage({cmd,uuid,args})` → background 经 `onUserScriptMessage` 处理后回执 `Promise`（封装 `request()` 助函数）。不搬 ScriptCat 的 `packages/message`（过重）。
- **核心子集（第一版实现）：**
  | API | 后台实现要点 |
  |---|---|
  | `GM_setValue` / `GM_getValue` | 读写 `chrome.storage.local`（`us:gm:<uuid>:<key>`） |
  | `GM_deleteValue` / `GM_listValues` | 同上，删除单键 / 列出本脚本全部键（便宜，一并实现） |
  | `GM_info` | 返回该脚本解析出的元数据对象（`@name/@version/@namespace/uuid` 等）；脚本几乎必读，**第一版必做** |
  | `GM_addStyle` | 在 USER_SCRIPT 世界内**直接 `document.head.appendChild(style)`** 即可（DOM 共享，无需经桥）；注入的样式对页面生效 |
  | `GM_xmlhttpRequest` | background 代发 fetch（需 `host_permissions` 覆盖目标域；跨域放行按 `@grant` 显式声明） |
  | `GM_openInTab` | `chrome.tabs.create` |
  | `GM_notification` | `chrome.notifications` |
  | `GM_download` | background 下载 + 保存（或 `chrome.downloads`） |
  | `GM_getResourceText` / `GM_getResourceURL` | 从 `@resource` 取（需先实现 @resource，Phase 2/3） |
  | `GM_log` | 转发 background 日志 |
- 未实现的 `GM_*` 调用 → 抛 `"not implemented"` 并 `console.warn`，不崩。
- **安全**：敏感 `GM_*`（如 `GM_xmlhttpRequest` 跨域）按 `@grant` 显式声明才放行；全部经 `onUserScriptMessage` 单一收口，最小权限。

---

## 7. 管理 UI（工具页）

- **入口**：做成 duo-ling 的一个**工具页**（ToolWorkspace 宿主 + ToolFrame sandbox iframe），与现有工具形态一致；在工具列表里作为"用户脚本管理器"出现。
- **功能**：
  - 脚本列表（名称 / 启用开关 / 最后运行 / 删除）
  - 安装：粘贴源码 或 输入 URL 拉取并解析元数据块
  - 编辑器：**第一版用 `<textarea>`（等宽字体）即可**，CodeMirror/Monaco 留作后续增强
  - 元数据预览：`@name/@match/@grant` 解析结果展示
  - 可用性 / 权限状态横幅（按 §4.3 版本分支文案引导开启）
- **消息链路**：工具页（sandbox iframe）→ `window.cap` → side panel → background 的 `userscript:*` 命令（沿用 `src/lib/window-api.ts` 的 `send` 通道，新增 `userscript` capability 组）。

---

## 8. background 命令处理（新增）

在现有消息路由中新增 `userscript` 命令组（不改动既有 `cap:*` 等），由 SW 内注册表处理：
```
userscript:list      → 返回全部脚本元数据
userscript:install   → 解析源码元数据 → 存 storage → register
userscript:update    → 改源码/元数据 → update 注册
userscript:remove    → unregister + 删存储
userscript:toggle    → 启用/停用 → register/unregister
userscript:getSource → 读源码（供编辑器）
```

---

## 9. manifest / `wxt.config.ts` 改动

> 属项目硬性底线"变更 manifest 权限需确认"范围——本方案已获用户方向确认，落地前再逐项核对。

- **permissions** 增加：`userScripts`。（**不**加 `scripting`——v1 走直接 `userScripts.register`，无需 `chrome.scripting`；`scripting` 仅在后续加 content-script 兜底时才需要。）
- **host_permissions** 增加：`<all_urls>`（`userScripts` 注入目标域所需，Chrome 文档明确要求；同时覆盖 `GM_xmlhttpRequest` 跨域可达范围）。
- **minimum_chrome_version**：设 `"133"`（`worldId` 隔离所需；Firefox 对应 136）。低于此版本退化为默认共享 USER_SCRIPT 世界（脚本间共享全局，v1 可接受，UI 提示）。
- **Firefox 差异**：`userScripts` 放 `optional_permissions`（运行时 `permissions.request`）；`side_panel` 在 Firefox 用 `sidebar_action`（三期跨端已记录，本功能一并补）。
- **CSP**：扩展自身页 CSP 不受影响；userScripts 世界 CSP 由 `configureWorld` 设宽松（`script-src ... 'unsafe-eval' *`——`*` 较宽，开发工具可接受，后续可收紧）。
- 注意：`userScripts` 在 Chrome 的启用方式随版本不同——Chrome <138 需开全局「开发者模式」，Chrome ≥138 改为扩展详情页「Allow User Scripts」按扩展开关（见 §4.3）。管理 UI 必须对此有版本分支引导。

---

## 10. 分阶段实现计划

| 阶段 | 内容 | 交付验证 |
|---|---|---|
| **Phase 0** | 调研 + 方案（本文） | ✅ 已完成 |
| **Phase 1** | 骨架：`wxt.config` 加 `userScripts` 权限 + `minimum_chrome_version` · 存储层（`chrome.storage.local` 单存储读写）· 注册引擎（`configureWorld` + `register/update/unregister` + `onInstalled` 恢复含重 `configureWorld`）· 可用性检测 + 版本分支引导 | `npm run build` 通过；手动装一条写死脚本能注入 |
| **Phase 2** | GM 核心子集桥接（`onUserScriptMessage` + 薄 RPC + 表中 API，含 `GM_info`/`GM_deleteValue`/`GM_listValues`，`GM_addStyle` 直接 DOM）· **`@require`/`@resource` 预处理**（前置拼接 js、资源文本存记录） | 样例脚本调 `GM_setValue/getValue/info`、含 `@require` 的脚本可跑 |
| **Phase 3** | 管理 UI 工具页（列表 + 开关 + 安装(粘贴/URL) + 编辑器(textarea) + 元数据预览 + 可用性/权限横幅） | 工具页能完整增删改启停 |
| **Phase 4** | 闭环打磨：CSP 回退钩子、错误日志面板、`@inject-into: page`(MAIN) 桥接调研 | 含 `@resource` 的脚本可跑 |
| **Phase 5（可选）** | VM 式 content-script 兜底（免 dev-mode / CSP 强拦页）；Firefox `optional_permissions` 流程细化；每脚本 worldId 在旧版 Chrome 的退化处理 | 双端验收 |

每阶段结束跑 `npm run build` 验证（项目无 typecheck 脚本，以 build 为交付前验证）。

---

## 11. 风险与未决

1. **Chrome 启用方式随版本变**：Chrome <138 需全局「开发者模式」；Chrome ≥138 改为扩展详情页「Allow User Scripts」按扩展开关（门槛更低）。两种都在终端用户侧、非代码可绕过——开发向工具可接受，C 端分发需重新评估（VM 路线可绕过，留作 Phase 5）。
2. **Firefox `userScripts` 为 optional**：首次使用需弹 `permissions.request`，且 Firefox 的 `userScripts` 某些属性（如 `worldId`、CSP 配置）支持度与 Chrome 不同，需实测。
3. **`host_permissions: <all_urls>`**：上架审查可能关注；开发向工具可接受。
4. **GM 全量兼容不在第一版**：明确告知用户仅核心子集，避免当成 Tampermonkey 平替。
5. **合规**：ScriptCat 代码零拷贝（GPL）；VM 模式可借鉴（MIT）。
6. **脚本安全**：用户脚本不可信，经 `onUserScriptMessage` 专用通道收口 + 最小权限；敏感 `GM_*`（如 `GM_xmlhttpRequest` 跨域）按 `@grant` 显式声明才放行。
7. **v1 不支持 MAIN 世界**：`@inject-into: page` / `unsafeWindow` 暂不支持（MAIN 世界 GM 桥接未实现），UI 对这类脚本提示"暂不支持"，避免用户误以为能跑。
8. **worldId 版本门槛**：每脚本隔离世界需 Chrome 133+ / Firefox 136+；低于此版本退化为默认共享世界（脚本间共享全局），UI 需提示。

---

## 12. 参考文件索引（去敏）

- ScriptCat：`src/app/service/service_worker/runtime.ts`（注册/configureWorld/可用性检测）、`src/app/service/service_worker/gm_api/gm_api.ts`（GM 实现）、`src/manifest.json`（权限）
- Violentmonkey：`src/manifest.yml`（content_scripts 主注入）、`src/background/utils/preinject.js`（GetInjected）、`src/injected/content/inject.js`（realm 分流/Vault）
- duo-ling 现状：`wxt.config.ts`（当前权限）、`src/lib/window-api.ts`（现有消息协议/PreloadApi 契约）
- 官方文档：Chrome `userScripts` API 参考（developer.chrome.com）、MDN `userScripts`/`RegisteredUserScript`/`WorldProperties`（worldId 133+/136+、messaging、CSP 支持矩阵）
