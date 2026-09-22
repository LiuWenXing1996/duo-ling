# GM API 与油猴标准的差距

> 脚本面 GM API 支持面的快照：**哪些有、哪些没有、哪些是降级实现**。
> 补能力或改语义时同步本文件，否则「已支持但没人知道」与「写在文档里但没实现」都会长期漂移。

## 数据来源（三处单一来源，改它们就要同步本文）

| 文件 | 职责 |
| --- | --- |
| `src/lib/gm-grants.ts` | `@grant` 名 → 它开启的成员（全局与 `GM.*` 两种形态），以及恒注入成员 |
| `src/lib/gm-api-catalog.ts` | 工作台「GM API 速查」页的数据源（说明、默认值、边界、降级项） |
| `src/lib/offscreen-chat/spec-text.ts` | AI 写脚本时读到的规范文本，含「明确不支持」清单 |

## 一、覆盖面

20 个 `@grant`，每个同时开全局与 `GM.*` 两种形态（对齐 Tampermonkey 口径）：

| 能力 | `@grant` 名 | `GM.*` 成员 |
| --- | --- | --- |
| 读值 | `GM_getValue` | `getValue` |
| 写值 | `GM_setValue` | `setValue` |
| 删值 | `GM_deleteValue` | `deleteValue` |
| 列出键 | `GM_listValues` | `listValues` |
| 订阅值变更 | `GM_addValueChangeListener` | `addValueChangeListener` |
| 取消订阅 | `GM_removeValueChangeListener` | `removeValueChangeListener` |
| 登记菜单 | `GM_registerMenuCommand` | `registerMenuCommand` |
| 注销菜单 | `GM_unregisterMenuCommand` | `unregisterMenuCommand` |
| 注入样式 | `GM_addStyle` | `addStyle` |
| 注入元素 | `GM_addElement` | `addElement` |
| 日志 | `GM_log` | `log` |
| 通知 | `GM_notification` | `notification` |
| 剪贴板 | `GM_setClipboard` | `setClipboard` |
| 跨域请求 | `GM_xmlhttpRequest` | `xmlHttpRequest` |
| 下载 | `GM_download` | `download` |
| 开标签页 | `GM_openInTab` | `openInTab` |
| 读标签页存储 | `GM_getTab` | `getTab` |
| 存标签页数据 | `GM_saveTab` | `saveTab` |
| 列出标签页 | `GM_getTabs` | `getTabs` |
| Cookie | `GM_cookie` | 无（按 Tampermonkey 口径不进 `GM.*`） |

**恒注入**（无需 `@grant`）：`GM_info`、`unsafeWindow`、`window.onurlchange`；`GM.*` 侧恒注入 `info`、`clearValues`、`focusTab`、`page`。

> 其中 `unsafeWindow` / `window.onurlchange` 在 TM 里需要显式 `@grant`，本扩展恒给 —— 更宽松，不会因此让脚本 ReferenceError。

**`@grant` 名收两种写法**（TM 官方示例把两种并列列出，导入的外部脚本两种都可能写）：规范名
`GM_setValue` 同时开全局与 `GM.*` 两种形态；点号形态 `GM.setValue` 只开 `GM.*` 那一种。
规范文本只教前一种（自产脚本写一行就够），第二种是为兼容外部脚本而认。

## 二、标准里有、本扩展完全没有的

| 缺失 | 现状 | 依据 |
| --- | --- | --- |
| `GM_closeTab` / `GM.closeTab` | 无实现。仓库内同名的 `closeTab` 是工作台标签页的内部函数，与 GM API 无关 | 全仓无 GM 侧实现 |
| `GM_getResourceText` / `GM_getResourceURL` | 无实现。`@resource` 元数据会被解析并出现在 `GM_info.script.resources` 里，但脚本拿不到资源内容 | `spec-text.ts`「明确不支持」段 |
| `GM_webRequest` | 不在注入面内 | `gm-wrapper.test.ts` 断言它不在 exposure 表 |
| `window.close` / `window.focus` | 无实现。TM 把它们当 `@grant` 项暴露（关闭 / 聚焦当前标签页）；本扩展只有自有的 `GM.focusTab`，且不需要 `@grant` | `gm-wrapper.ts` 装配块里无对应成员 |

## 三、有实现但语义弱于油猴（降级项）

