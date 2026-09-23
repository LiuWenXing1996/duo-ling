# 架构

> **本文件是运行时架构的唯一登记处**：载体与运行时、对话链路、脚本注入、页面上下文、存储分库、统一保存、用户脚本版本管理、数据广播、构建信息注入。
> 改这些实现前读它，改完就地更新。
>
> 相关：协作约定与红线见 [AGENTS.md](AGENTS.md)；工程介绍与目录结构见 [README.md](README.md)；扩展**自身**版本号见 [VERSIONING.md](VERSIONING.md)。

## 形态

Chrome MV3 扩展（background service worker + 工作台标签页；对话界面是 content script 按需挂进网页的浮层，另有工具栏 popup）。原 Electron 桌面版实现已不在工作区，需要参照时从 git 历史取回。

## 载体与运行时

| 上下文 | 载体 | 角色 |
| --- | --- | --- |
| 扩展页 | `floatpanel.html`（网页浮层 iframe） | **对话界面（唯一入口）**：指令入口与观察窗；显示**它所在标签页**的会话（tab 身份由 content script 经 iframe URL 传入） |
| 扩展页 | `workbench.html`（标签页） | 重界面工作区（脚本管理 / 运行日志 / 会话历史 / 设置等） |
| 扩展页 | `popup.html`（工具栏 popup） | 页面外的入口：打开当前页的对话浮层（**对话框的常规打开方式**）+ 本页脚本（本页在跑的脚本与报错）+「打开工作台」，并说明当前页面为何挂不了浮层；**不承载对话**（不装 `window.api`） |
| 内容脚本 | `content.ts`（第三方页面 ISOLATED world） | 网页浮层的宿主：**平时不往页面里放任何 DOM**，收到 `float:open` 才挂出 iframe 并展开，收到 `float:collapse` 收起（只加 `display:none`，iframe 与草稿都留着）；位置钉在视口右下角，拾取期间整块让位 |
| SW | `background.ts` | **能力运行时**：用户脚本注册（`chrome.userScripts`）+ 状态库写命令转发 + offscreen 容器管理 + 模型配置中转 + 网页浮层的右键菜单入口 |
| 离屏文档 | `offscreen.html`（按需创建） | AI 生成链路的执行宿主 + `duoling-fs` 源码的唯一写入方 |
| 注入世界 | MAIN（第三方页面内） | 用户脚本自身逻辑；GM 包装层（`gm-wrapper.ts`）在同一函数作用域里声明 `GM_*` / `GM.*`，能力调用经同帧 USER_SCRIPT 中继件（`script-relay.ts`）转 SW |

各载体承载什么、标签页有哪些，见 [README.md](README.md)「载体分工」；网页浮层的挂载细节（shadow DOM 隔离、iframe 懒加载、拾取期间让位、CSP 降级、收起语义）见 [src/entrypoints/content.ts](src/entrypoints/content.ts) 顶部注释。**打开入口都在页面之外**：工具栏 popup 的「对话浮层」按钮，与页面右键菜单（SW 注册，`documentUrlPatterns` 限 http/https）—— 对话框平时不在页面里，页面上没有任何可点的地方。两条都收敛到同一条定向消息（`FloatOpenRequest`，`tabs.sendMessage`，不经 SW），内容脚本收到就地挂出 UI 并展开。**收起走反向的另一条消息**（`FloatCollapseRequest`）：对话框顶栏那颗按钮在 iframe 里（跨源，父页拿不到它的事件），只能发消息叫父页把容器藏起来；刻意不用 `postMessage` —— 宿主网页的脚本挂在父 window 上，既能监听也能用 `iframe.contentWindow.postMessage` 伪造来源，那等于把「关掉扩展界面」开放给被注入的页面。浮层本身是页面里的 `<iframe>`，因此受第三方页面 `frame-src` 约束（严格 CSP 的站点会拦掉；换 `chrome.userScripts` 注入绕不过 —— 那条 CSP 只管脚本，不管页面 DOM 能嵌入什么）；`floatpanel.html` 必须进 `web_accessible_resources`，被拦时要降级成文字提示、不静默失败。

## 对话链路

指令入口（网页浮层）只做观察；整条链路（`streamText` + tools）跑在 **offscreen document**，入口经 IPC 订阅事件流；跨域仍由 `host_permissions` 授权。offscreen 容器按需创建（`src/lib/offscreen.ts`）。

