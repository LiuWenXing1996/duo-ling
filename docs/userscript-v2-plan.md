# 用户脚本新形态 · 实施方案

> 状态：方案稿 v1（2026-09-14，待老大评审）
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
| `UserscriptManager.vue` | 列表/启停/错误面板骨架保留，安装入口改「新建项目」 |
| `ui-client.ts` | IPC 封装跟着命令面走 |

### 删除

- `parser.ts`（`==UserScript==` 解析）——新形态配置来自表单/JSON，不再解析注释
- `resolveIncludes`（`@require` / `@resource` 抓取）——被 ESM import + 构建期依赖替代
- `buildGmWrapper` 全部 `GM_*` 挂载、`BUILTIN_PROBE_SOURCE`（探针改写为新形态示例脚本）
- `collectCspWarnings` 中 `@require` 相关分支

## 3. 阶段划分

每个阶段独立可验证、可合入；**顺序即依赖**，但 Phase 2 起每阶段结束系统都处于可用状态。

### Phase 0 — 桥与包装切换（纯重构，无新能力）

**目标**：GM 体系拆掉，`DL` 上线；脚本源码仍是单文件 classic script（先不做模块化），跑通端到端。

改动：
1. `dl-bridge.ts`（新）：`onUserScriptMessage` 监听 `{ __dl: true, req: ApiRequest }`，按 `c` 分发；保留 sender `userScript.scriptId` 白名单校验与 30s 超时兜底；错误也走 `ApiResponse { ok: false, code }`。
2. `engine.ts` `buildDlWrapper`：
   - 挂 `window.DL`，形态 = `DuoLingApi`（一期：store / fetch / notify / download / clipboard / tabs / cookie + 本地 style / log / info）；
   - `DL.fetch` 后台回 `FetchPayload`，包装内补 `text()/json()/arrayBuffer()` 便捷方法；
   - `menu` / `store.watch` 二期（契约已定义，包装内留 stub 并抛 `NOT_AVAILABLE`，不静默）；
   - 错误上报：`window.onerror` / `unhandledrejection` → `ApiEvent` 风格消息（`{ __dlEvent: 'error', ... }`），后台收进 `us:errors`（phase 字段沿用）。
3. `registerScript`：`js.push({ code: bundle })` 尾部拼 `\n//# sourceURL=duoling://script/<uuid>/<name>.js`（DevTools 显示真名 + 主世界时代错误过滤的预置位，零风险先加上）。
4. `background.ts`：桥初始化换新文件；`userscript:install` 临时接受「无 metadata 裸 JS + 表单配置」。

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
1. `store.ts`：`us:script:<uuid>` 存 `ScriptProject`；读到无 `v` 字段的旧记录标记 `deprecated`（列表可见、不注册、提供一键清理），**不自动迁移**（自用存量少，转换无意义）。
2. `background.ts` IPC 面换为：`script:create` / `script:update`（全量保存）/ `script:delete` / `script:list` / `script:get` / `script:rebuild`（重注册单脚本）。
3. `engine.ts` `registerScript(project)`：从 `project.bundle.code`（无 bundle 时回退 `files[entry]` 单文件直跑——**兼容 Phase 0 状态**）注册；`matches` 等直接取自 `config`。
4. GM 值键空间 `us:gm:<uuid>:<key>` 保持不变（旧脚本的私有数据不丢）。

验收：手工在 storage 写入一个两文件项目 + bundle，启停/匹配/排除（glob）/iframe（allFrames）行为正确；旧 GM 记录出现在「已弃用」分组。

### Phase 2 — esbuild-wasm 构建管线（模块化的核心）

**目标**：保存时把多文件源码（含 TS/JSX）打包成单 IIFE，注入链路零改动。

设计要点：
1. **esbuild-wasm 只在扩展 UI 页（workbench）运行**，不进 SW。`esbuild.wasm`（约 10MB）打包进扩展 `public/`，编辑器首次保存时懒加载一次，进程内复用（`esbuild.initialize({ wasmURL })`）。
   - MV3 extension_pages 最小 CSP 已含 `'wasm-unsafe-eval'`，无需改 manifest（已查证）。
