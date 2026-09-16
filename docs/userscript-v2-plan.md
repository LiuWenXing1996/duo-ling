# 用户脚本新形态 · 实施方案

> 状态：**已实施**（Phase 0–3 已于 2026-09-14 落地；实施偏差与就地修订已并入正文）
> 前置决策：见 `.workbuddy/memory/MEMORY.md`「用户脚本引擎 · 战略定位」——放弃油猴兼容，
> 新形态四支柱：模块化管理 / 自有能力 API（DL，全 async）/ USER_SCRIPT 隔离环境 / 反向中继。
> API 契约（已定型）：`src/lib/userscripts/api-contract.ts` + `docs/userscript-api.md`。
> 与旧设计文档关系：旧 GM 对齐设计（原 `userscript-manager-design.md`，已删除，git 历史可查）中
> 注入引擎 / 存储 / GM 桥按本方案改写，管理 UI 与 background 命令面部分沿用。

---

## 1. 目标态总览

```
┌─ Workbench（扩展 UI 页）─────────────────────────────┐
│ 脚本项目编辑器（文件树 + 多标签 + 配置表单）           │
│ 保存 → esbuild-wasm 打包（多文件源码 → 单 IIFE）       │
│     → 存 bundle → IPC 通知后台重注册                  │
└──────────────┬───────────────────────────────────────┘
               │ chrome.runtime.sendMessage（UI IPC）
┌─ Background SW ──────────────────────────────────────┐
│ script store（chrome.storage.local）                  │
│ registerScript：js = [DL 包装, bundle]                │
│ configureWorld（默认世界 + 每脚本 us-<uuid> 世界）     │
│ onUserScriptMessage ← DL 桥（强类型 dispatch）        │
└──────────────┬───────────────────────────────────────┘
               │ chrome.userScripts.register
┌─ 页面 ────────┴───────────────────────────────────────┐
│ USER_SCRIPT 世界（每脚本独立 worldId）                │
│  [DL 包装] → [bundle IIFE]                           │
│  DL.* → onUserScriptMessage 桥 → 后台                  │
│ （阶段四）DL.page → MAIN 世界 stub → postMessage RPC   │
└───────────────────────────────────────────────────────┘
```

## 2. 现状资产盘点（保留 / 改造 / 删除）

### 原样保留（与 GM 无关，已验证可用）

| 资产 | 位置 | 说明 |
|---|---|---|
| 可用性检测 + 三分支引导 | `engine.ts` `getUserScriptsStatus` | Chrome ≥138 / <138 / Firefox |
| 世界配置 + 自愈 + 降级链 | `engine.ts` `configureWorld` / `ensureWorldsConfigured` | messaging 优先、CSP 降级 |
| 注册幂等 + 并发串行化 | `engine.ts` `registerChain` | dev 重载场景已踩过坑 |
| 扩展更新恢复顺序 | `engine.ts` `recoverOnUpdate` | 先 configureWorld 再 register |
| 错误环形日志 + 面板 | `store.ts` `us:errors` + UI | 隔离世界专属优势，保留 |
| 后台特权 fetch | `engine.ts` `fetchText` | DL.fetch 的实现基础 |
| 桥的超时兜底 / sender 校验 | `gm-bridge.ts` | 移植到新桥 |

### 改造（换协议 / 换 schema，骨架不动）

| 资产 | 改动 |
|---|---|
| `gm-bridge.ts` | → `dl-bridge.ts`：`{ __gm, cmd, args }` 弱类型 → `ApiRequest` 可辨识联合 + `ApiResponse` 信封，switch 穷尽性检查 |
| `engine.ts` `buildGmWrapper` | → `buildDlWrapper`：挂 `window.DL`（契约 `DuoLingApi`），一期 API；保留错误上报（`__usError` → 归入 `ApiEvent`） |
| `engine.ts` `registerScript` | js 数组：`[DL 包装, bundle.code]`（`@require` 链路删除）；注入尾部拼 `sourceURL` |
| `types.ts` | `UserScriptMeta` → `ScriptProject`（文件树 + 配置 + bundle，见 §4） |
| `store.ts` | 键空间沿用 `us:script:<uuid>` / `us:gm:<uuid>:<key>`（**GM 值键不改名，旧数据无损**）；schema 加 `v` 版本字段 |
| `background.ts` | install/update 命令 → 项目 CRUD 命令；桥监听换 `dl-bridge` |
| `UserscriptManager.vue` | ~~列表/启停/错误面板骨架保留，安装入口改「新建项目」~~ **2026-09-15 已删除**：可用性横幅 / 错误日志并入 `UserscriptListPanel.vue`（列表标签页是脚本管理唯一入口）；**粘贴安装功能整体移除**（UI、`userscript:install` / `state:install` 协议、`installProject` 一起删），装脚本只剩零输入新建与 AI 生成 |
| `ui-client.ts` | IPC 封装跟着命令面走 |