- **会话归属按标签页**：一个 tab 一条会话，切 tab 即切会话。归属映射（tabId → conversationId）存 `duoling-app` 的 `convByTab` 键（`src/lib/conversation-tab-map.ts`）—— **既不进会话库、也不进对话链路**：任务与流的键始终是 conversationId（`chat-host.ts` 的 `runningByConversation`、transport 的 `consumers`），所以这套绑定对执行层零影响，断了本地流任务照跑、切回来 resumeStream 接上。
  - 归属解析**只在 `lib/owning-tab.ts` 一处**：浮层认 content script 经 iframe URL 传来的 `?tab=<id>`（固定归属）—— 不能跟「当前激活标签页」走，浮层可能挂在一个已经不是激活的标签页上；popup 认点开那一刻的激活页（`resolveActiveTabId`）—— 它没有固定归属、也从不与某个标签页长驻绑定。会话归属（`use-global-conversation`）、随消息发出的页面上下文（`extension-chat-transport`）、页面脚本运行集（`use-page-monitor`：浮层传 owning、popup 传 active）都经它取 tab。
  - **惰性新建**：tab 没有归属会话时不建、不落库、不进历史列表（未绑定态），发出第一条消息时才 create 并登记。
  - 归属映射的清理归 **SW 的 `tabs.onRemoved`** —— 面板没开时 tab 照样会被关，只有常驻的 SW 不漏。
  - 历史会话的查看 / 改名 / 删除在工作台「会话历史」标签页（`SessionHistoryTab.vue`：列表复用 `SessionHistoryPanel`，右栏用 `ChatPanel` 的只读模式回放）；对话界面里没有会话列表，也没有「新建会话」。
  - **删除有前置门**：会话正被**开着的**标签页使用就不让删（它是那个标签页的现场）。判据在 `conversation-tab-map.ts` 的 `getActiveTabBindings` —— 「映射里有」**且**「该 tab 还活着」两条都成立才算在用：SW 的 `tabs.onRemoved` 负责及时清映射，但判据**不能只依赖它**（SW 可能被回收，残留项会把已关闭的标签页算成在用，用户就删不掉又找不到是哪个标签页）。无法判定 tab 存活时保守算作在用。
  - 被挡下时不只拒绝，还要**告诉用户去关谁**（`SessionHistoryTab.vue`）：单条删除给文案（带那个标签页的站点名，`chrome.tabs.get` 取 url）+ 一颗「去那个标签页」按钮；「删除全部」则在弹框里**逐条列出**「会话标题 · 站点」，每条各配跳转按钮。跳转一律先 `windows.update({focused})` 再 `tabs.update({active})`（跨窗口时只 active 不会把窗口翻上来），且**跳完不收起弹框**（多条场景要连着关好几个）。
  - **弹框形态按「哪种删除被挡」分（`blocked.kind`），不按目标条数分**：按条数分会出岔 —— 「删除全部」只碰到 1 个占用时，文案说「以下 1 条」而列表按「多于 1 条才显示」的规则不出现，成了指向空气的「以下」，按钮措辞也串成单条那套。

- **会话随标签页结束**：标签页关闭时 SW 顺手**中止该会话正在跑的任务**（`background` 的 `tabs.onRemoved` → `abortConversationOfClosedTab`：先按归属映射找到会话、再解绑，然后向 offscreen 发 `chat:abort`）。任务跑在 offscreen、与页面无关是刻意的，但会话按标签页归属 —— 页面没了就没人看结果、也没处按停止，不喊停它就会一路跑完、静默消耗 token。这种中止**不记未读通知**（用户自己关的页面，再报一条「已完成」是误导）。用户侧另有就地入口：工作台「会话历史」列表给生成中的会话打「生成中」标 + 一颗停止按钮（`useChatRunning` 拉 SW 的进行中快照，`chat:abort` 由上层发出）。

- **会话被删时，指向它的通知一并清掉**：工作台删除成功后调 `notify:drop`（单条带会话 id、「删除全部」带 `all`）。这步**必须走 SW** —— 角标数字归 SW 维护，工作台要是自己清了库，SW 既不知道、也没人喊它重算，角标就会挂着一个已经不对的数字。不清的后果是弹层里留一条点不开的通知（会话都没了，点开也没有落点）。

- **中止也保留已生成的内容**：中止（用户点停止 / 关标签页 / 流中断 / 静默超时 / 循环异常）都会把已经吐出来的那部分落盘，并附一个 `data-interrupted` 标记 —— 半截文字是用户要的东西，丢掉就真没了；界面在消息下方标「已中断」，免得事后把半截当成完整回复。两条刻意不做：**不落产物**（半截脚本没有意义，落盘反而让人以为生成完了）、**不留没有结果的工具调用**（`isPendingToolUIPart` —— 否则历史里是一串转不完的卡片）。