2. 构建入口：
   ```ts
   build(project): bundle
   // entryPoints: [project.entry]
   // format: 'iife'，bundle: true，write: false
   // 虚拟文件：onLoad/onResolve 插件把 files map 喂给 esbuild（filter: /.*/，namespace: 'mem'）
   // 外部依赖（https:// 开头的 import 说明符）：插件拦截 → UI 页 fetch（扩展页有 host 权限，免 CORS）→ 内容喂给 esbuild，并在 UI 提示「拉取了哪些远程依赖」
   // 需要时禁用 network（离线保存）可加开关
   ```
3. 产物策略：**默认不 minify**（报错行号可读）；存 `bundle.code + builtAt`。sourcemap 可选后置（`sourceURL` 已保证 DevTools 可定位到 bundle；要映射回源文件再上 `sourcemap: 'inline'`）。
4. 保存流程：编辑器保存 → build → 成功：写 `files + bundle` → IPC `script:update` → SW 重注册该脚本；失败：esbuild 的报错（带源文件行号）直接显示在编辑器内，**不落盘半成品**。
5. `DL` 的引入方式：全局 `window.DL` 已由包装注入，模块代码直接用；附带提供 `.d.ts`（见 Phase 3）。后续可选增强：虚拟模块 `duoling`（`export const DL = window.DL`）获得 tree-shaking 与命名导入，**后置，不进本期**。
6. `export`/TS 语法在构建期处理，注入的是纯 classic IIFE——运行期不存在「import 语法报错」类静默失败。

验收：三文件项目（main.ts + 两个依赖模块，含一个 `import` 远程 ESM 库）保存后构建成功、注入生效；故意写语法错，编辑器显示文件名+行号；断网状态下纯本地项目仍可构建保存。

### Phase 3 — 编辑器 UI + 导入导出

**目标**：把「写脚本」变成「写小项目」的完整体验。

1. 项目列表（沿用现骨架）→ 项目编辑视图：**文件树 + 多标签编辑器 + 配置表单**三栏。
2. 编辑器内核：一期 `textarea` + 等宽字体 + 保存时构建报错行内提示即可；CodeMirror 6（js/ts 高亮）作为独立增强项后置，不阻塞主链路。
3. 配置表单：matches / excludeMatches / includeGlobs / excludeGlobs（数组编辑）、allFrames / runAt 下拉——**用户永远不接触注释语法**。
4. 新建脚本项目模板：`main.js` + 空配置，预置一段带 `DL.log` 的示例代码（替代旧探针）。
5. 导出/导入：**zip**（`project.json` + 源文件），文件树完整往返。
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

## 5. 风险与验证点

| # | 风险 | 验证方式 | 阶段 |
|---|---|---|---|
| 1 | esbuild-wasm 10MB 拖慢扩展装载 | 放 `public/` 懒加载，只在打开编辑器且首次保存时 load；实测 workbench 首屏无回归 | P2 |
| 2 | UI 页 fetch 远程依赖受 CSP/CORS 限制 | 扩展页有 `<all_urls>` host 权限应免 CORS；实测 jsdelivr / unpkg | P2 |
| 3 | 大项目保存时构建卡 UI | wasm 在 worker？一期先同步构建 + loading 态，实测慢再迁 Web Worker | P2 |
| 4 | bundle 内 `eval` / `new Function` 被 world CSP 拦 | 已有宽松 CSP 配置链；构建产物理论无 eval（esbuild 目标环境不含）；保留 `collectCspWarnings` 的 eval 检测挂到保存时 | P0 |
| 5 | `sourceURL` 方案 DevTools 实际显示效果 | Phase 0 验收项 | P0 |
| 6 | 旧脚本用户困惑（装 .user.js 无反应） | 安装入口明确提示「不支持油猴格式」+（可选）导入转换器 | P3 |

## 6. 明确不做

- `GM_*` 任何形式的兼容层 / shim / 双轨期
- 运行时模块打包（blob 重写 / import maps / `GM.import`）——被构建期方案整体取代
- 手动 `<script>` 注入路径（VM 式）——注册制保住的平台优势不换
- popup 页脚本菜单——`DL.menu.register` 二期涉及 UI 联动，随长连接阶段一起定
- 脚本自动更新 / `.meta.js` 检查——新形态无此需求，真需要分享时走导出 zip
