// script_spec 的规范载荷：给模型读的「怎么写脚本」正文。
//
// 分工（改这份文件前先看这条）：
//   · 「能力清单」与「@grant 怎么写」两段是**生成**的 —— 能力来自 lib/gm-api-catalog
//     （GM_API_GROUPS / specEntries），grant 名与恒注入集来自 lib/gm-grants。API 改名 / 新增只改
//     数据，规范文本自动跟着变；两边不漂移由 spec-text.test.ts 断言。
//   · 其余段落是**教导**（形态、硬性约束、边界、工作流），手写在下面 —— 这些推不出来（同步 /
//     异步的差别、CSP 禁令、提交工作流），只能人写。
// 放在独立模块（纯字符串常量），chat-host 与工具实现都不必关心内容。
//
// 注意：本文件是 TS 模板字符串，**手写正文里的反引号必须逐个转义**（写成「反斜杠 + 反引号」，
// 裸反引号会提前闭合模板）；生成段经 ${} 插值拼入，其中的反引号不受此限。

import { GM_API_GROUPS, specEntries } from '@/lib/gm-api-catalog'
import { ALWAYS_GLOBALS, ALWAYS_NS, ALWAYS_WINDOW_MEMBERS, GRANT_NAMES } from '@/lib/gm-grants'

/** 能力清单段：按速查页的分组顺序，一条一行（签名 + 一句话作用） */
function renderCapabilities(): string {
  const entries = specEntries()
  const out: string[] = []
  for (const group of GM_API_GROUPS) {
    const rows = entries.filter((e) => e.group === group.id)
    if (rows.length === 0) continue
    if (out.length > 0) out.push('')
    out.push(`### ${group.title}`)
    for (const e of rows) out.push(`- \`${e.signature}\` —— ${e.summary}`)
  }
  return out.join('\n')
}

/** `@grant` 段：合法名字与恒注入集都取自 gm-grants，规范里不留第二份名单 */
function renderGrantSection(): string {
  const always: string[] = [...ALWAYS_GLOBALS, ...ALWAYS_NS.map((n) => `GM.${n}`), ...ALWAYS_WINDOW_MEMBERS]
  const quote = (names: readonly string[]) => names.map((n) => `\`${n}\``).join('、')
  return [
    `- 写了清单 → 只注入清单内的能力 + 恒注入项（${quote(always)}）；**不写 @grant 或写 \`@grant none\` → 只有恒注入项**（与 Tampermonkey 一致，别指望「不写就全都给」）。`,
    `- 合法名字共 ${GRANT_NAMES.length} 个：${quote(GRANT_NAMES)}。**写别的名字会被静默忽略**，脚本里用了没注入的成员则 ReferenceError。`,
    '- 一个 grant 同时开两种形态（`GM_setValue` 与 `GM.setValue`），不必为 `GM.*` 再写一行。',
  ].join('\n')
}