- **任务状态与通知中心**：offscreen 在任务开始 / 收尾各推一条（`chat:running` / `chat:finished`，`OffscreenPush`），SW 旁听后分发到两个出口 —— 一份信号、两种「离用户多远」的表达。
  - **工具栏角标 = 通知数（全局那一份）**：红底白字，数字 = 「进行中 + 跑完没看」的条数（>9 显示 `9+`）。**只报数、不分类**：什么颜色代表什么状态是要用户记的额外约定，而具体是什么事去 popup 看；悬停文案另给一句明细（`进行中 1 · 已完成 2`）。它不受页面影响 —— 对话框收起后页面里没有任何提示位，只剩它。数字由 `refreshBadge` **重算**而来，不是「收到事件时顺手设一下」：事件到达的时刻与「用户此刻看得见吗」未必同时成立 —— 任务在对话框开着时开始、用户之后才收起，就是一个没有事件来过的时点。
  - **popup = 明细**（`PopupNotifications`，走 `notify:*` 命令面）：进行中几条、哪几条跑完没看；点条目跳过去（那个标签页还开着就唤起它的浮层，已关就落到工作台「会话历史」）并标已读，另有「全部已读」。已读是**按会话**标的：角标是全局的，但「看过没看过」是各标签页各自的，不该替用户读掉别人的未读。无通知时整块不渲染。
  - 两个出口共用的判据：**「用户此刻在看对话界面吗」= 对话框展开 且 页面可见** —— 两条都成立时 content script 连上 `FLOAT_PANEL_OPEN_PORT`，否则断开（页面卸载 / 导航则端口自然断）。**不能拿「面板文档存活」判**：收起只是给它加 `display:none`（iframe 与面板文档刻意留着，草稿 / 滚动位置不丢），那条端口永不断开，角标就永不变（2026-09-21 无头实测确认）。**「页面可见」那条也不能省**：对话框还开着、人却切去别的标签页忙了，他同样什么都看不见 —— 少了它，切走期间既不亮角标也不记通知，任务跑完一点提示都没有。可见性取 `document.visibilityState`，**不掺窗口焦点**（`hasFocus`）：点一下地址栏 / 书签栏就会失焦，那会让角标无意义地闪一下；代价是「Chrome 窗口在前台、人去用了别的应用」仍算在看。
  - 回到「在看」状态时（对话框刚打开、或从别的标签页切回来）：角标清空、该会话的通知标已读 —— 但**不动**别的标签页的未读。
  - 通知落在 `duoling-app` 的 `notifications` 键（`lib/notifications.ts`）：只存**已发生**的事 —— 进行中不落库（SW 被回收后内存里那份就没了，而库里若留一条恒为「进行中」的记录，再不会有事件来收尾它，成了假状态）；同一会话的未读只留一条（跑两次都还没看 = 一件事，否则角标数字虚高），已读最多留 20 条（它不是历史记录）。加新通知类型只动三处：`kind`、popup 的文案、跳转落点 —— 角标与池子都不用改。

- **流式静默超时（防限流）**：`runLoop` 泵流期间挂 `createIdleGuard`（`src/lib/offscreen-chat/idle-guard.ts`），两次 chunk 间隔超 `STREAM_IDLE_TIMEOUT_MS`（默认 60s，可在模型高级配置里按 provider 调整 `streamIdleTimeoutSec` 秒）即判定 provider 卡死（有连接但不吐 token），主动 `abort` 并推 error 块「请求超时…已自动中止」。避免静默卡死的请求长期占用网关连接/并发配额、累积触发限流；用户手动停止走 `abortChat`，与此计时无关。模型配置探活 `testChat` 另有 15s 超时。
- **对话流内的卡片走 `data-*` part**（`data-generation` 生成卡片、`data-net-capture` 录制同意卡）。两条硬约束：① 历史消息送模型前 `stripDataParts` 会剥掉全部 `data-*`（UI 专用，不进上下文）；② 卡片若由**工具执行中途**推送（同意卡的 `requestConsent` 回调即此例），必须在 `runLoop` 里收集（`midStreamParts`）并在收尾插进落盘序列——`allChunks` 只收 `streamText` 的输出流，中途手工推的 part 不在其中，不收集就只在流里闪一下、重开面板即消失（而卡片往往是用户唯一的操作入口）。

- **附件（图片 / 文本文件）**：转换全部在**发出前**完成，链路下游（transport / offscreen / provider）不需要知道「附件」这个概念 —— 图片压成 data URL 的 file part 随消息走，落盘、回读、每轮重发都沿用 parts 的既有机制；文本文件读成文本拼进正文（OpenAI 兼容接口不支持任意文件上传）。**压缩只能在发出前做**：图片一旦随 user 消息落盘就是历史的一部分，以后每轮都会重新发给模型，事后再想换张小的已经改不动。处理逻辑集中在 `src/lib/chat-attachments.ts`。
  - **图片统一转 JPEG**（长边 ≤1568、先铺白底）：JPEG 是各家兼容服务端的接受交集 —— PNG 压不动体积、WebP 有一批服务不认。代价是丢透明通道，对截图 / 设计稿无影响。
  - **能不能发图由模型的 `vision` 声明决定**（`ModelProfile.vision`）：图片以 image part 直接进请求体，读不了图的模型要么报错（用户看到的是上游原文报错）、要么静默丢弃图片后照着文字编内容；而带图消息一发即落盘，那之后**每一轮都带着它**，会让这个会话从头废掉且用户无从定位。故未声明时**入口保留但只收文本文件** —— 不隐藏入口（隐藏会让人以为没这个功能），也不整枚禁用（文本文件仍然发得出去），并在入口提示里说明原因；`accept` 随之切换，粘贴 / 拖拽走同一道校验。
  - **历史里有图、当前模型读不了时，发送前就拦下**（`ChatPanel.prepareAndSend`）：请求体带的是整段历史（服务端无状态、图片每轮重发），所以这种会话**每一轮**都会失败，而不是只失败带图那一轮。拦下的文案要说清两条出路（换模型 / 新开对话），不能让用户每轮去读一次上游报错。判据只看「历史 parts 里有没有 file」，与本届带不带附件无关。
  - **声明默认关闭**：老配置与新建配置都从「不支持图片」起步；模型表单里按预设表给已知的视觉模型预置默认值（`providers.ts` 的白名单）。拿不准的一律不预置 —— 预置错比不预置坏得多，漏了只是让用户手勾一下。
  - 输入区的附件状态由 `ChatPanel` 自持：它在自己的 setup 里创建 prompt-input 的上下文，`PromptInput` 会继承外层的那个（组件的双模式）—— 于是附件 chip、入口按钮、提交分流都留在对话面板内，通用组件不用装对话特有的逻辑。