| 项 | 差异 | 依据 |
| --- | --- | --- |
| `GM_xmlhttpRequest` | **无 `onprogress`**（桥无流式）；`responseType` 只支持 text / json / arraybuffer / blob，不支持 document / stream；非 2xx 走 `onload` 而非 `onerror` | `gm-api-catalog.ts` 与 `spec-text.ts` 的请求条目 |
| `GM_xmlhttpRequest` | 不支持同步请求 | `spec-text.ts`「明确不支持」段 |
| `GM_cookie` | 不收 `domain` / `path`，传入即报错——域名门只比 scheme + host，开放 domain 会架空它 | `gm-wrapper.ts` cookie 分支 |
| `GM_download` | `saveAs` 被忽略（走 `a[download]`，弹不出另存为），仅记一条日志 | `gm-wrapper.ts` download 分支 |
| `@connect` | 不做白名单：本扩展的跨域请求经后台发出，不需要声明 | `spec-text.ts`「明确不支持」段 |
| header 覆写 | 只做 `set`（`append` 受 DNR 头白名单限制、`remove` 未实现）；且头修改**不跨重定向 hop**，跨 host 的 3xx 之后新请求拿不到覆写头 | `dl-fetch-priv.ts` 顶部注释 |

## 四、环境级差异（脚本会撞上，但不算 API 缺口）

- **CSP 跟随目标站点**：脚本运行在页面主世界，`eval` / `new Function` 能不能用由站点自身的 CSP 决定（不再由本扩展拦截）。依赖动态代码生成的库（如 ajv 编译校验器、Vue 运行时模板编译器）在收紧 CSP 的站点上仍会静默失败。
- **`GM_info.isIncognito` 恒 false**：脚本在 MAIN 世界读不到扩展的隐身上下文；要拿真值需经桥回 SW 查，暂未做。
- **脚本顶层 `var` 不进页面全局**：注入代码把包装与脚本一起放在函数作用域里。要往页面上挂东西请显式写 `unsafeWindow.x = …`。
- **`GM_*` / `GM` 是脚本作用域里的标识符，不是 `window` 属性**：`GM_setValue(…)` 直接写即可，但 `window.GM_setValue` 取不到。TM 的 `raw` 模式挂在 window 上，本扩展不挂 —— 同帧多脚本共享一个 window，挂上去会互相覆盖（前一个脚本的调用会落到后一个的存储）。能力检测请用 `typeof GM_setValue === 'function'`，不要探测 `window.GM_*`。
- **`@grant` 精确裁剪**：**只有写进清单的成员才存在**，漏写即 `ReferenceError`；**不写 `@grant` / `@grant none` 都等于空清单**（对齐 TM：没写 metadata 也不全量注入）。这是**有意的取舍**：不写 `@grant` 的老脚本（GM 1.0 时代常见）导入后会整体失效，我们**不做兼容推断** —— 目标是「脚本行为与 TM 一致」，而不是「尽量让它跑起来」。自产脚本由 `spec-text` 强制写全清单，样例包也一律写全。

## 五、本扩展自有（标准里无对应物）

| 成员 | 作用 |
| --- | --- |
| `GM.page.listen` | 监听页面事件，收摘要 `{ type, key?, detail, timeStamp }` |
| `GM.page.fetchHook` | 拦截页面世界的 fetch（含脚本自己发的），可 `passthrough` 或 `respond`；可选拿真实响应体 |
| `GM.clearValues` | 清掉本脚本的全部键值 |
| `GM.focusTab` | 激活指定标签页并聚焦其所在窗口 |
| `window.onurlchange` | 页面 URL 变化回调 |

## 六、补一个 API 时要动的地方

1. `src/lib/gm-grants.ts` —— 加 grant 与成员映射；
2. `src/lib/userscripts/gm-wrapper.ts` —— 注入体里挂载实现；
3. `src/lib/gm-api-catalog.ts` —— 速查页条目（含降级项说明）；
4. `src/lib/offscreen-chat/spec-text.ts` —— 规范文本，以及把不再成立的条目从「明确不支持」里删掉；
5. 本文件 —— 从「缺失」移到「覆盖面」，或更新降级描述。

第 4 步最容易被漏：AI 写脚本只看规范文本，实现了但没从「明确不支持」里摘掉，等于没实现。
