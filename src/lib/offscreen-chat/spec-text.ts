// script_spec 的规范载荷。
//
// 来源：DL 能力 API 权威规范（src/lib/userscripts/api-contract.ts）+ 生成脚本的禁止事项清单。
// 由文档拼一段注入文本即可，.d.ts 留给脚本作者。
// 放在独立模块（纯字符串常量），chat-host 与工具实现都不必关心内容。

export const SCRIPT_SPEC_TEXT = `# 哆灵用户脚本规范（生成脚本前必读）

## 形态
脚本 = **单文件纯 JS 源码**（无构建流程，保存即注入匹配页面）。
配置走 \`config\` 对象（matches / excludeMatches / includeGlobs / excludeGlobs / allFrames / runAt），
**不写 \`==UserScript==\` metadata，没有 \`@grant\` / \`@require\` / \`unsafeWindow\`**——照抄油猴模板跑不起来。

## 硬性约束
1. **单文件、无模块语法**：不能用 \`import\` / \`export\`（classic script 执行，语法检查会当场报错）；
   不支持 \`node:\` 前缀；没有 \`require\`。需要的工具函数直接写在文件里。
2. \`DL\` **全 async**——除 info / style / log 外，所有 DL API 返回 Promise，必须 await；
   存储值必须是 Json（null/boolean/number/string/数组/纯对象），函数 / 类实例 / DOM 节点不可存储。
3. \`DL.page.*\` 反向中继：提供 \`DL.page.listen(type, handler, opts?)\`
   （监听页面事件，摘要 { type, key?, detail, timeStamp }）与 \`DL.page.fetchHook(fn, opts?)\`
   （拦截页面 fetch，fn 收 { url, method, headers, body }，回 { action: 'passthrough' } 或
   { action: 'respond', status, headers?, body? }；传 opts.onResponse 可在 passthrough 时被动拿到
   真实响应体 { url, status, statusText, headers, body }，零额外请求）。
   **hook 只拦「页面世界（MAIN）发出的 fetch」，即页面自身 JS 的请求**——脚本跑在独立的
   USER_SCRIPT 隔离世界，它自己的 \`window.fetch\` 与页面那个不是同一个绑定，**脚本自己发的
   请求不会被自己的 hook 拦到**（写脚本时别用「脚本内 fetch 一下、期待被拦」来自测）。
   要拿某个接口的返回，必须让**页面**去发那个请求：触发站点自身交互（点击按钮、切路由等）。
   不要靠往 DOM 注入内联 \`<script>\` 来代发——该通道在本扩展的运行环境里实测走不通，别依赖。
   脚本仍**看不到页面 JS 全局**（框架实例、页面变量），不要写依赖它们的代码。
4. \`allFrames\` 默认 true：脚本可能在同页多个 frame 各跑一次，初始化逻辑要幂等。
5. 生成的脚本**不会自动生效**——先落盘为未启用状态，由用户确认后启用。不要假设「已经跑起来了」。
6. 运行环境（USER_SCRIPT 隔离世界）用浏览器默认的严 CSP：**禁止 \`eval\` / \`new Function\`**，
   也不要引入内部靠它们动态生成代码的库（如 ajv 的编译校验器、Vue 运行时模板编译器）——
   被拦下的代码只在目标页静默失败，排查成本极高。

## 能力清单
- \`DL.info\` —— { uuid, name, version? }（同步）
- \`DL.style(css)\` —— 注入 CSS（同步）
- \`DL.log(...args)\` —— 带前缀日志（同步）
- \`await DL.store.get(key, fallback?)\` / \`set(key, value)\` / \`delete(key)\` / \`keys()\` / \`clear()\`
  —— 脚本私有存储（键空间按脚本隔离，与页面 localStorage 无关）
- \`await DL.store.watch(key, cb)\` —— 跨标签监听键变化，返回取消订阅函数
- \`await DL.fetch(url, init?)\` —— 免 CORS 请求（后台发起）；init 支持 method / headers（含
  Cookie 等禁设头）/ body（string / Blob / FormData / ArrayBuffer）/ responseType:'arraybuffer' /
  timeout（ms）/ redirect；返回 { ok, status, statusText, headers, url, text(), json(), arrayBuffer(), blob() }
- \`await DL.notify(message, opts?)\` —— 系统通知；opts.onClick 注册点击回调
- \`await DL.download(urlOrBlob, name?)\` —— 下载（远程 URL 或本地 Blob/ArrayBuffer）
- \`await DL.clipboard.write(text)\` / \`await DL.clipboard.writeHtml(html, plainText?)\` —— 写剪贴板
- \`await DL.tabs.open(url, opts?)\` / \`close(tabId)\` / \`focus(tabId)\` —— 标签页管理
- \`await DL.cookie.get({ url?, name? })\` / \`set({ url?, name, value, ... })\` / \`remove({ url?, name })\`
  —— cookie 读写删；**url 必须落在脚本自身 matches 内**（域名门，越域报 PERMISSION_DENIED），
  url 缺省 = 当前页
- \`await DL.tab.get() / save(value) / all()\` —— 标签页级存储（随标签页生命周期）
- \`await DL.menu.register(title, handler)\` —— 扩展菜单命令，返回注销函数
- \`await DL.onUrlChange(cb)\` —— 当前标签页 URL 变化订阅（含 SPA 路由），返回取消订阅函数
- \`DL.page.*\` —— 见上文反向中继

## 工作流
1. 先想清楚要改哪个站点、做什么；\`matches\` **默认收窄到目标站点**（如 \`*://example.com/*\`），仅当用户明说「所有网站」才用 \`*://*/*\`。
2. 写完源码后调 script_apply：它同时完成「写内存 + 语法检查」，失败会返回 行:列 诊断，按诊断修改后**再次整体提交**（整文件写，不做局部 patch）。
3. 检查通过即收敛完成，不要反复 apply「优化」——落盘与生效由编排层处理。
4. 结束后用正文向用户说明：脚本做了什么、在哪生效、如何验证。`