## 脚本注入

`chrome.userScripts` + **页面 MAIN 世界**注入 + **GM 包装层**（`gm-wrapper.ts`）与 **USER_SCRIPT 中继件**（`script-relay.ts`）桥接（`src/lib/userscripts/`）。

标准 `==UserScript==` 脚本可直跑：`@grant` 驱动能力注入（`metadata.ts` 解析 metadata → 归一化进 `ScriptConfig`；grant 名 → 它开启的成员这张对应表在 `gm-grants.ts`，注入侧、速查页与 AI 规范三处共用这一份）；能力表 `gm-api-catalog.ts` 一张生成速查页、`.d.ts` 与**给 AI 的能力清单**三形态（50 条，三防漂移：类型层 `satisfies` + 从注入源码反射 + 规范文本对齐单测）。内部仍走 `dl-bridge.ts` 的 `__dl` 信封协议（协议稳定、与 DL 时代一致）。

- **可用性前置**：`chrome.userScripts` 在用户未开启「运行用户脚本」时**不存在**，直接调用会让 SW 初始化崩溃。引擎每条入口都先判存在性（`isUserScriptsAvailable()` / `typeof chrome.userScripts.register === 'function'`）再优雅跳过；开启引导统一交给工作台「引导」标签页（各处只给「查看开启引导」入口，不各写一套步骤）。

- **同步值快照**：注册时 SW 把 `duoling-usdata` 全量值快照嵌入注入体，`GM_getValue` / `GM_listValues` 纯内存读；写后 debounce `userScripts.update()` 刷新（阈值参照 VM `FLUSH_DELAY=100`）。`GM.getValue` 走实时桥读（永远新鲜）。
- **只读脚本的下行通道**：读写值 / 订阅变更的脚本经 `store.watchAll` 常驻 Port 接收变更；connect 成功后主动全量校准一次，覆盖 Port 建立前的窗口。**两条订阅的退订是不对称的，这是刻意的**：`url.watch` 配 `url.unwatch`（脚本摘完 `onurlchange` / `urlchange` 监听即退订，并复位注册重放位 —— 不复位则 Port 重连会把已无人要的订阅重新挂上）；`store.watchAll` **不配退订**，因为「读过值」本身就意味着要一直收（退订会让同步读退回陈旧，是缺陷不是能力），它的清理只随 Port 断开发生。
- **靠下行帧的回调必须先等通道**：`GM_xmlhttpRequest` 的 `onprogress`、`GM_download` 的 `onprogress` / `onload` / `onerror`、`GM_notification` 的 `onclick` 都由 Port 推帧送达，而请求-应答（`sendMessage`）**不会**把 Port 建起来。只调这几个 API、不读值 / 不注册菜单 / 不订阅音频的脚本会踩到：SW 侧 `portsByConnId` 命中 0 个连接，帧全被丢掉，而请求 / 下载本身照常成功——表现为「回调永不触发」（2026-09-22 真机查了两轮才定位）。故这些命令统一先等通道再发（`__gmSendAfterChannel`）；通道建不起来也**照发**（降级不阻断），但 SW 侧 `warnNoPort` 会按连接喊一次，不做新的静默失败。
- **`@grant` 精确注入**：语义对齐 TM —— **不写 `@grant` / `@grant none` 都等于空清单**（只剩恒注入项），写了才给对应成员。`unsafeWindow` 就是页面自身的 `window`（脚本跑在主世界）；`window.onurlchange` / `GM.page.*` / `GM_info` 恒注入（不受 grant 限制，这点比 TM 宽松）。
- **脚本主世界注入 + 中继桥**：脚本注入页面 MAIN 世界（与 Tampermonkey 默认一致，`unsafeWindow` 因此就是页面 window）。MAIN 世界没有 `chrome.*`，能力调用经同帧的 `dl-script-relay`（独立 USER_SCRIPT 世界 `us-dl-bridge`，`messaging: true`）转给 SW，桥协议见 `bridge-protocol.ts`（每条消息带 `digest(secret, uuid:seq)` 防页面伪造与重放）。注入代码是「GM 包装前缀 ＋ `@require` ＋ 脚本源码 ＋ 闭合后缀」拼成的**一条** code —— MAIN 不支持 `worldId`，同帧多脚本共享一个 window，故 `GM_*` 一律声明在包装的函数作用域里（挂 window 会互相覆盖）。
- **cookie 域名门**（红线索引见 [AGENTS.md](AGENTS.md)「硬性底线」「cookie 能力」）：入口为 `GM_cookie.list/set/delete`（原 `DL.cookie`），门仍在 SW 侧、只比 scheme + host，`set` 仍禁 domain / path 覆写。
- **GM_xmlhttpRequest 的 forbidden header 覆写**（Cookie / Referer / UA 等）与 `redirect:'manual'` 走 DNR session 规则按请求挂/撤 + 观察型 webRequest（`dl-fetch-priv.ts`；权限 `declarativeNetRequestWithHostAccess` + `webRequest` 均不新增用户可见提示）。**DNR 的头修改不跨重定向 hop**（跨 host 的 hop 不套用，Chrome 平台限制，油猴同款）。
- **GM_download 走浏览器下载器**（`chrome.downloads`，权限 `downloads`）：只有它能弹「另存为」（`saveAs`）、也只有它是流式落盘（旧实现要把整份文件读进内存再经 data URL 点锚点，大文件会炸）。`downloads` 是**用户可见权限**（安装 / 更新时提示「管理您的下载内容」）。进度靠 SW 轮询 `search()`（`onChanged` 不给下载中的字节数），由 offscreen 心跳保活常驻支撑。
- **覆写期间同 host 互斥**（写优先读写锁，防规则污染并发请求）：DNR 规则只能按 host 匹配，没有「只作用于某一次请求」的粒度，故覆写挂起期间该 host 的**所有** GM_xmlhttpRequest 都会套上覆写头；生命周期三层兜底（settle finally 撤 → SW 启动对账自有 id 区间 → session 规则浏览器重启自清）。机制与验证路径见 `dl-fetch-priv.ts` 顶部注释。
- **CSP 跟随目标站点**：脚本运行在页面 MAIN 世界，不再由本扩展配置 CSP —— `eval` / `new Function` 能否使用取决于站点自身策略。生成提示词与 `script_spec` 仍明令避开动态代码生成，保存时由 `collectCspWarnings` 对含 `eval` / `new Function` 的注入代码给非阻塞警告。
- **网络录制（dl-recorder，两段式常驻件）**：要拦页面**自己**发出的 `fetch`/`XMLHttpRequest`，钩子只能挂 MAIN 世界（USER_SCRIPT 各有独立 realm，挂它的 `window.fetch` 拦不到）；而 MAIN 世界无 `chrome.*`。故两件协作、都按「用户已同意录制的 host 集合」注册（`net-capture-gate.ts`，默认空集＝不注册）：
  - `dl-net-recorder`（`world: 'MAIN'`，`document_start`）：包装 `fetch` 与 XHR，非阻塞采样后 `window.postMessage`（标签 `__dlNetCapture`）交给同帧；
  - `dl-net-forwarder`（独立 USER_SCRIPT 世界 `us-dl-net`，`messaging: true`）：监听该标签消息，经 `chrome.runtime.sendMessage` 转 SW；
  - SW 侧 `dl-bridge` 用 `normalizeCapture` 白名单化（载荷经页面可伪造的 postMessage，形状不可信）后落 `duoling-netlog`。采样剥鉴权头、**URL 的 query/fragment 凭据脱敏**（`stripUrlSecrets`：键名命中敏感词或值超长即换 `***`，键名保留）、请求/响应体各封顶 ≤2KB、每 host 环形 ≤200 条。
  - **录制的 AI 路径**（用户同意是硬门槛）：`net_capture_enable` 工具**只出同意卡、不开录制**——开启的唯一入口是用户点卡片上的按钮（`userscriptClient.netCaptureEnable` → SW 写门禁 + 重注册）。卡片走 `data-net-capture` data part（同生成卡片的机制，随消息落盘，重开面板仍在）；开启后引导用户点**浏览器的刷新按钮**——录制是前向的，钩子只在文档开头挂，不刷新就录不到已跑完的首屏请求。读回走 `net_capture_read`（`net-record-digest.ts` 压两档：摘要档常驻 prompt、全量档给工具），`system-prompt.ts` 有对应档位。
