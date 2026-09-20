# 架构

> **本文件是运行时架构的唯一登记处**：载体与运行时、对话链路、脚本注入、页面上下文、存储分库、统一保存、用户脚本版本管理、数据广播、依赖构建、构建信息注入。
> 改这些实现前读它，改完就地更新。
>
> 相关：协作约定与红线见 [AGENTS.md](AGENTS.md)；上手与手测见 [README.md](README.md)；扩展**自身**版本号见 [VERSIONING.md](VERSIONING.md)。

## 形态

Chrome MV3 扩展（background service worker + side panel + 工作台标签页）。原 Electron 桌面版实现已不在工作区，需要参照时从 git 历史取回。

## 载体与运行时

| 上下文 | 载体 | 角色 |
| --- | --- | --- |
| 扩展页 | `sidepanel.html`（side panel） | 指令入口与观察窗（对话界面） |
| 扩展页 | `workbench.html`（标签页） | 重界面工作区（脚本管理 / 运行日志 / 设置等） |
| SW | `background.ts` | **能力运行时**：用户脚本注册（`chrome.userScripts`）+ 状态库写命令转发 + offscreen 容器管理 + 模型配置中转 |
| 离屏文档 | `offscreen.html`（按需创建） | AI 生成链路的执行宿主 + esbuild 构建宿主 + `duoling-fs` 源码的唯一写入方 |
| 注入世界 | USER_SCRIPT（第三方页面内） | 用户脚本自身逻辑，只能经 `window.DL` 桥接 |

两个载体各承载什么、标签页有哪些，见 [README.md](README.md)「载体分工」。

## 对话链路

侧边栏只做指令入口与观察；整条链路（`streamText` + tools）跑在 **offscreen document**，侧边栏经 IPC 订阅事件流；跨域仍由 `host_permissions` 授权。offscreen 容器按需创建（`src/lib/offscreen.ts`）。

- **流式静默超时（防限流）**：`runLoop` 泵流期间挂 `createIdleGuard`（`src/lib/offscreen-chat/idle-guard.ts`），两次 chunk 间隔超 `STREAM_IDLE_TIMEOUT_MS`（默认 60s）即判定 provider 卡死（有连接但不吐 token），主动 `abort` 并推 error 块「请求超时…已自动中止」。避免静默卡死的请求长期占用网关连接/并发配额、累积触发限流；用户手动停止走 `abortChat`，与此计时无关。模型配置探活 `testChat` 另有 15s 超时。

## 脚本注入

`chrome.userScripts` + USER_SCRIPT 世界 + `window.DL` 桥接（`src/lib/userscripts/`）。

- **DL.fetch 的 forbidden header 覆写**（Cookie / Referer / UA 等）与 `redirect:'manual'` 走 DNR session 规则按请求挂/撤 + 观察型 webRequest（`dl-fetch-priv.ts`，2026-09-19 经评审批准；权限 `declarativeNetRequestWithHostAccess` + `webRequest` 均不新增用户可见提示）。
- **覆写期间同 host 互斥**（读写锁，防规则污染并发请求）——粒度限制与生命周期兜底见 [README.md](README.md) 坑 14。
- **USER_SCRIPT 世界不配 `csp`**：回落浏览器默认的严 CSP（禁 `eval` / `new Function`），不额外给 AI 生成的脚本「执行任意字符串」的能力。生成提示词与 `script_spec` 明令避开，保存时由 `collectCspWarnings` 对含 `eval` 的注入代码给非阻塞警告（底线见 [AGENTS.md](AGENTS.md) 硬性底线「脚本世界 CSP」）。

## 页面上下文

- **点选元素**：`chrome.userScripts.execute()` 按需注入内置拾取器，产物暂存后随下一条消息发出。
- **页面快照**：AI 侧 `page_snapshot` 工具经 SW 采集。

## 存储（IndexedDB 分库：源码 / 注册态 / 脚本数据 / 观测数据 / 应用配置 / 会话，2026-09-19 重构）

> 分库写权限是硬边界：**注册链路对 offscreen 存活零依赖**。

① **源码唯一来源 `duoling-fs`**（lightning-fs，IndexedDB 后端，**只许 offscreen 碰**，`us-fs.ts` 单例）：每脚本一仓 `/uscripts/<uuid>/`——工作树 `files/` 即当前源码（未提交改动 = 草稿），git 历史 = 每次保存的版本（`us-git.ts`，仓损坏只丢历史不丢脚本）；SW/扩展页读不到 lfs，**源码读写一律走 `fs:*` 命令向 offscreen 取**（`offscreen-fs-commands.ts`）。

