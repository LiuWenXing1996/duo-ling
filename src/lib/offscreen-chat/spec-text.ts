// script_spec 的规范载荷。
//
// 来源：GM 能力 API 权威规范（src/lib/userscripts/api-contract.ts，速查页数据在 lib/gm-api-catalog.ts）
// + 生成脚本的禁止事项清单。由文档拼一段注入文本即可，.d.ts 留给脚本作者。
// 放在独立模块（纯字符串常量），chat-host 与工具实现都不必关心内容。
//
// 注意：本文件是 TS 模板字符串，正文里的反引号必须写成 \\\` 转义（裸反引号会提前闭合模板）。

export const SCRIPT_SPEC_TEXT = `# 哆灵用户脚本规范（生成脚本前必读）

## 形态
脚本 = **单文件纯 JS 源码**（无构建流程，保存即注入匹配页面）。
能力面是**标准油猴 API**（\`GM_*\` / \`GM.*\`）——**标准油猴脚本可以直接粘贴运行**。

配置有两条来源（保存时解析，源码声明者胜）：
1. **推荐：在源码顶部写标准 metadata 块**（\`// ==UserScript==\` … \`// ==/UserScript==\`），
   声明 \`@name\` / \`@match\` / \`@include\` / \`@exclude\` / \`@run-at\` / \`@noframes\` / \`@grant\`；
2. 界面上的配置（仅在源码**没声明**对应键时生效）。

## 硬性约束
1. **单文件、无模块语法**：不能用 \`import\` / \`export\`（classic script 执行，语法检查会当场报错）；
   不支持 \`node:\` 前缀；没有 \`require\`。需要的工具函数直接写在文件里。
2. **读写存储是「同步 + 异步」两形态**：
   - \`GM_getValue(key, def)\` / \`GM_listValues()\` **是同步的**（油猴语义，读注入时预载的快照）；
   - \`GM_setValue\` / \`GM_deleteValue\` 同步返回（本地缓存先落、异步过桥落盘，失败只进错误日志）；
   - \`GM.getValue\` / \`GM.listValues\` / \`GM.setValue\` 是 Promise（\`GM.getValue\` 每次回后台读，永远最新）；
   - 存储值必须是 Json（null/boolean/number/string/数组/纯对象），函数 / 类实例 / DOM 节点不可存储。
3. **\`@grant\` 决定哪些 API 存在**：写了 \`@grant\` 清单就**只注入清单内的能力**（用了没声明的会
   ReferenceError）。\`@grant none\` 或完全不写 metadata → 全量注入。**写清单就写全。**
4. \`GM_xmlhttpRequest\` 是**回调式**：响应对象有 \`responseHeaders\`（原始多行字符串）、\`responseText\`、
   \`response\`、\`status\`、\`finalUrl\`；事件 \`onload\` / \`onerror\` / \`ontimeout\` / \`onabort\`；
   返回句柄可 \`abort()\`。非 2xx 走 \`onload\`（不是 \`onerror\`）。**没有 onprogress**；
   \`responseType\` 只支持 text / json / arraybuffer / blob。
5. \`unsafeWindow\` 是**降级别名**（= 隔离世界的 window）：DOM 可用，但**看不到页面 JS 全局**
   （框架实例、站点自己的变量都读不到）。要拿页面数据请用 \`GM.page\`（见下）。
6. \`GM.page.*\` 反向中继（**哆灵扩展，非油猴标准**）：
   - \`GM.page.listen(type, handler, opts?)\` 监听页面事件（摘要 { type, key?, detail, timeStamp }）；
   - \`GM.page.fetchHook(fn, opts?)\` 拦截页面 fetch，fn 收 { url, method, headers, body }，回
     { action: 'passthrough' } 或 { action: 'respond', status, headers?, body? }；传 opts.onResponse 可在
     passthrough 时被动拿到真实响应体，零额外请求。
   - **hook 只拦「页面世界（MAIN）发出的 fetch」，即页面自身 JS 的请求**——脚本跑在独立隔离世界，
     它自己的 \`fetch\` 与页面那个不是同一绑定，**脚本自己发的请求不会被自己的 hook 拦到**。
     要拿某个接口的返回，必须让**页面**去发那个请求（触发站点自身交互：点击按钮、切路由等）。
     不要靠往 DOM 注入内联 \`<script>\` 来代发——该通道在本扩展的运行环境里实测走不通。
7. \`allFrames\` 默认 true：脚本可能在同页多个 frame 各跑一次，初始化逻辑要幂等（\`@noframes\` 可关）。
8. 生成的脚本**不会自动生效**——先落盘为未启用状态，由用户确认后启用。不要假设「已经跑起来了」。
9. 运行环境（USER_SCRIPT 隔离世界）用浏览器默认的严 CSP：**禁止 \`eval\` / \`new Function\`**，
   也不要引入内部靠它们动态生成代码的库（如 ajv 的编译校验器、Vue 运行时模板编译器）——
   被拦下的代码只在目标页静默失败，排查成本极高。

## 能力清单
- \`GM_info\` —— { script, scriptMetaStr, scriptHandler, version, uuid, userAgent, isIncognito, sandboxMode }（同步）
- \`GM_log(...args)\` —— 带前缀日志（同步）
- \`GM_addStyle(css)\` —— 注入 CSS（同步，返回 style 元素）
- \`GM_addElement(tag, attrs)\` / \`GM_addElement(parent, tag, attrs)\` —— 建元素并插入（同步）
- \`GM_getValue(key, def?)\` / \`GM_listValues()\` —— **同步**读；\`GM_setValue(key, v)\` / \`GM_deleteValue(key)\` —— 写
- \`GM_addValueChangeListener(key, cb)\` —— cb 收 (key, oldValue, newValue, remote)，**返回监听器 id**；
  \`GM_removeValueChangeListener(id)\` 注销
- \`GM_xmlhttpRequest({ url, method?, headers?, data?, responseType?, timeout?, context?, onload, onerror, ontimeout })\`
  —— 免 CORS 请求（后台发起，可 abort）；headers 里的 Cookie / Referer / User-Agent 等**禁设头会被真实覆写上线**
- \`GM_notification(details)\` 或 \`GM_notification(text, title?, image?, onclick?)\` —— 系统通知
- \`GM_setClipboard(data, info?)\` —— 写剪贴板（info 传 'text/html' 走富文本）
- \`GM_download(details)\` / \`GM_download(url, name?)\` —— 下载（远程 URL 或本地 Blob / ArrayBuffer）
- \`GM_openInTab(url, options?)\` —— 开标签页，返回 { close(), closed }
- \`GM_getTab(cb)\` / \`GM_saveTab(tab, cb?)\` / \`GM_getTabs(cb)\` —— 标签页级存储（随标签页生命周期）
- \`GM_cookie.list({ url?, name? }, cb?)\` / \`.set({ name, value, url?, ... }, cb?)\` / \`.delete({ name, url? }, cb?)\`
  —— cookie；**url 必须落在脚本自身 matches 内**（域名门，越域报 PERMISSION_DENIED），url 缺省 = 当前页；
  **set 不收 domain / path**（传入即报错）
- \`GM_registerMenuCommand(caption, onClick, options?)\` —— 扩展菜单命令，**同步返回数字 id**；
  \`GM_unregisterMenuCommand(idOrCaption)\` 注销
- \`window.onurlchange = fn\` 或 \`window.addEventListener('urlchange', fn)\` —— 当前标签页 URL 变化（含 SPA 路由），
  fn 收 { url }
- \`GM.page.*\` —— 见上文反向中继
- \`GM.*\` 命名空间是同一批能力的 Promise 化形态（如 \`await GM.getValue(key)\`）；
  **\`GM.*\` 下没有 cookie**（按 Tampermonkey 口径），cookie 只用 \`GM_cookie\`；
  另有三个哆灵扩展成员：\`GM.clearValues()\`、\`GM.focusTab(tabId)\`、\`GM.page\`

### 明确不支持（别写，写了不会生效或会以错误形式暴露）
- \`@resource\`（命名资源，供 \`GM_getResourceText\` / \`GM_getResourceURL\`）——本期未实现，声明了会记一条错误日志
- \`@require\`（外部依赖注入）——已实现：注册时由扩展按声明顺序抓取源码、前置注入到 USER_SCRIPT 世界（与脚本共享全局作用域），受 \`<all_urls>\` 豁免 CORS；抓取失败只记错误日志并跳过该依赖（不阻断脚本注入），源码按 url 缓存于 \`duoling-require-cache\` 库（手动清除前不重抓）；不做子资源完整性（SRI）校验
- \`GM_xmlhttpRequest\` 的 \`onprogress\`、\`responseType: 'document' | 'stream'\`、同步请求
- \`GM_cookie\` 的 \`domain\` / \`path\`（安全收紧项，传入即报错）
- 真正的页面上下文（\`unsafeWindow\` 是降级别名）、\`@connect\` 白名单（本扩展不需要）

## 工作流
1. 先想清楚要改哪个站点、做什么；\`@match\` **默认收窄到目标站点**（如 \`*://example.com/*\`），仅当用户明说「所有网站」才用 \`*://*/*\`。
2. 写完源码后调 script_apply：它同时完成「写内存 + 语法检查」，失败会返回 行:列 诊断，按诊断修改后**再次整体提交**（整文件写，不做局部 patch）。
3. 检查通过即收敛完成，不要反复 apply「优化」——落盘与生效由编排层处理。
4. 结束后用正文向用户说明：脚本做了什么、在哪生效、如何验证。`