- **MAIN 世界多包装者共存**：脚本包装里的 `GM.page.fetchHook` 与 `dl-recorder` 都会替换 `window.fetch`。故两边的记录与还原一律取**当时链下的实际值**（钩住时取当前 `window.fetch` 作 `prev`、摘钩时还原被摘元素的 `prev`），**不得用注入期快照**——否则后安装的那个包装者会被摘钩还原掉，在该页余下生命周期里永久失效。`GM.page.fetchHook` 的卸载同理不做链上摘除，只清空本层裁决（同帧多脚本各持一层，跨脚本协调摘除做不到）。

## 页面上下文

- **点选元素**：`chrome.userScripts.execute()` 按需注入内置拾取器，产物暂存后随下一条消息发出。目标 = **当前窗口的活动标签页**（拾取由用户在看得见的面板上点按钮发起，那一刻它就在激活页上）。
- **页面快照**：AI 侧 `page_snapshot` 工具经 SW 采集。目标 = **这条会话所属的标签页**（不是「当前激活页」：快照是 AI 在生成中途自己决定要采的，那时用户可能已经切到别处）。反查走归属映射（`findTabsUsingConversation`，自带 tab 存活校验），会话没绑标签页时才退回最后聚焦窗口的激活页。
- **注入前先按 scheme 拦**：`<all_urls>` **不覆盖 `chrome-extension://`**（连本扩展自己的页面也一样），未授权的 `file://` 也报同一句 —— 往上注入必失败，加 host 权限解决不了。判据在 `element-picker-client.ts` 的 `pageInjectionBlockReason`（拾取与 SW 快照共用），平台英文报错经 `friendlyInjectError` 归一成用户的下一步动作。

## 存储（IndexedDB 分库：源码 / 注册态 / 脚本数据 / 观测数据 / 应用配置 / 会话 / 网络录制，2026-09-19 重构）

> 分库写权限是硬边界：**注册链路对 offscreen 存活零依赖**。