② **注册态库 `duoling-state`**（独立 IndexedDB，`state-db.ts`/`project-store.ts` 读、`project-write.ts` 写，**写只归 offscreen**）= 每脚本一条 `ScriptProject`：只存产物 `bundle` + 元数据 + enabled + `fileCount` 缓存，**不含源码**——SW 注册直读 `bundle`，注册链路对 offscreen 存活零依赖（既定不变量）。

③ **脚本数据库 `duoling-usdata`**（`usdata-db.ts`，**写只归 SW**）：`DL.store` 值（gm store，复合主键 `[uuid,key]`）与 `DL.tab`（tab store，`[uuid,tabId]`）——**脚本自己写的数据**（不可信、无上限），复合主键 + 索引替代旧 chrome.storage 字符串键拼接，范围查询不再全库扫描。

④ **观测数据库 `duoling-runtime`**（`runtime-db.ts`，**写只归 SW**）：错误日志（errors store，单记录环形 ≤ `ERROR_LOG_MAX`）、运行统计（stats store，每脚本一记录：总次数 / 最后运行时间 / 最近一次运行错误数）与运行日志（runlog store，全局环形 ≤ `RUN_LOG_MAX`）——统计与日志**并进同一事务写入**（`mutateStatsAndLog` 跨 store，逐条日志不额外放大写入）；读改写在事务内天然原子，chrome.storage 时代的进程内串行队列已随之删除；错误明细按 runId 与日志关联，工作台「运行日志」标签页 = 时间线（运行行 + 孤儿错误行，`listRunTimeline` 合并读）。用户脚本的存储**全部落 IndexedDB**；DL.store 写出口发变更事件（`onGmValueChange`，值未变 / 删不存在键不发）。

⑤ **应用配置库 `duoling-app`**（`app-db.ts`，泛用 kv store）：模型配置（`modelProfiles`，API Key 经 AES-GCM 加密落盘，见 `src/lib/key-cipher.ts`——**密钥同存本机，属防扫描级而非保密级**）、key-cipher DEK、MAIN 世界桩密钥（`pageSecret`）——扩展自己的小数据；`chrome.storage.local` 已清零。

⑥ **会话库 `duoling-chat`**（`conversation-store.ts` 读写，**唯一写方 = offscreen**，侧边栏只读订阅）：会话与消息 + 生成任务快照（tasks store，宿主被杀后可续）——它不在 userScripts 链路里，故与 `duoling-state` 分开。

DevTools 里按库名过滤：`duoling-fs` / `duoling-state` / `duoling-usdata` / `duoling-runtime` / `duoling-app` / `duoling-chat`（**不存在名为 `duoling` 的库**）。

## 统一保存（2026-09-19 经评审确认）

一切源码落盘（编辑器保存 / AI 收尾 / 历史恢复 / zip 导入 / 新建）收敛到 offscreen 单一入口 `project-write.saveSource`：写工作树 → git 提交 → **立刻构建** → 写状态库 → 出口广播。

- **保存恒成功**（提交即保存，不再以构建成功为前提）；构建失败**产物置空**（`bundle=undefined`），脚本立即停止注入（旧产物不兜底，刷新目标页失效）。
- 编辑内容只活在页面内存（草稿机制已删），关标签前的 dirty 确认弹窗保留。
- **zip 导入例外（同日拍板）：导入 ≠ 构建**——导入只落源码 + 占位注册态（`lastBuildAt=0` 为「从未构建」标记，列表按「构建中」展示而非失败），构建由 `project-write` 的后台串行队列静默接续（导入即时返回，报告不含构建诊断）；队列被中断的脚本由 offscreen 启动对账 `rebuildPendingProjects` 重排。
- 后台链路不经命令面，写完状态库**必须自己发** `broadcastDataChange`。

## 用户脚本版本管理

`isomorphic-git`（纯 JS），仓在 `duoling-fs`——每次保存/导入/回滚 = 一次提交（恢复走「产生新提交」而非 reset，历史不可变）；仓损坏只丢历史，源码在工作树里。注册/注入以状态库 `duoling-state` 的 `bundle` 为准，编辑器以 `duoling-fs` 工作树为基准。

> 这里指**用户脚本自身**的 git 历史，不是扩展版本号；扩展版本号机制见 [VERSIONING.md](VERSIONING.md)。

## 数据变更广播（跨页面同步）

IDB 没有变更通知，「别处改了数据、这个页面还是旧的」靠 `src/lib/data-broadcast.ts` 补：写侧落盘成功后 `broadcastDataChange(域, uuid?)` 发一条**只含域+uuid、不带数据**的通知（BroadcastChannel 同源多播，不唤醒休眠 SW；无 BC 降级 `runtime.sendMessage`），读侧组件用 `useDataSync(域, reload)` 订阅后自行回拉权威存储（同 `domain+uuid` 100ms 合并防风暴）。