### 删除

- `parser.ts`（`==UserScript==` 解析）——新形态配置来自表单/JSON，不再解析注释
- `resolveIncludes`（`@require` / `@resource` 抓取）——被 ESM import + 构建期依赖替代
- `buildGmWrapper` 全部 `GM_*` 挂载、`BUILTIN_PROBE_SOURCE`（探针改写为新形态示例脚本）
- `collectCspWarnings` 中 `@require` 相关分支
- `background.ts` 的 `userscript:fetchUrl` 命令（@require 抓取时代产物，随 resolveIncludes 一并删除）

## 3. 阶段划分

每个阶段独立可验证、可合入；**顺序即依赖**，但 Phase 2 起每阶段结束系统都处于可用状态。

### Phase 0 — 桥与包装切换（纯重构，无新能力）

**目标**：GM 体系拆掉，`DL` 上线；脚本源码仍是单文件 classic script（先不做模块化），跑通端到端。

改动：
1. `dl-bridge.ts`（新）：`onUserScriptMessage` 监听 `{ __dl: true, req: ApiRequest }`，按 `c` 分发；保留 sender `userScript.scriptId` 白名单校验与 30s 超时兜底；错误也走 `ApiResponse { ok: false, code }`。
2. `engine.ts` `buildDlWrapper`：
   - 挂 `window.DL`，形态 = `DuoLingApi`（一期走桥：store / fetch / notify / download / tabs；本地直写：style / log / info / clipboard）；
   - `DL.fetch` 后台回 `FetchPayload`，包装内补 `text()/json()/arrayBuffer()` 便捷方法；
   - `DL.clipboard.write` 世界内直写 `navigator.clipboard.writeText`（2026-09-14 决策，失败 reject 不静默，不走桥）；
   - `menu` / `store.watch` / `cookie.*` 二期（契约已注明，包装内留 stub 并抛 `NOT_AVAILABLE`，不静默）；
   - 错误上报：`window.onerror` / `unhandledrejection` → `{ __dlEvent: true, event: DlEvent }`（契约 `DlEvent`），后台收进 `us:errors`（phase 字段沿用）。
3. `registerScript`：`js.push({ code: bundle })` 尾部拼 `\n//# sourceURL=duoling://script/<uuid>/<name>.js`（DevTools 显示真名 + 主世界时代错误过滤的预置位，零风险先加上）。
4. `background.ts`：桥初始化换新文件；`userscript:install`（**2026-09-15 随粘贴安装功能整体移除**）以 **`ScriptProject`（v:1）单文件形状**落盘（`files = { [entry]: 源码 }`，`entry = 'main.js'`，配置来自表单）——**ScriptProject 类型定义提前到 Phase 0**，避免 Phase 0 产物缺 `v` 字段被 Phase 1 的 deprecated 判定误杀。

验收：
- 新建脚本（表单配 `matches`，源码 `DL.store.set('a', 1)` → 另一页面 `DL.store.get('a')`）往返成功；
- `DL.fetch` 跨域请求成功（受控白名单站点）；
- 运行期 throw 的错误出现在错误面板，且 DevTools 里脚本显示真名而非 anonymous；
- `npm run typecheck` 零错误；旧 GM 脚本（如有残留）明确报「不支持的格式」而非静默。

### Phase 1 — 脚本项目数据模型 + 配置格式

**目标**：单文件 → 项目（文件树 + 入口 + 配置），为构建管线铺地基。

新类型（`types.ts` 重写）：

