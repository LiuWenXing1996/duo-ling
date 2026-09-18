// script_spec 的规范载荷（notes/content/userscript-ai-generation.md）。
//
// 来源：notes/content/userscript-api.md（DL 能力 API 权威规范）+ notes/content/userscript-ai-generation.md的禁止事项清单。
// 按 §6.2 #11 拍板：由文档拼一段注入文本即可，.d.ts 留给脚本作者（v2 计划 P3）。
// 放在独立模块（纯字符串常量），chat-host 与工具实现都不必关心内容。

export const SCRIPT_SPEC_TEXT = `# 哆灵用户脚本规范（生成脚本前必读）

## 形态
脚本 = 多文件项目（入口 .ts/.js + 可选模块），由 esbuild 打包成单 IIFE 注入匹配页面。
配置走 \`config\` 对象（matches / excludeMatches / includeGlobs / excludeGlobs / allFrames / runAt），
**不写 \`==UserScript==\` metadata，没有 \`@grant\` / \`@require\` / \`unsafeWindow\`**——照抄油猴模板跑不起来。

## 硬性约束
1. 入口文件**不得有顶层 \`export\`**（iife 格式约束）。
2. 依赖只能 \`import 'https://…'\`（CDN 完整 URL，如 https://esm.sh/lodash-es@4）；**裸包名 \`from 'lodash'\` 会报错**；不支持 \`node:\` 前缀。
3. \`DL\` **全 async**——所有 DL API 返回 Promise，必须 await；存储值必须是 Json（null/boolean/number/string/数组/纯对象）。
4. \`DL.page.*\` 反向中继（规范 notes/content/userscript-page-relay.md）：提供 \`DL.page.listen(type, handler, opts?)\`
   （监听页面事件，摘要 { type, key?, detail, timeStamp }）与 \`DL.page.hook('fetch', fn)\`
   （拦截页面 fetch，fn 收 { url, method, headers, body }，回 { action: 'passthrough' } 或
   { action: 'respond', status, headers?, body? }）。脚本仍**看不到页面 JS 全局**（框架实例、页面变量），不要写依赖它们的代码。
5. \`allFrames\` 默认 true：脚本可能在同页多个 frame 各跑一次，初始化逻辑要幂等。
6. 生成的脚本**不会自动生效**——先落盘为未启用状态，由用户确认后启用。不要假设「已经跑起来了」。
7. 运行环境（USER_SCRIPT 隔离世界）用浏览器默认的严 CSP：**禁止 \`eval\` / \`new Function\`**，
   也不要引入内部靠它们动态生成代码的库（如 ajv 的编译校验器、Vue 运行时模板编译器）——
   被拦下的代码只在目标页静默失败，排查成本极高。

## 能力清单（一期）
- \`DL.info\` —— { uuid, name, version }（同步）
- \`DL.style(css)\` —— 注入 CSS（同步）
- \`DL.log(...args)\` —— 带前缀日志（同步）
- \`await DL.store.get(key, fallback?)\` / \`await DL.store.set(key, value)\` / \`delete\` / \`keys\` / \`clear\` —— 脚本私有存储（键空间按脚本隔离，与页面 localStorage 无关）
- \`await DL.fetch(url, init?)\` —— 免 CORS 请求（后台发起）；返回 { ok, status, text(), json(), arrayBuffer() }
- \`await DL.notify(message, opts?)\` —— 系统通知
- \`await DL.download(url, name?)\` —— 下载
- \`await DL.clipboard.write(text)\` —— 写剪贴板
- \`await DL.tabs.open(url, opts?)\` —— 开标签页
- \`DL.store.watch\` 与 \`DL.menu.register\` 为二期，调用抛 NOT_AVAILABLE，**不要用**。

## 工作流
1. 先想清楚要改哪个站点、做什么；\`matches\` **默认收窄到目标站点**（如 \`*://example.com/*\`），仅当用户明说「所有网站」才用 \`*://*/*\`。
2. 写完文件树后调 script_apply：它同时完成「写内存 + esbuild 构建」，构建失败会返回 file:line 诊断，按诊断修改后**再次整体提交文件树**（整文件写，不做局部 patch）。
3. 构建通过即收敛完成，不要反复 apply「优化」——落盘与生效由编排层处理。
4. 结束后用正文向用户说明：脚本做了什么、在哪生效、如何验证。`