- 广播埋在写出口：offscreen `handleStateCommand`（`script` 域）、`conversation-store` 写函数（`conversation`）、`userscripts/store.ts`（`error`）、`userscripts/usdata-db` 写出口经 store.ts（gm 变更事件）与 `model-store.ts` 写出口（`model`）。
- **新增写路径必须同步埋广播**；前端新面板按域接 `useDataSync`，不再靠手动刷新兜底。编辑器有未保存改动时不自动重载，只提示「已在别处被修改」。

## 依赖构建（esbuild-wasm，offscreen 独占）

两条通道：

① **ESM 导入链**：VFS 插件按 URL 解析、逐条 fetch 持久化进 files（断网可重构建）。

② **UMD / 资源依赖（`config.deps`，2026-09-19 提案拍板）**：保存时缓存优先拉取进 `_deps/`（确定性文件名 = sha256(url) 前缀 + `index.json` 清单，随 git / zip / 历史一并流转，孤儿自动清理），**JS 文本依赖只拼接进 bundle 头部**（不进 esbuild 模块图、不进资源表），其余打成 `DL.__res` 表供 `DL.resource(url)` 读（挂 DL 自身，不开新全局；文本/二进制按 content-type，octet-stream 与缺失时按扩展名兜底再兜文本）。拉取失败 = 构建失败（产物置空，统一保存语义）。

**依赖缓存管理（同日拍板，清/刷分开）**：编辑器 deps 表单旁两按钮，操作已保存工作树——「清依赖缓存」只删 `_deps/`（不拉不建，bundle 保留，下次构建冷拉）；「刷新依赖」无视缓存全量重拉且**事务性**（任一失败 BuildError、什么都不写、旧缓存原封不动，全成功才落盘替换 + 重建 + 重注册）。协议 = `userscript:deps-refresh/clear` → `state:deps-refresh/clear`。

## 构建信息注入（单一通道：`vite.define`）

`wxt.config.ts` 通过 `vite().define` 把裸标识符 `__BUILD_INFO__`（`{ time, branch, version }`）替换成字面量，**编译进所有 JS bundle**（页面 / SW / offscreen 三处同源）。这是构建信息的唯一来源。

- **HTML 内联注入 `window.__BUILD_INFO__` 已废弃**：MV3 `extension_pages` CSP 不含 `'unsafe-inline'` → 内联脚本不执行，生产环境该字段恒 `undefined`，构建信息整列消失。WXT 只在 dev 注入宽松 CSP，因此这条 bug **在 dev 下不复现**，必须用生产产物（`npm run build` + 加载 `.output/chrome-mv3`）验证。
- 页面侧取数写法（`typeof` 守卫必需——未应用该 define 的环境里裸标识符不存在，`typeof` 读不存在的标识符不抛错）：

  ```ts
  const info = typeof __BUILD_INFO__ !== 'undefined' ? __BUILD_INFO__ : undefined
  ```

- **SW 侧读不到自己的 bundle**（SW 不是 HTML / 不是同一执行上下文）：页面要 SW 的构建信息，经 `sw:buildInfo` 命令取回（IPC 契约 `src/shared/extension-ipc.ts`，SW 侧实现 `src/entrypoints/background.ts`）。取数要**重试**：WXT 重载扩展时页面跟着重载，挂载瞬间第一条请求常撞上「旧 SW 已死、新监听器未注册完」的窗口；三次都失败才算真失败（SW 是旧包或已挂），且要**显式展示「未响应」**，不得静默隐藏。
- 参考实现：取数统一封装在 `src/lib/build-info.ts`（页面侧 `readInjectedBuildInfo` / `readPageBuildStamp`，SW 侧 `fetchSwBuildStamp` 带 3 次重试）；展示在 **设置 → 关于** 分区（`src/components/settings/AboutSection.vue`，版本号 + 页面 + Service Worker 三行）。

### 版本号展示：不用 `manifest.version`

- `package.json` 写 `0.1.0-alpha.2` 时，产物 `manifest.version` = **`0.1.0`**（Chrome 该字段只允许 1–4 段数字），预发布标签被 WXT 裁掉；完整值另在 `manifest.version_name`（WXT 行为，非 Chrome 保证）。
- 所以版本号展示取 **`__BUILD_INFO__.version`**（构建期直接读 `package.json`，完整、不受裁剪影响）；`chrome.runtime.getManifest().version` 只作兜底。也不用 `window.__BUILD_INFO__`。