export const SCRIPT_SPEC_TEXT = `# 哆灵用户脚本规范（生成脚本前必读）

## 形态
脚本 = **单文件纯 JS 源码**（无构建流程，保存即注入匹配页面）。
能力面是**标准油猴 API**（\`GM_*\` / \`GM.*\`）——**标准油猴脚本可以直接粘贴运行**。

配置有两条来源（保存时解析，源码声明者胜）：
1. **推荐：在源码顶部写标准 metadata 块**（\`// ==UserScript==\` … \`// ==/UserScript==\`），
   声明 \`@name\` / \`@match\` / \`@include\` / \`@exclude\` / \`@run-at\` / \`@noframes\` / \`@grant\` / \`@require\`；
2. 界面上的配置（仅在源码**没声明**对应键时生效）。

\`@require\` 在支持范围内：注册时按声明顺序抓取源码，与本脚本**拼在同一条注入代码里**（共享函数作用域），
受 \`<all_urls>\` 豁免 CORS；抓取失败只记一条错误日志并跳过该依赖（**不阻断脚本注入**），
源码按 url 缓存在本地库（手动清除前不重抓）；不做子资源完整性（SRI）校验。

\`@run-at\` 支持 \`document-start\` / \`document-body\` / \`document-end\` / \`document-idle\`；
\`document-body\` 指「body 元素存在时」才开始跑。不写时本扩展按 \`document-end\`（TM 的默认值是
\`document-idle\`，这条差异见 docs/gm-api-gap.md）；\`context-menu\` 暂不支持。

## 硬性约束
1. **单文件、无模块语法**：不能用 \`import\` / \`export\`（classic script 执行，语法检查会当场报错）；
   不支持 \`node:\` 前缀；没有 \`require\`。需要的工具函数直接写在文件里。
2. **读写存储是「同步 + 异步」两形态**：
   - \`GM_getValue(key, def)\` / \`GM_listValues()\` **是同步的**（油猴语义，读注入时预载的快照）；
   - \`GM_setValue\` / \`GM_deleteValue\` 同步返回（本地缓存先落、异步过桥落盘，失败只进错误日志）；
   - \`GM.getValue\` / \`GM.listValues\` / \`GM.setValue\` 是 Promise（\`GM.getValue\` 每次回后台读，永远最新）；
   - 存储值必须是 Json（null/boolean/number/string/数组/纯对象），函数 / 类实例 / DOM 节点不可存储。
3. **\`@grant\` 决定哪些 API 存在**：**只有写进清单的能力才存在**（用了没声明的会 ReferenceError）。
   不写 \`@grant\`、或写 \`@grant none\`，都等于「清单为空」——只剩恒注入项，GM 成员一个都没有。
   **每用一个 GM 能力就要在清单里补上它**，合法名字见下面「\`@grant\` 怎么写」。
4. \`GM_xmlhttpRequest\` 是**回调式**：响应对象有 \`responseHeaders\`（原始多行字符串）、\`responseText\`、
   \`response\`、\`status\`、\`finalUrl\`；事件 \`onload\` / \`onerror\` / \`ontimeout\` / \`onabort\`；
   返回句柄可 \`abort()\`。非 2xx 走 \`onload\`（不是 \`onerror\`）。**没有 onprogress**；
   \`responseType\` 只支持 text / json / arraybuffer / blob。
5. \`unsafeWindow\` 就是**页面自己的 window**（脚本运行在页面主世界）：站点自定义的全局
   （框架实例、\`window.xxx\`）可直接读写，也能往页面上挂自己的东西。
6. \`GM.page.*\` 页面世界能力（**哆灵扩展，非油猴标准**）：
   - \`GM.page.listen(type, handler, opts?)\` 监听页面事件（摘要 { type, key?, detail, timeStamp }）；
   - \`GM.page.fetchHook(fn, opts?)\` 拦截页面 fetch，fn 收 { url, method, headers, body }，回
     { action: 'passthrough' } 或 { action: 'respond', status, headers?, body? }；传 opts.onResponse 可在
     passthrough 时被动拿到真实响应体，零额外请求。
   - **hook 拦的是页面世界（MAIN）的 fetch**。脚本自身也运行在这个世界，所以**脚本自己发的请求
     同样会被拦到**——不想拦自己发的，在 handler 里按 URL 过滤掉。
7. \`allFrames\` 默认 true：脚本可能在同页多个 frame 各跑一次，初始化逻辑要幂等（\`@noframes\` 可关）。
8. 生成的脚本**不会自动生效**——先落盘为未启用状态，由用户确认后启用。不要假设「已经跑起来了」。
9. 脚本运行在**页面主世界**：能不能用 \`eval\` / \`new Function\` 取决于**目标站点自己的 CSP**，
   本扩展不再拦。别依赖动态代码生成（如 ajv 的编译校验器、Vue 的运行时模板编译器）——
   站点一旦收紧 CSP，这类代码会在目标页静默失败，排查成本极高。

## 能力清单

${renderCapabilities()}

\`GM.*\` 是本批能力的 Promise 化形态（如 \`await GM.getValue(key)\`，每次回后台读、永远最新）；
**\`GM.*\` 下没有 cookie**（按 Tampermonkey 口径），cookie 只用 \`GM_cookie\`。
标着「哆灵扩展，标准里无对应物」的条目不是油猴标准，按本扩展的实现写。
**用 \`GM_getResourceText\` / \`GM_getResourceURL\` 之前，必须先在头部声明 \`@resource 名字 地址\`** ——
声明即预加载（内容随注入体一起就绪，所以这两个是**同步** API）；没声明的名字取到 undefined。

### 明确不支持（别写，写了不会生效或会以错误形式暴露）
- \`@connect\` 白名单（本扩展的跨域请求不需要声明）
- \`GM_xmlhttpRequest\` 的 \`onprogress\` 与 \`responseType: 'stream'\`（这两项 TM 有、本扩展暂无）
- 同步 \`GM_xmlhttpRequest\`：TM 官方也明确不支持；\`responseType\` 的合法值只有 arraybuffer / blob / json / stream
- \`GM_cookie\` 的 \`domain\` / \`path\`（安全收紧项，传入即报错）

## \`@grant\` 怎么写

${renderGrantSection()}

## 工作流
1. 先想清楚要改哪个站点、做什么；\`@match\` **默认收窄到目标站点**（如 \`*://example.com/*\`），仅当用户明说「所有网站」才用 \`*://*/*\`。
2. 写完源码后调 script_apply：它同时完成「写内存 + 语法检查」，失败会返回 行:列 诊断，按诊断修改后**再次整体提交**（整文件写，不做局部 patch）。
3. 检查通过即收敛完成，不要反复 apply「优化」——落盘与生效由编排层处理。
4. 结束后用正文向用户说明：脚本做了什么、在哪生效、如何验证。`