```ts
/** 脚本配置：全部直接映射 chrome.userScripts 原生注册字段，无 metadata 中间层 */
interface ScriptConfig {
  matches: string[]                  // 必填，match pattern
  excludeMatches?: string[]          // match pattern
  includeGlobs?: string[]           // glob，AND 收窄
  excludeGlobs?: string[]
  allFrames: boolean                // 默认 true（对齐主流：靠排除关 iframe）
  runAt: 'document_start' | 'document_end' | 'document_idle'  // 默认 document_end（对齐主流）
}

/** 一个脚本 = 一个项目 */
interface ScriptProject {
  v: 1                               // schema 版本
  uuid: string
  name: string
  enabled: boolean
  config: ScriptConfig
  files: Record<string, string>     // 虚拟文件树：路径 → 源码（相对根）
  entry: string                      // 入口文件路径，默认 'main.js'
  bundle?: { code: string; builtAt: number }  // 最近一次构建产物
  createdAt: number; updatedAt: number
}
```

改动：
1. `store.ts`：`us:script:<uuid>` 存 `ScriptProject`；**deprecated 判定 = 记录含 GM metadata 特征字段**（`rawMeta` / `grants` / `requires` / `requireCodes` / `source` 等，Phase 0 起产物已是 `v:1` ScriptProject，不会误判），列表可见、不注册、提供一键清理，**不自动迁移**。
2. `background.ts` IPC 面换为：`script:create` / `script:update`（全量保存）/ `script:delete` / `script:list` / `script:get` / `script:rebuild`（重注册单脚本）。
3. `engine.ts` `registerScript(project)`：从 `project.bundle.code` 注入。~~无 bundle 时回退 `files[entry]` 单文件直跑~~ → **回退已删除（2026-09-15 产物不变量，老大拍板：SW 只注册最终产物，没有直跑源码的逻辑）**：新建 / 安装在写侧（`project-write`）先构建出产物再落盘，`updateProjectFiles` 的 bundle 必填，`resolveInjectCode` 无产物即抛错（注册降级为 registerError 警告）；`matches` 等直接取自 `config`。
4. GM 值键空间 `us:gm:<uuid>:<key>` 保持不变（旧脚本的私有数据不丢）。

验收：手工在 storage 写入一个两文件项目 + bundle，启停/匹配/排除（glob）/iframe（allFrames）行为正确；旧 GM 记录出现在「已弃用」分组。

### Phase 2 — esbuild-wasm 构建管线（模块化的核心）

**目标**：保存时把多文件源码（含 TS/JSX）打包成单 IIFE，注入链路零改动。

设计要点：
1. **esbuild-wasm 只在扩展 UI 页（workbench / side panel）运行**，不进 SW。`esbuild.wasm`（**实测 13.98MB**，2026-09-14 核实，早期稿写的「约 10MB」偏小）打包进扩展 `public/`，编辑器首次保存时懒加载一次，进程内复用（`esbuild.initialize({ wasmURL })`）。
   - **为何不进 SW**（2026-09-14 核查 esbuild-wasm 0.28.2 源码）：技术上可行，但默认 Worker 模式走 `new Worker(URL.createObjectURL(blob))`，而 `URL.createObjectURL` 未暴露给 ServiceWorker，必须改成 `initialize({ worker: false })`；且 MV3 SW 空闲约 30s 被回收，每次冷启都要重付 wasm 获取 + 编译。详见 [一期收编提案·被否方案](./proposals/done/ai-userscript-phase1-archive.md)。
   - ~~MV3 extension_pages 最小 CSP 已含 `'wasm-unsafe-eval'`，无需改 manifest（已查证）。~~ **此论断有误（2026-09-15 E2E 冒烟实测证伪）**：MV3 默认 CSP 就是 `script-src 'self'`，**不含** `'wasm-unsafe-eval'`，wasm 在 offscreen 会直接被拦。修法：`wxt.config.ts` manifest 显式声明 `content_security_policy.extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"`（仅放开 WebAssembly 编译，不含 `unsafe-eval` 的 JS eval 语义，老大已批准）。
