# @duoling/userscript-offscreen

GM 运行时的 **offscreen 侧宿主**：剪贴板命令应答（免手势直写，纯文本 / 富文本）。

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

// 一行接线：自挂 onMessage 应答剪贴板命令
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

## 不在本包

SW 保活心跳：发送端是 `@duoling/offscreen-document` 的 `keepalive`，由宿主 offscreen 入口启动
（不再是本包接线即启）。
