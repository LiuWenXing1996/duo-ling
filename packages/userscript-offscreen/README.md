# @duoling/userscript-offscreen

GM 运行时的 **offscreen 侧宿主**：剪贴板命令应答（免手势直写，纯文本 / 富文本）+ SW 保活心跳。

只依赖 `@duoling/shared`（协议契约）。offscreen 文档的**生命周期由扩展自建** —— 本包不碰创建与销毁，
建文档时 `reasons` 取本包导出的 `GM_OFFSCREEN_REASONS`（`BLOBS` + `WORKERS` + `CLIPBOARD`，与运行时
实际用到的能力对齐）。SW 侧接线见 [`@duoling/userscript-sw`](../userscript-sw/README.md)。

## offscreen.html

```html
<!doctype html><script type="module" src="./offscreen-entry.ts"></script>
```

## offscreen-entry.ts

```ts
import { createOffscreenHost } from '@duoling/userscript-offscreen'

// 一行接线：启动 SW 保活心跳 + 自挂 onMessage 应答剪贴板命令
createOffscreenHost()
```

宿主已有自己的消息总线（每语境唯一 `onMessage` 监听器）时传 `{ listen: false }`，改由总线经
`handle()` 问询应答（`clipboard:write` 归本包认领）。

## 协议

- 下行命令：`{ kind: 'clipboard:write', text, html }` —— 常量 `IPC_CLIPBOARD_WRITE` 在
  `@duoling/shared`；`text` / `html` 至少给一个，都空即报错。
- 应答：统一信封 `{ ok: true, data }` / `{ ok: false, error }`（`{ listen: false }` 时信封由宿主总线包）。

offscreen 文档拿不到页面焦点，`navigator.clipboard` 会报 "Document is not focused"，故写入走
`document.execCommand('copy')` + copy 事件注入 `clipboardData`。

## 保活

GM 的消息链路预设 SW 常驻（在途的 GM XHR 进度帧 / download 结局 / 通知点击回调都靠 SW 推），
心跳是包正常工作的**前置条件**、无条件启用：`createOffscreenHost` 内即启，5s 一跳只重置 SW 的
30s 空闲计时、不做任何检测（应答侧在 sw 包的 handler pack）。自管心跳时机可直调
`startSwKeepalive` / `stopSwKeepalive`，间隔常量 `SW_KEEPALIVE_INTERVAL_MS`。