2. 构建入口：
   ```ts
   build(project): bundle
   // entryPoints: [project.entry]
   // format: 'iife'，bundle: true，write: false
   // 虚拟文件：onLoad/onResolve 插件把 files map 喂给 esbuild（filter: /.*/，namespace: 'mem'）
   // 外部依赖分两档：
   //   ① https:// 开头说明符：插件拦截 → UI 页 fetch（扩展页有 host 权限，免 CORS）→ 内容喂给 esbuild，
   //      并把远程源码**持久化进项目 files**（否则断网重构建失败），UI 提示「拉取了哪些远程依赖」；
   //      远程导入链按 URL 解析（2026-09-14 修订）：esm.sh 入口是「同源绝对路径转发」形态
   //      （`export * from "/pkg@ver/es2022/x.mjs"`），按字面「单文件」实现会拒掉主流 CDN——
   //      故 remote 命名空间内相对/绝对路径均 new URL(p, importer) 解析后逐条 fetch；
   //      **仅拒绝裸包名说明符**（远程链内同样）；已持久化的远程文件重建时直接走 mem 不再发请求
   //   ② 裸 npm 说明符（`from 'lodash'`）与 `node:` 前缀：拦截并报友好错误「不支持 npm 包名，请改 CDN URL」
   // 入口约束：顶层 export 在 iife 格式下需 globalName——模板与文档约定「入口文件无顶层 export」
   // 需要时禁用 network（离线保存）可加开关
   ```
3. 产物策略：**默认不 minify**（报错行号可读）；存 `bundle.code + builtAt`。sourcemap 可选后置（`sourceURL` 已保证 DevTools 可定位到 bundle；要映射回源文件再上 `sourcemap: 'inline'`）。
4. 保存流程：编辑器保存 → build → 成功：写 `files + bundle` → IPC `script:update` → SW 重注册该脚本；失败：esbuild 的报错（带源文件行号）直接显示在编辑器内，**不落盘半成品**。
5. `DL` 的引入方式：全局 `window.DL` 已由包装注入，模块代码直接用；附带提供 `.d.ts`（见 Phase 3）。后续可选增强：虚拟模块 `duoling`（`export const DL = window.DL`）获得 tree-shaking 与命名导入，**后置，不进本期**。
6. `export`/TS 语法在构建期处理，注入的是纯 classic IIFE——运行期不存在「import 语法报错」类静默失败。

验收：三文件项目（main.ts + 两个依赖模块，含一个 `import` 远程 ESM 单文件库）保存后构建成功、注入生效；故意写语法错，编辑器显示文件名+行号；写裸 npm 说明符得到友好报错；断网状态下纯本地项目仍可构建保存（含已持久化的远程依赖）。

### Phase 3 — 编辑器 UI + 导入导出

**目标**：把「写脚本」变成「写小项目」的完整体验。

1. 项目列表（沿用现骨架）→ 项目编辑视图：**文件树 + 多标签编辑器 + 配置表单**三栏。
2. 编辑器内核：一期 `textarea` + 等宽字体 + 保存时构建报错行内提示即可；CodeMirror 6（js/ts 高亮）作为独立增强项后置，不阻塞主链路。
3. 配置表单：matches / excludeMatches / includeGlobs / excludeGlobs（数组编辑）、allFrames / runAt 下拉——**用户永远不接触注释语法**。
4. 新建脚本项目模板：`main.js` + 空配置，预置一段带 `DL.log` 的示例代码（替代旧探针）。
5. 导出/导入：**zip**（`project.json` + 源文件），文件树完整往返。**前置**：需引入 zip 打包库（倾向 `fflate`，零依赖体量小）——属新增依赖，实施前与老大确认。**2026-09-15：方案已定稿**，见 [userscript-zip-transfer.md](./userscript-zip-transfer.md)，待实施。
6. `.d.ts` 交付：构建管线把 `DuoLingApi` 声明 + `declare const DL` 生成到导出 zip 里（或项目内 `dl.d.ts`），脚本作者有类型提示。
7. （可选，默认不做）`.user.js` 导入转换器：解析 metadata → 表单配置、单文件 → 单文件项目。成本低价值存疑，老大要再开。

验收：新建 → 编辑三文件 → 保存构建 → 启停 → 导出 zip → 删除 → 导入 → 行为一致。

### Phase 4 — 反向中继 `DL.page`（另立规范，本计划只留位置）

