# 用户脚本 · 能力 API 规范

> 2026-09-14 战略决策：**放弃油猴（GM_*）生态兼容**，脚本改为自有形态。
> 本文档为能力 API 的权威规范，取代旧 GM 对齐设计中的 GM API 桥接层（原 `userscript-manager-design.md`
> 已删除，git 历史可查）。

## 1. 设计原则

| 原则 | 说明 |
|---|---|
| **全 async** | 所有跨桥 API 返回 Promise。不做 VM/TM 那套"预载快照伪造同步"——那需要为每个页面加载脚本的全部存储，且存在跨标签陈旧问题 |
| **强类型桥** | 桥协议用可辨识联合类型表达（见 §5），新增命令时后台 `switch` 会因穷尽性检查报错提醒，杜绝"命令拼错静默失败" |
| **可导出类型** | 契约文件可直接导出为 `.d.ts` 发给脚本作者，编辑器里有智能提示与类型检查——这是油猴生态一直没做好的部分 |
| **本地能力不走桥** | `style` / `log` / `info` 在脚本世界直接实现。我们享有 CSP 豁免，没必要为它们付一次消息往返 |
| **命名空间隔离** | 全部能力挂在单一全局 `DL` 下，不往 `window` 上散落一堆 `GM_*` |

## 2. API 总览

```
DL.info                          脚本自省（同步）
DL.style(css)                    注入 CSS（同步，本地实现）
DL.log(...args)                  带前缀输出（同步，本地实现）

DL.store.get(key, fallback?)     读取脚本私有存储
DL.store.set(key, value)         写入
DL.store.delete(key)             删除
DL.store.keys()                  列出所有键
DL.store.clear()                 清空
DL.store.watch(key, cb)          跨标签监听（阶段二）

DL.fetch(url, init?)             免 CORS 请求
DL.notify(message, opts?)        系统通知
DL.download(url, name?)          下载
DL.clipboard.write(text)         写剪贴板
DL.tabs.open(url, opts?)         开标签页（免弹窗拦截）
DL.cookie.get/set/remove         Cookie 读写

DL.menu.register(title, fn)      注册菜单命令（阶段二）
DL.page.*                        反向中继访问页面世界（另立规范）
```

## 3. 语义要点

### 3.1 存储

- **键空间按脚本隔离**（`us:dl:<uuid>:<key>`），与页面 `localStorage` 完全无关。
  这一点很关键：脚本世界与页面共享同源 `localStorage`，直接用它会被页面清掉、也会污染页面。
- 值必须是 `Json`（`null | boolean | number | string | 数组 | 纯对象`）。函数、类实例、DOM 节点存不了。
- `get(key, fallback)`：键不存在时返回 `fallback`；未传 `fallback` 时为 `undefined`。

```js
// 脚本里
const enabled = await DL.store.get('enabled', false)
if (enabled) start()
await DL.store.set('lastRun', Date.now())
```

### 3.2 免 CORS 请求

后台 Service Worker 发起，因此**不受页面 CSP 与同源策略约束**——这是脚本世界原生 `fetch` 做不到的
（Chrome 官方明文：内容脚本中的跨源请求始终按跨源处理，即使扩展拥有 host permission）。

浏览器 `Response` 对象不可结构化克隆，无法跨桥，故后台回传纯数据，脚本侧再补便捷方法：

```js
const r = await DL.fetch('https://api.example.com/data')
r.ok          // boolean
r.status      // 200
r.text()      // 响应体字符串
r.json()      // 解析 JSON（本地解析，不再过桥）

// 二进制
const img = await DL.fetch(url, { responseType: 'arraybuffer' })
img.arrayBuffer()
```

### 3.3 纯本地能力

```js
DL.style('.foo { color: red }')   // 返回 HTMLStyleElement，同步
DL.log('hello')                   // 输出 [脚本名] hello
DL.info                           // { uuid, name, version }
```

