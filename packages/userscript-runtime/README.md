# @duoling/userscript-runtime

GM 脚本运行时内核：一个 Chrome 扩展接入本包，即可运行 userscript（GM API），无需自己实现任何 GM 语义。

## 用法

**manifest.json**

```jsonc
{
  "permissions": ["userScripts", "offscreen", "downloads", "cookies",
                  "notifications", "tabs", "storage", "clipboardWrite"],
  "host_permissions": ["<all_urls>"]
}
```

**background.ts（SW 入口）**

```ts
import { GM_OFFSCREEN_REASONS, createServiceWorkerHost } from '@duoling/userscript-runtime/host'

// 顶层第一帧同步调用（不 await）：配置注入 + 桥与 Port 监听注册同点完成（幂等）。
// 遥测 / offscreen 就绪 / 扩展身份全部可选，不注入 = 相应观测不发生，脚本行为不受损。
const host = createServiceWorkerHost({
  extensionName: 'My Extension',
  offscreen: { ensureReady: () => Promise.resolve(true) },
})

// offscreen 文档：每次唤醒直建一次，已存在则 reject 被吞（不 await）
chrome.offscreen.createDocument({
  url: 'offscreen.html',
  reasons: GM_OFFSCREEN_REASONS,
  justification: 'Runs clipboard and blob APIs that service workers cannot access',
}).catch(() => {})
```

**offscreen.html**

```html
<!doctype html><script type="module" src="./offscreen-entry.ts"></script>
```

**offscreen-entry.ts**

```ts
import { createOffscreenHost } from '@duoling/userscript-runtime/host'

// 注册 onMessage 监听应答 GM 运行时的 offscreen 协议（当前 = clipboard:write），一行接线
createOffscreenHost()
```

> `./host` 与主入口指向同一份产物（防两份 bundle 造成模块单例分裂），从哪个路径 import 行为一致。

**装脚本**

```ts
await host.addScript(sourceCode)
```