- 契约中预留 `DL.page` 命名空间；协议（句柄 / 事件转发 / 预置 hook / 握手防伪）独立成 `docs/userscript-page-relay.md` 再实施。
- 已知天花板（设计输入）：结构化克隆限制 → 句柄方案；同步动态判断 / 对象同一性 / 逐帧高频不可行。
- stub 注册进 MAIN 世界用 `chrome.userScripts.register({ world: 'MAIN' })`，按「有脚本声明了 page 访问」动态注册/注销。
- **不在本期承诺**，前三阶段跑稳后单独立项。

## 4. 已定决策汇总（本方案不再讨论）

| 决策 | 结论 |
|---|---|
| 生态兼容 | 不兼容油猴；`GM_*` / metadata / `@require` / `unsafeWindow` 全链路删除 |
| API 形态 | 全 async；命名空间 `DL`；契约唯一真相源 = `api-contract.ts` |
| 注入世界 | USER_SCRIPT + 每脚本 `worldId`；不切 MAIN |
| 匹配规则 | Chrome 原生四字段（matches / excludeMatches / includeGlobs / excludeGlobs）+ allFrames + runAt，表单配置 |
| runAt 默认 | `document_end`（对齐主流；现 `document_idle` 偏晚且注释有误） |
| allFrames 默认 | `true` |
| 模块化 | 保存时 esbuild-wasm 打包成 IIFE；运行时零打包逻辑 |
| GM 私有数据 | 键空间 `us:gm:` 原样保留，旧数据不丢 |
| minify | 默认关闭（可读报错优先） |
| cookie | `DL.cookie.*` 挪二期（2026-09-14）：不加 `cookies` 权限，实现时才加，url 缺省由包装层填 `location.href` |
| 剪贴板 | `DL.clipboard.write` 世界内直写（2026-09-14）：`navigator.clipboard.writeText`，失败 reject 不静默，不走桥 |

## 5. 风险与验证点

| # | 风险 | 验证方式 | 阶段 |
|---|---|---|---|
| 1 | esbuild-wasm 约 14MB（实测 13.98MB）拖慢扩展装载 | 放 `public/` 懒加载，只在打开编辑器且首次保存时 load；实测 workbench 首屏无回归；side panel 侧的同款等待见 [一期收编提案·风险与代价（风险 2）](./proposals/done/ai-userscript-phase1-archive.md) | P2 |
| 2 | UI 页 fetch 远程依赖受 CSP/CORS 限制 | 扩展页有 `<all_urls>` host 权限应免 CORS；实测 jsdelivr / unpkg | P2 |
| 3 | 大项目保存时构建卡 UI | wasm 在 worker？一期先同步构建 + loading 态，实测慢再迁 Web Worker | P2 |
| 4 | bundle 内 `eval` / `new Function` 被 world CSP 拦 | 已有宽松 CSP 配置链；构建产物理论无 eval（esbuild 目标环境不含）；保留 `collectCspWarnings` 的 eval 检测挂到保存时（检测对象用 `bundle.code` 而非源码） | P0 |
| 5 | `sourceURL` 方案 DevTools 实际显示效果 | Phase 0 验收项 | P0 |
| 6 | 旧脚本用户困惑（装 .user.js 无反应） | 安装入口明确提示「不支持油猴格式」+（可选）导入转换器 | P3 |
| 7 | `DL.clipboard.write` 世界内直写受用户手势/CSP 限制 | 失败 reject 明确错误；实测覆盖面，不足再评估 offscreen document（需加 `offscreen` 权限） | P0 |
| 8 | `chrome.storage.local` 默认 10MB 配额（项目记录含源码 + bundle 双份） | 自用脚本量级远小于配额；管理页显示项目体积，超限前预警即可 | P2 |

## 6. 明确不做

- `GM_*` 任何形式的兼容层 / shim / 双轨期
- 运行时模块打包（blob 重写 / import maps / `GM.import`）——被构建期方案整体取代
- 手动 `<script>` 注入路径（VM 式）——注册制保住的平台优势不换
- popup 页脚本菜单——`DL.menu.register` 二期涉及 UI 联动，随长连接阶段一起定
- 脚本自动更新 / `.meta.js` 检查——新形态无此需求，真需要分享时走导出 zip