这三个不跨桥：脚本世界有 DOM 访问权，且我们的世界豁免页面 CSP，直接插 `<style>` 即可。

## 4. 错误处理

所有跨桥 API 失败时 **reject 一个 Error**，不是返回 `null` 或静默吞掉：

```js
try {
  const r = await DL.fetch(url)
} catch (e) {
  // e.message 含命令名，便于定位
}
```

错误码见契约文件 `ApiErrorCode`：

| 码 | 含义 |
|---|---|
| `BRIDGE_TIMEOUT` | 后台 30s 无响应（保留现有超时兜底，避免"既不成功也不报错"） |
| `NOT_AVAILABLE` | 所需 `chrome.*` 权限未授予 |
| `PERMISSION_DENIED` | 身份校验不通过 |
| `INVALID_ARG` | 参数不合法（如值不是 Json） |
| `INTERNAL` | 后台内部错误 |

## 5. 桥协议

脚本世界 → 后台走 `chrome.runtime`（世界已 `configureWorld({ messaging: true })`）。
请求体用可辨识联合，见 `src/lib/userscripts/api-contract.ts` 的 `ApiRequest`：

```ts
export type ApiRequest =
  | { c: 'store.get'; key: string; fallback?: Json }
  | { c: 'store.set'; key: string; value: Json }
  | { c: 'fetch'; url: string; init?: FetchInit }
  | ...
```

响应信封：`{ ok: true, data } | { ok: false, error, code }`。

后台 → 脚本的**推送**事件（`ApiEvent`）需要长连接 port（`chrome.runtime.connect`），
涉及 `store.watch` 与 `menu` 回调，列入阶段二。

**身份校验**沿用现有机制：校验 `sender.userScript.scriptId` 与消息里的 uuid 一致，
防止恶意脚本冒充身份读取其它脚本的存储。

## 6. 阶段划分

**一期（无需长连接）**

`info` · `style` · `log` · `store.{get,set,delete,keys,clear}` · `fetch` · `notify` ·
`download` · `clipboard.write` · `tabs.open` · `cookie.*`

**二期（需长连接 port）**

`store.watch`（跨标签同步）· `menu.register`（点击回推脚本）

**另立规范**

`DL.page.*` —— 反向中继访问页面世界（句柄 / 事件转发 / 握手防伪）

## 7. 从旧 GM 实现迁移的映射

仅供实现时对照，不作为兼容承诺：

| 旧（将移除） | 新 |
|---|---|
| `GM_getValue` / `GM.setValue` | `DL.store.get` / `DL.store.set` |
| `GM_deleteValue` / `GM_listValues` | `DL.store.delete` / `DL.store.keys` |
| `GM_xmlhttpRequest` | `DL.fetch` |
| `GM_notification` | `DL.notify` |
| `GM_download` | `DL.download` |
| `GM_openInTab` | `DL.tabs.open` |
| `GM_addStyle` | `DL.style`（改为同步、本地实现） |
| `GM_log` | `DL.log` |
| `GM_info` | `DL.info` |
| `GM_addValueChangeListener` | `DL.store.watch`（阶段二） |
| `GM_registerMenuCommand` | `DL.menu.register`（阶段二） |
| `GM_setClipboard` | `DL.clipboard.write` |
| `GM_getResourceText` / `GM_getResourceURL` | **移除**——资源改由模块化 import 承担 |

## 8. 未决项

- [ ] 脚本世界能否使用 `chrome.runtime.connect` 建立长连接（决定阶段二可行性）—— 待实测
- [ ] `DL.cookie` 的 URL 作用域默认值（当前页面 URL？还是脚本 match 的第一个？）
- [ ] 存储值体积上限（`chrome.storage.local` 配额 + 单次消息大小）
- [ ] 是否提供 `DL.fetch` 的流式 / 进度回调（受限于跨桥，倾向不支持）