① **源码唯一来源 `duoling-fs`**（lightning-fs，IndexedDB 后端，**只许 offscreen 碰**，`us-fs.ts` 单例）：每脚本一仓 `/uscripts/<uuid>/`——`script.js`（单文件纯 JS 源码，2026-09-20 单文件化）即工作树（未提交改动 = 草稿），git 历史 = 每次保存的版本（`us-git.ts`，仓损坏只丢历史不丢脚本）；配置由源码里的 `// ==UserScript==` 块派生（`resolveConfigFromSource`），**不再有并行元信息文件**；SW/扩展页读不到 lfs，**源码读写一律走 `fs:*` 命令向 offscreen 取**（`offscreen-fs-commands.ts`）。

② **注册态库 `duoling-state`**（独立 IndexedDB，`state-db.ts`/`project-store.ts` 读、`project-write.ts` 写，**写只归 offscreen**）= 每脚本一条 `ScriptProject`：元数据 + enabled + **源码搬运副本 `source`**（SW 读不到 lfs，注册的注入代码从注册态取）——SW 注册直读 `source.code`，注册链路对 offscreen 存活零依赖（既定不变量）。

③ **脚本数据库 `duoling-usdata`**（`usdata-db.ts`，**写只归 SW**）：`GM.*` 存储值（gm store，复合主键 `[uuid,key]`）与 `GM.*` 标签值（tab store，`[uuid,tabId]`）——**脚本自己写的数据**（不可信、无上限），复合主键 + 索引替代旧 chrome.storage 字符串键拼接，范围查询不再全库扫描。

④ **观测数据库 `duoling-runtime`**（`runtime-db.ts`，**写只归 SW**）：错误日志（errors store，单记录环形 ≤ `ERROR_LOG_MAX`）、运行统计（stats store，每脚本一记录：总次数 / 最后运行时间 / 最近一次运行错误数）与运行日志（runlog store，全局环形 ≤ `RUN_LOG_MAX`）——统计与日志**并进同一事务写入**（`mutateStatsAndLog` 跨 store，逐条日志不额外放大写入）；读改写在事务内天然原子；错误明细按 runId 与日志关联，工作台「运行日志」标签页 = 时间线（运行行 + 孤儿错误行，`listRunTimeline` 合并读）。用户脚本的存储**全部落 IndexedDB**；GM 存储写出口发变更事件（`onGmValueChange`，值未变 / 删不存在键不发）。

⑤ **应用配置库 `duoling-app`**（`app-db.ts`，泛用 kv store）：模型配置（`modelProfiles`，API Key 经 AES-GCM 加密落盘，见 `src/lib/key-cipher.ts`——**密钥同存本机，属防扫描级而非保密级**）、key-cipher DEK、MAIN 世界桩密钥（`pageSecret`）、**标签页 → 会话的归属映射（`convByTab`，见 `conversation-tab-map.ts`）**、**新版本检查结果（`updateCheck`，见 `update-check.ts`）**——扩展自己的小数据。`chrome.storage.local` 只剩开发者模式开关这类零星设置（`dev-mode-store.ts`，storage 键的读写与订阅都集中在该模块）。归属映射是**整表一个键**，而写方有两处（面板登记新会话 / SW 在 tab 关闭时清理），可能交错，故写入一律走 `app-db.update` 的单事务「读-改-写」（拆成 get+set 会丢更新）。

⑥ **会话库 `duoling-chat`**（`conversation-store.ts` 读写，**唯一写方 = offscreen**，读侧（对话界面 / 工作台会话历史）只读订阅）：会话与消息 + 生成任务快照（tasks store，宿主被杀后可续）——它不在 userScripts 链路里，故与 `duoling-state` 分开。

⑦ **网络录制库 `duoling-netlog`**（`netlog-db.ts`，**写只归 SW**）：`captures` store（自增主键 + `by_host` 索引）——页面接口流量的**采样**（隐私敏感、按站点授权），每 host 环形 ≤ `NET_HOST_RING_LIMIT`（超限删最旧）。写入口是 `dl-bridge` 的 `__dlNetCapture` 分支；门禁（哪些 host 在录）是**应用配置**，存 `duoling-app` 的 `netCaptureHosts` 键（见 `net-capture-gate.ts`）。与 `duoling-runtime` 分开：那是脚本观测数据，这是「页面之外」的网络流量采样，生命周期随「关录制 / 清记录」走。

DevTools 里按库名过滤：`duoling-fs` / `duoling-state` / `duoling-usdata` / `duoling-runtime` / `duoling-app` / `duoling-chat` / `duoling-netlog`（**不存在名为 `duoling` 的库**）。

## 统一保存（2026-09-20 单文件化：保存恒成功、保存即注入）

一切源码落盘（编辑器保存 / AI 收尾 / 历史恢复 / zip 导入 / 链接导入 / 粘贴导入 / 新建）收敛到 offscreen 单一入口 `project-write.saveSource`：写工作树 → git 提交 → 写状态库（含源码搬运副本）→ 出口广播。

