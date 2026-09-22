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

28 个 `@grant`（含两个 window 级成员），每个同时开全局与 `GM.*` 两种形态（对齐 Tampermonkey 口径，例外在表内注明）：

| 能力 | `@grant` 名 | `GM.*` 成员 |
| --- | --- | --- |
| 读值 | `GM_getValue` | `getValue` |
| 写值 | `GM_setValue` | `setValue` |
| 删值 | `GM_deleteValue` | `deleteValue` |
| 列出键 | `GM_listValues` | `listValues` |
| 批量取值 | `GM_getValues` | `getValues` |
| 批量写值 | `GM_setValues` | `setValues` |
| 批量删值 | `GM_deleteValues` | `deleteValues` |
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
| 标签页音频 | `GM_audio` | `audio` |
| 取资源文本 | `GM_getResourceText` | `getResourceText` |
| 取资源 data URI | `GM_getResourceURL` | `getResourceUrl`（小写 r/l，照 TM 原样） |
| Cookie | `GM_cookie` | 无（按 Tampermonkey 口径不进 `GM.*`） |
| 关当前标签页 | `window.close` | 无（window 级成员，没有 `GM.*` 形态） |
| 聚焦当前窗口 | `window.focus` | 无（同上） |

**恒注入**（无需 `@grant`）：`GM_info`、`unsafeWindow`、`window.onurlchange`；`GM.*` 侧恒注入 `info`、`clearValues`、`focusTab`、`page`。

> 其中 `unsafeWindow` / `window.onurlchange` 在 TM 里需要显式 `@grant`，本扩展恒给 —— 更宽松，不会因此让脚本 ReferenceError。

**`@grant` 名收两种写法**（TM 官方示例把两种并列列出，导入的外部脚本两种都可能写）：规范名
`GM_setValue` 同时开全局与 `GM.*` 两种形态；点号形态 `GM.setValue` 只开 `GM.*` 那一种。
规范文本只教前一种（自产脚本写一行就够），第二种是为兼容外部脚本而认。

## 二、标准里有、本扩展完全没有的

**对齐口径**：以「**Chrome MV3 上的 Tampermonkey**」为准 —— 不补 TM 自己在 MV3 下已下线、或在 MV3 语境里不适用的东西。
下表是这条判定剩下的部分（**结论：当前没有待补项**）：

| 项 | 判定 | 依据 |
| --- | --- | --- |
| `GM_webRequest` / `@webRequest` | **不补** | TM 自标 `@webRequest` 为 *experimental, MV2 only*；`GM_webRequest` 的 @types 注释写明 *not available anymore at Manifest v3 versions of Tampermonkey 5.2+* |
| `@sandbox`（`raw` / `JavaScript` / `DOM`） | **不补** | 那是「脚本注入到哪个世界」的开关（Firefox 的 USERSCRIPT_WORLD / ISOLATED_WORLD 语境）；本扩展恒注入页面主世界，Chrome MV3 下没有等价选择 |
| `@run-in`（v5.3+） | **不补** | 按普通 / 隐身 / **Firefox 容器**筛注入上下文；Chrome 没有容器概念，隐身筛选我们也做不到（`GM_info.isIncognito` 恒 false，见第四节） |

> 两条**不在表内**：`GM_closeTab`（TM 官方文档里没有它，TM 用 `window.close`，属个别实现自有）；
> `@connect` 白名单（我们不做白名单是**更宽松**而非缺失 —— 见第三节）。

## 三、有实现但语义弱于油猴（降级项）

| 项 | 差异 | 依据 |
| --- | --- | --- |
| `GM_xmlhttpRequest` | `responseType` 支持 text（缺省）/ json / arraybuffer / blob，**缺 `stream`**（TM 的合法值只有 arraybuffer / blob / json / stream，**没有 document**）；`onprogress` 只给进度字段（TM 那种带完整 response 的进度对象不给）；非 2xx 走 `onload` 而非 `onerror`（与 TM 一致） | `gm-api-catalog.ts` 与 `spec-text.ts` 的请求条目 |
| `@connect` | **更宽松**（不是缺失）：不拦未声明的域名（TM 会拦）——本扩展的跨域请求经后台发出，白名单没有意义 | `spec-text.ts`「明确不支持」段 |
| `@run-at` | 支持 `document-start` / `document-body` / `document-end` / `document-idle`（**不写时默认值也是 `document-idle`，与 TM 一致**）；**缺 `context-menu`**（右键菜单点了才注入，且该模式下 `@include` / `@exclude` 会被忽略，TM 5.5+） | TM 官方文档的 `@run-at` 段 |
| header 覆写 | 只做 `set`（`append` 受 DNR 头白名单限制、`remove` 未实现）；且头修改**不跨重定向 hop**，跨 host 的 3xx 之后新请求拿不到覆写头 | `dl-fetch-priv.ts` 顶部注释 |

## 四、环境级差异（脚本会撞上，但不算 API 缺口）

