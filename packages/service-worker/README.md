# @duoling/service-worker

本项目的 **SW 进程包**：既是 GM 运行时的 SW 侧宿主（一个 Chrome 扩展接上它就能用 `chrome.userScripts`
跑用户脚本，不必自己实现任何 GM 语义），也承载本扩展与 offscreen 的直连链路（`sw-link`）与
offscreen 容器能力约定。机制的来龙去脉见 [ARCHITECTURE.md](../../ARCHITECTURE.md)。

| 职责 | 件 |
| --- | --- |
| 注册引擎 —— 世界配置 / 单脚本与全量注册 / 可用性检测 | `registration` |
| 可用性监视 —— SW 进程内轮询引擎可用性，只在翻转时通知消费层 | `availability-watch` |
| 命令分发 —— 中继件发来的 GM 请求（storage / xhr / download / menu…） | `gm-bridge` |
| 事件底座 —— 脚本世界 ↔ SW 长连接的下行通道（菜单点击 / 值变更 / 下载进度） | `gm-port` |
| cookie 域名门 —— GM_cookie 的安全边界（scheme + host） | `cookie-gate` |
| `@require` / `@resource` 的抓取与落库 | `require-cache` / `resource-cache` |
| 运行时命令面 —— 管理面只读四条 | `management` |
| 宿主注入点 —— 扩展身份 / offscreen 就绪 / 遥测 / 密钥存储 / 内置件 | `host-config` |
| 与 offscreen 的直连链路 —— 服务代理 / 事件 / 保活心跳（ADR 0044） | `sw-link` |
| offscreen 容器能力约定 —— 建文档用的 reason 集 | `offscreen-reasons` |
| 注入源码生成 —— GM 包装前缀 / MAIN 世界脚本桥模板 | `gm-wrapper` / `script-bridge` |
| GM 值存储 —— `GM_setValue` 一族与 usdata 库（`GM_getTab` 等） | `gm-values` / `usdata-db` |

依赖方向：本包 → `@duoling/shared`（契约 / GM 语义 / 状态库 / 服务契约），无环。
offscreen 侧是同层的另一个**进程包** `@duoling/offscreen-document`，与本包**互不 import**。

## manifest.json

```jsonc
{
  "permissions": ["userScripts", "offscreen", "downloads", "cookies",
                  "notifications", "tabs", "storage", "clipboardWrite"],
  "host_permissions": ["<all_urls>"]
}
```

## background.ts（SW 入口）

```ts
import { createServiceWorkerHost, GM_OFFSCREEN_REASONS } from '@duoling/service-worker'

// 顶层第一帧同步调用（不 await）：注入配置 + 桥与 Port 监听注册同点完成（幂等）。
// 各 port 全部可选：不注入 = 相应观测不发生，脚本行为不受损；
// secretStore 不注入则握手密钥只在 SW 存活期内有效。
const host = createServiceWorkerHost({
  extensionName: 'My Extension',
  offscreen: { ensureReady: () => Promise.resolve(true) },
  secretStore: myKvStore,
  // 宿主自己的常驻注册件（可选）：registerAllEnabled 会先同步它们、stale 清扫排除这些 id
  builtins: { ids: ['my-host-piece'], syncAll: syncMyPieces },
})

// offscreen 文档由扩展自建（包不碰生命周期）：每次唤醒直建一次，已存在则 reject 被吞
chrome.offscreen.createDocument({
  url: 'offscreen.html',
  reasons: GM_OFFSCREEN_REASONS,
  justification: 'Runs clipboard and blob APIs that service workers cannot access',
}).catch(() => {})
```

## 命令面交给宿主总线

`createServiceWorkerHost` **不自挂 `onMessage`**。运行时自有命令面（管理面只读四条：
`userscript:list` / `userscript:getProject` / `userscript:groups` / `userscript:availability`）由
`swIpcHandlers()` 导出，交给宿主的消息总线问询应答 —— 每个语境只留一个监听器，功能侧不各造通信。

宿主没有总线时，最小的挂法：

```ts
const pack = swIpcHandlers()
chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
  const msg = raw as { kind?: string } | undefined
  if (!msg?.kind || !pack.owns(msg.kind)) return false // 不认领：让给别的监听器
  pack.handle(msg, sender).then(
    (data) => sendResponse({ ok: true, data }),
    (e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
  )
  return true // 异步应答：保持通道打开
})
```

宿主自管的命令（`userscript:save` / `toggle` / `import`…、`tab:*`）与包认领的 kind 不重叠：
`SW_IPC_OWNED_KINDS` 是对外透出的认领白名单，宿主可据此把自己命令面的类型里与包重叠的 kind 摘掉。

## 引擎可用性监视

Chrome 对「允许运行用户脚本」开关**没有事件**，轮询是唯一检测手段。宿主在 SW 入口启一次监视，
翻转时按需自愈：

```ts
import { onAvailabilityChange, registerAllEnabled, startAvailabilityWatch } from '@duoling/service-worker'

startAvailabilityWatch() // 幂等；首个读数只建基线，不广播
onAvailabilityChange(({ previous, current }) => {
  // 开关后开：关闭期间启用的脚本只落库未注册，没人补注册就永远不生效
  if (!previous && current.available) void registerAllEnabled()
})
```

监视器**只报变化**，不做任何动作 —— 补注册 / 角标 / 广播都由消费方自己接。

**前提**：SW 活不过 30s 空闲，监视定时器随之消亡。要让它持续跑需 offscreen 的心跳保活
（即 `sw-link` 链路上的 `link:ping`，每 5s 一帧）；容器缺席时 SW 会睡，
被唤醒（UI 消息 / 导航事件）时入口重跑、监视重启、首个读数重建基线 —— 这不是缺陷。

## 装脚本

```ts
// 传源码串：包内自动建项目（metadata 块归一化进配置，@name 采纳为脚本名）
await host.addScript(sourceCode)
// 或传现成的 ScriptProject（宿主有自己的项目管理时）
await host.addScript(project)
```

## 中继件

页面 MAIN 世界脚本的 GM 调用经同帧 USER_SCRIPT **中继件**转给 SW。中继件本体在
`@duoling/user-scripts`（src/builtin/relay/，那边 build.mjs 生成 IIFE 源码串 gen 模块，不入库），
宿主侧注册面随本包内置：`registerAllEnabled` 按「启用脚本的匹配
并集」自动维护它的注册，IIFE 以 `{ code }` 注入、无公共资产文件，接入方零接线。