- **保存恒成功、保存即注入**：无构建流程，源码原文随落盘进注册态，注册的注入代码 = 源码本身。语法错误不拦保存：坏了的脚本照样装（油猴同款），运行期报错走现成的错误日志 / 运行日志链路。
- 编辑内容只活在页面内存（草稿机制已删）：有未保存改动时标签栏标题后点红点，关标签前弹确认（确认里可直接「保存并关闭」）；历史恢复会连草稿一并覆盖，恢复确认里按该脚本的编辑器脏状态追加提醒。
- **脚本名不入仓**：改名（`renameProject` / `state:rename`）只改状态库记录的 `name`，不写源码、不产生提交——名字是管理面标识（列表 / 标签页 / `GM_info` / 错误日志分组名），与源码里的 `@name` 互不覆盖（见 `saveSource` 的 adoptName 说明）。
- **导入（zip / 本地路径 / 粘贴 / 链接）**：取内容方式不同（zip 解码 / 读本地文件 / 直接粘源码 / 抓远端脚本），落盘同在 offscreen（单写方），导入即完成（无后台构建队列）；只拦原则项（缺 script.js 源码文件），其余尽量导入 + 报告说明（配置由源码里的 `// ==UserScript==` 块派生，缺 matches 提示补全）。四条入口都落「未启用」，由用户审过源码再手动启用。
- **链接导入多一步**：远端内容在取回前不知道是什么，故它是两条动线 —— 先抓回并展示元数据摘要，用户确认后才落盘；其余三条内容已在手上，直接落盘 + 报告复述。
- 后台链路不经命令面，写完状态库**必须自己发** `broadcastDataChange`。

## 用户脚本版本管理

`isomorphic-git`（纯 JS），仓在 `duoling-fs`——每次保存/导入/回滚 = 一次提交（恢复走「产生新提交」而非 reset，历史不可变）；仓损坏只丢历史，源码在工作树里。注册/注入以状态库 `duoling-state` 的 `source.code` 为准，编辑器以 `duoling-fs` 工作树为基准。

版本记录带**改动来源**（`CommitActor = user | ai | system`）：来源存在提交的 author 上，**不拼进提交信息**——提交信息是给用户读的「改了什么」，来源是「谁改的」，分开存才不会互相污染（`userscript:save` 的 `actor` 字段，AI 的桥接层固定传 `ai`）。历史面板**每一版都标**（用户那档是灰字「你」，AI / 系统带图标 + 加深字）：只标非用户的会让那一栏空着，被读成「来源功能没生效」。

> 措辞上刻意避开「自动」：对用户来说 AI 也是自动的，靠「AI 修改 / 系统处理」区分才立得住。

> 这里指**用户脚本自身**的 git 历史，不是扩展版本号；扩展版本号机制见 [VERSIONING.md](VERSIONING.md)。

## 数据变更广播（跨页面同步）

IDB 没有变更通知，「别处改了数据、这个页面还是旧的」靠 `src/lib/data-broadcast.ts` 补：写侧落盘成功后 `broadcastDataChange(域, uuid?)` 发一条**只含域+uuid、不带数据**的通知（BroadcastChannel 同源多播，不唤醒休眠 SW；无 BC 降级 `runtime.sendMessage`），读侧组件用 `useDataSync(域, reload)` 订阅后自行回拉权威存储（同 `domain+uuid` 100ms 合并防风暴）。

- 广播埋在写出口：offscreen `handleStateCommand`（`script` 域）、`conversation-store` 写函数（`conversation`）、`userscripts/store.ts`（`error`）、`userscripts/usdata-db` 写出口经 store.ts（gm 变更事件）与 `model-store.ts` 写出口（`model`）。
- **新增写路径必须同步埋广播**；前端新面板按域接 `useDataSync`，不再靠手动刷新兜底。编辑器有未保存改动时不自动重载，只提示「已在别处修改，这次保存会覆盖那一次改动」；编辑器自己保存触发的广播会被忽略——否则刚保存就被当成「别处修改」挂上提示。
- **只适用于 IDB**。落在 `chrome.storage.local` 的设置在**模块内封一层订阅**即可 —— 原生 `chrome.storage.onChanged` 已跨上下文通知（扩展页 / popup / 内容脚本都收得到），不必自建通道：`dev-mode-store.ts` 的 `subscribeDevMode` 即此例。键名与 area 过滤都封在 store 里，调用方不写字面量。

## 构建信息注入（单一通道：`vite.define`）

`wxt.config.ts` 通过 `vite().define` 把裸标识符 `__BUILD_INFO__`（`{ time, branch, version, repo }`）替换成字面量，**编译进所有 JS bundle**（页面 / SW / offscreen 三处同源）。这是构建信息的唯一来源。

- `repo` 是 `owner/repo` 形式，**由构建期从 git remote 推导，不写死在源码里**：代码托管用户名属需脱敏的个人 ID，写死会随仓库分发出去；没有 origin 时降级 `unknown`，检查更新会自行跳过（用途见 `src/lib/update-check.ts`）。
- **HTML 内联注入 `window.__BUILD_INFO__` 已废弃**：MV3 `extension_pages` CSP 不含 `'unsafe-inline'` → 内联脚本不执行，生产环境该字段恒 `undefined`，构建信息整列消失。WXT 只在 dev 注入宽松 CSP，因此这条 bug **在 dev 下不复现**，必须用生产产物（`pnpm run build` + 加载 `.output/chrome-mv3`）验证。
- 页面侧取数写法（`typeof` 守卫必需——未应用该 define 的环境里裸标识符不存在，`typeof` 读不存在的标识符不抛错）：

  ```ts
  const info = typeof __BUILD_INFO__ !== 'undefined' ? __BUILD_INFO__ : undefined
  ```