- **CSP 跟随目标站点**：脚本运行在页面主世界，`eval` / `new Function` 能不能用由站点自身的 CSP 决定（不再由本扩展拦截）。依赖动态代码生成的库（如 ajv 编译校验器、Vue 运行时模板编译器）在收紧 CSP 的站点上仍会静默失败。
- **`GM_info.isIncognito` 恒 false**：脚本在 MAIN 世界读不到扩展的隐身上下文；要拿真值需经桥回 SW 查，暂未做。
- **脚本顶层 `var` 不进页面全局**：注入代码把包装与脚本一起放在函数作用域里。要往页面上挂东西请显式写 `unsafeWindow.x = …`。
- **`GM_*` / `GM` 是脚本作用域里的标识符，不是 `window` 属性**：`GM_setValue(…)` 直接写即可，但 `window.GM_setValue` 取不到。TM 的 `raw` 模式挂在 window 上，本扩展不挂 —— 同帧多脚本共享一个 window，挂上去会互相覆盖（前一个脚本的调用会落到后一个的存储）。能力检测请用 `typeof GM_setValue === 'function'`，不要探测 `window.GM_*`。
- **`@run-at document-body` 靠闸门实现**：Chrome 的 `userScripts.runAt` 只有 start / end / idle，故声明 `document-body` 时注入走 `document_start`，**正文**由包装层等 body 出现再跑（包装层自身不等 —— 它不碰页面 DOM）。脚本观测到的正文时机与 TM 一致，但**注入体的成员挂载早于 body 存在**（要在 body 之前的时机做事的脚本仍应写 `document-start`）。
- **同步 `GM_xmlhttpRequest` 不存在**：TM 官方文档明确写了 *"the `synchronous` flag at `details` is not supported"*，我们同样不支持 —— 这不是差距，是两边一致。
- **`@grant` 精确裁剪**：**只有写进清单的成员才存在**，漏写即 `ReferenceError`。**不写 `@grant` 与 `@grant none` 都等于空清单** —— TM 官方文档原文如此（"If no @grant tag is given an empty list is assumed. However this different from using none."），所以这不是我们的取舍而是照 TM 对齐：不写 `@grant` 的老脚本（GM 1.0 时代常见）在 TM 里同样会 `ReferenceError`，我们**不替它推断权限**。自产脚本由 `spec-text` 强制写全清单，样例包也一律写全。

## 五、本扩展自有（标准里无对应物）

| 成员 | 作用 |
| --- | --- |
| `GM.page.listen` | 监听页面事件，收摘要 `{ type, key?, detail, timeStamp }` |
| `GM.page.fetchHook` | 拦截页面世界的 fetch（含脚本自己发的），可 `passthrough` 或 `respond`；可选拿真实响应体 |
| `GM.clearValues` | 清掉本脚本的全部键值 |
| `GM.focusTab` | 激活指定标签页并聚焦其所在窗口 |
| `window.onurlchange` | 页面 URL 变化回调 |

## 六、补一个 API 时要动的地方

> 每一处都有门禁拦着，漏了会红（不会静默漂）—— 红在哪，就说明漏了哪一处。

1. `src/lib/gm-grants.ts` —— 加 grant 与成员映射（这一处一动，注入面裁剪立刻生效）；
2. `src/lib/userscripts/api-contract.ts` —— 脚本面类型声明两处（`GmGlobalFns` 全局形态 + `GmApiNamespace` 的 `GM.*` 形态）；需要新桥命令时也在这里登记；
3. `src/lib/userscripts/gm-wrapper.ts` —— 注入体里挂载实现（全局 + `GM.*` 两个形态）；
4. `src/lib/gm-api-catalog.ts` —— 速查页条目（含降级项说明）；
5. `src/lib/offscreen-chat/spec-text.ts` —— 规范文本，以及把不再成立的条目从「明确不支持」里删掉（能力清单由能力数据自动生成，手写的只有「明确不支持」段）；
6. `uscript-samples/gm-matrix/script.js` —— 真机矩阵探针：`@grant` 清单写全 + 顶部 `@covers` 登记 + 用例本身；
7. `e2e/gm-matrix.spec.ts` —— 矩阵条目数期望值（增删用例时同步）；
8. 本文件 —— 从「缺失」移到「覆盖面」，或更新降级描述。

第 5 步最容易被漏：AI 写脚本只看规范文本，实现了但没从「明确不支持」里摘掉，等于没实现。
第 6／7 步漏掉时的信号**长得不像「漏了一处」**：coverage 单测报「目录里有、矩阵探针没覆盖的路径」，
端测报「矩阵条目数变了」—— 两次都容易被当成「测试里那个数字过期了」顺手改掉，
而不是意识到「有个 API 还没被真机验过」。

> 补的是 **window 级成员**（`window.close` / `window.focus` 这类）时，另有两处测试设施要顺手跟上：
> ① `gm-api-catalog.test.ts` 的全局反射只认 `GM_HAS.X` 赋值形态，`defineProperty` 挂上 window 的要加进它那份
> 特例清单，并补一条「确实被挂载」的反向断言；② `spec-text.test.ts` 的成员提取器按 gm-grants 里的 window 名单
> 逐个查文本（新增成员自动跟上）—— 别把它改成通配正则，否则 `window.addEventListener` 这类无关写法会被当成能力引用。
>
> 补的是**对象型全局**（`GM_cookie` / `GM_audio` 这类，成员是方法而非函数）时：注入体里要写成**具名对象**
> `var __gmXxxApi = { … }`（内联字面量反射取不到），并在 `gm-api-catalog.test.ts` 的 `OBJECT_BLOCKS` 里登记
> 「定义块标记 → 路径前缀」。另外桥命令名**一律写字面量**：契约一致性单测按字面量反射「谁发了这条命令」，
> `{ c: cond ? 'a.x' : 'a.y' }` 这种拼出来的名字会被判成「没人发的死命令」。