- **SW 侧读不到自己的 bundle**（SW 不是 HTML / 不是同一执行上下文）：页面要 SW 的构建信息，经 `sw:buildInfo` 命令取回（IPC 契约 `src/shared/extension-ipc.ts`，SW 侧实现 `src/entrypoints/background.ts`）。取数要**重试**：WXT 重载扩展时页面跟着重载，挂载瞬间第一条请求常撞上「旧 SW 已死、新监听器未注册完」的窗口；三次都失败才算真失败（SW 是旧包或已挂），且要**显式展示「未响应」**，不得静默隐藏。
- 参考实现：取数统一封装在 `src/lib/build-info.ts`（页面侧 `readInjectedBuildInfo` / `readPageBuildStamp`，SW 侧 `fetchSwBuildStamp` 带 3 次重试）；展示在 **设置 → 关于** 分区（`src/components/settings/AboutSection.vue`，版本号 + 页面 + Service Worker 三行）。

### 版本号展示：不用 `manifest.version`

- `package.json` 写 `0.1.0-alpha.2` 时，产物 `manifest.version` = **`0.1.0`**（Chrome 该字段只允许 1–4 段数字），预发布标签被 WXT 裁掉；完整值另在 `manifest.version_name`（WXT 行为，非 Chrome 保证）。
- 所以版本号展示取 **`__BUILD_INFO__.version`**（构建期直接读 `package.json`，完整、不受裁剪影响）；`chrome.runtime.getManifest().version` 只作兜底。也不用 `window.__BUILD_INFO__`。

## 检查更新

扩展向 GitHub Releases 取最新版本，有新版本时在工具栏 popup 与设置页「关于」露头。链路收敛在 `src/lib/update-check.ts`，**不新增 IPC 命令**：结果写进 `duoling-app` 库，读侧（popup / 设置页）直连 IndexedDB 自己读。

- **时机**：SW 在 `chrome.runtime.onStartup`（开浏览器）与 `onInstalled`（安装 / 更新）各查一次，设置页另有手动入口。**不用 `alarms`** —— `onStartup` 只在浏览器启动时触发（SW 被挂起后唤醒不触发它），启动时若正好离线就错过本轮，由手动入口兜底。
- **取数走 `/releases` 列表，不用 `/releases/latest`**：后者只返回最新正式版、跳过 prerelease，而本项目版本线长期处于预发布（`0.2.0-alpha.N`），那时该端点直接 404。
- **版本比较自己实现**（`compareVersions`）：SemVer 下 `0.2.0-alpha.1 < 0.2.0`，字符串比较方向正好相反；项目没有 semver 依赖，也不为这一处引入。比的是 `__BUILD_INFO__.version`（含预发布标签），不是被裁成一到四段数字的 `manifest.version`。
- **止于提示**：Chrome 不允许扩展替换自身，非商店渠道的自动更新在 macOS / Windows 上还被平台限制（见 [VERSIONING.md](VERSIONING.md)），所以查到新版本只给去处（Release 页面），下载与替换由用户完成。
- **失败不打扰**：离线 / 限速 / 仓库不可达一律收敛成 `unavailable` 结果而不抛错 —— popup 只在真有新版本时才出现那一块，设置页则把原因显示出来供排查。

## 首帧加载态（内联静态 DOM）

入口 HTML 的 `modulepreload` 链就是首帧要执行的代码，其体积 ≈ 首开白屏时长。两条硬约束：

- **重依赖一律按需加载**：markdown 渲染链路（micromark/mdast + shiki + katex）约 600KB、AI SDK（`ai` 核心 + zod）约 360KB —— 打开对话框那一刻两者都用不上（历史消息走 IndexedDB 直读），静态引入会把首屏从约 530KB 抬到约 1420KB。落点：`MessageResponse.vue` 用 `defineAsyncComponent` + `<Suspense>` 拉 `vue-stream-markdown`（组件与 CSS 一起 await）；shiki 在 `code-block/utils.ts` 首次高亮时动态 import；`useChat` 收进 `use-global-conversation.ts` 的 `ensureChat()`。`ai` 的 part 判定 helper 另有本地实现，理由见 `src/lib/ui-message-parts.ts` 顶部注释。
- **首帧底色不能靠 JS，加载态必须是内联静态 DOM**：`body` 背景取 `--background`，而 `.dark` 由 `theme.ts` 在 JS 执行时才挂上（CSP 禁内联 `<script>`），故「CSS 已到、JS 未执行完」这一档 `body` 实测为纯白、深色系统下反差明显。做法是三个入口 HTML 的 `<head>` 内联 `.dl-boot` 加载层 + `<meta name="color-scheme">`：底色用 CSS 系统色 `Canvas` / `CanvasText`（不依赖 `prefers-color-scheme` —— Chrome 在部分环境下该媒体查询不可靠），转圈只能用纯 CSS 画，Vue mount 清空 `#app` 时自动消失。**三个入口的样式块刻意重复，改一处须同步其余两处**；逐条改造要点就地记在 `floatpanel.html` 的注释里。
- **dev 冷启动的白屏不属此列**：`pnpm run dev` 首次自动打开浏览器时白屏数秒 —— 那几秒里 HTML 文档本身尚未送达（Vite/WXT 现场编译 entrypoint + 预构建依赖），任何前端手段都渲染不出加载态。生产产物是静态文件、没有这段窗口，验真实首屏体感须用 `pnpm run build` 的产物；dev 同样不适合验 CSP。
