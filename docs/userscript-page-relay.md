# 用户脚本 · 页面世界反向中继（`DL.page`）规范

> 状态：规范稿 v1（2026-09-15，待评审；实施排在 [userscript-v2-plan.md](./userscript-v2-plan.md) Phase 4）
> 输入：v2 方案 §Phase 4 设计输入 —— 结构化克隆限制 → 句柄方案；同步动态判断 / 对象同一性 /
> 逐帧高频不可行；stub 注册进 MAIN 世界走 `chrome.userScripts.register({ world: 'MAIN' })`，
> 按「有脚本声明了 page 访问」动态注册/注销；握手防伪。
> 本文档只定协议与语义，不含实现代码。契约位：`userscript-api.md` §2 已列 `DL.page.*`；
> 类型定义实施时补进 `src/lib/userscripts/api-contract.ts`（`DuoLingApi` 加 `page` 命名空间）。

## 1. 目标与威胁模型

**目标**：USER_SCRIPT 世界的脚本与页面 JS（MAIN 世界）是两个隔离的 JS realm，互相拿不到
对方对象。`DL.page` 提供一条受控通道，让脚本能**执行页面世界代码、引用页面对象、监听页面事件、
钩住页面全局函数**——这些在隔离世界里原生做不到（隔离世界的 `window.fetch` 是自己的副本，
钩了也不影响页面）。

**方向**：单向反透——脚本 → 页面。页面拿不到脚本世界的任何东西（这正是隔离世界的价值），
规范不提供也不考虑「页面调用脚本」的能力。

**威胁模型（全篇的边界）**：

| 主体 | 信任级 | 说明 |
|---|---|---|
| 脚本（USER_SCRIPT 世界） | 半可信 | 经身份校验与桥协议约束；闭包对页面不可见 |
| MAIN stub | 与页面同级 | **它就运行在页面自己的 JS realm 里**——页面能做的一切它都能被诱导做；它没有任何特权（无 `chrome.*`） |
| 页面脚本 | 不可信 | 可读 DOM、localStorage、监听全部 `postMessage`、读取 MAIN 世界一切全局量；**唯一读不到的是两个世界的闭包变量** |

由此推出两条公理，后续所有设计都以此为准绳：

1. **凡经过页面可见通道（postMessage / DOM / localStorage）传输的数据，视为页面已知**。
   防伪只能依赖「页面读不到的闭包密钥 + 挑战应答」，不能依赖传输保密。
2. **页面伪造 stub / 伪造脚本消息不能获得能力升级**——页面本来就能在自己的世界里做这些事。
   防伪的意义是**防冒充占位**（第三方抢答让脚本绑到假 stub）与**防会话串扰**（多脚本、多帧混淆），
   而不是对页面保密。

## 2. 总体架构

```
┌─ Background SW ─────────────────────────────────────────────┐
│ 计算「已启用且 config.pageAccess=true」脚本的 matches 并集    │
│ chrome.userScripts.register({ id:'dl-page-stub',            │
│   world:'MAIN', matches:并集, runAt:'document_start',       │
│   allFrames:true, js:[stub 源] })                            │
│ 注册时生成会话密钥 stubSecret，同时编入 stub 源与脚本包装源   │
└──────────────┬──────────────────────────────────────────────┘
               │（注册制注入，不经页面 DOM）
┌─ 页面每个 frame ──┴─────────────────────────────────────────┐
│ MAIN 世界：        USER_SCRIPT 世界（每脚本）：               │
│  [dl-page-stub]    [DL 包装 + bundle]                        │
│   RPC server        DL.page 客户端                           │
│        ▲                │                                    │
│        └── window.postMessage（同帧双向，信封见 §6）─────────┘
```

- **通道**：同帧 `window.postMessage`。不选 CustomEvent（detail 同样克隆但语义绕）、
  不选 DOM 属性（expando 跨世界不共享）。双向均校验 `event.source === window`（只应答本帧）。
- **stub 不含任何扩展 API**：MAIN 世界的 userScript 没有 `chrome.*`，通信只靠 window 通道；
  这也意味着 stub 被页面完全攻破的收益为零（没有可偷的特权）。
- **stub 是共享基础设施**：一个扩展一份注册，不是每脚本一份。多脚本会话靠 `sid` 隔离（§5.4）。

## 3. 能力天花板（规范层面直接排除，不接受「想办法实现」）

这些是隔离世界 + postMessage 通道的物理上限，写进规范是为了让脚本作者与实现者都不再幻想：

| 不可行项 | 原因 | 规范态度 |
|---|---|---|
| 同步动态判断 | 跨世界只有异步消息通道，无同步等待原语 | `DL.page` 全 async；不支持任何同步取值形式 |
| 对象同一性 | 每次跨世界引用都产生**新句柄 id**；结构化克隆的值更是各自副本 | 不承诺 `===` / 引用相等；需要同一性判断时用 `DL.page.eval` 在页面内比较、回传布尔 |
| 逐帧高频（rAF 级读写、mousemove 类） | 每次往返一个消息循环开销（毫秒级），60fps 逐帧调用不可行 | 不提供逐帧 API；这类需求**整段下沉**：`DL.page.eval` 一段自包含循环在页面里跑，只回传低频结果 |
| 传函数 / DOM 节点 / 类实例过桥 | 结构化克隆不支持 | 一律句柄化（§4）或序列化为源码（§6.1） |
| 跨帧直接访问 | 每帧 stub 只应答本帧 | 句柄绑定发起帧；跨帧需求后置（未决项 §11） |

## 4. 句柄方案

跨世界值的唯一表示法：

- **可克隆值**（`Json` 范畴）→ 原样过桥，脚本直接拿到裸值。
- **不可克隆值**（DOM 节点、函数、Window、Document、类实例等）→ stub 端登记进句柄表，
  回传 `{ __dlHandle: true, hid, type }`；脚本侧得到一个 `PageHandle` 引用对象。

### 4.1 脚本侧 API 形态

```
DL.page.eval(source, args?)          在 MAIN 世界执行一段代码（§6.1）
DL.page.listen(type, opts?)          订阅页面事件（§7）
DL.page.hook(name, handler)          钩住页面全局函数（§8）

handle.get(prop)                     读属性 → Promise<值 | PageHandle>
handle.call(prop, args?)             调方法/取函数再调用 → Promise<值 | PageHandle>
handle.free()                        释放句柄（stub 端出表）
```

- **一期只做显式 `get/call/free`**，不做 Proxy 语法糖（`await el.textContent` 这种）——
  Proxy get 拦截无法区分「取属性」与「取出来调用」，要么引入 thenable+callable 混合体这种魔法，
  要么语义含糊。糖后置（未决项）。
- 嵌套引用：`handle.get('firstChild')` 返回新句柄，链条合法；句柄即引用，无深度限制。
- **句柄绑定会话与帧**：句柄只属于发起它的 `sid`（§5.4）与所在 frame；别的脚本会话、别的帧
  拿到 `hid` 也无法操作（stub 校验拒绝）。`hid` 是名字不是能力。

### 4.2 句柄生命周期

- **登记**：stub 端 `Map<hid, { value }>`，hid 为递增 id + 会话前缀。
- **释放**：① 脚本显式 `free()`（规范要求用完即释放，脚本侧包装在 Promise reject 路径上也应
  释放已产生的句柄）；② 文档卸载自然清空（stub 随之重置）。
- **无 GC 联动**：脚本侧引用被回收时 stub 感知不到——这是 postMessage 通道的固有缺陷，
  不做 WeakRef/FinalizationRegistry 补偿（跨世界不可达）。泄漏上限 = 一次文档会话。
- **悬空**：对已释放 / 已随导航失效的 hid 操作 → `HANDLE_RELEASED` 错误，不静默重取。

## 5. stub 的动态注册 / 注销与握手防伪

### 5.1 声明位

`ScriptConfig` 增加布尔字段 **`pageAccess`**（默认 `false`，配置表单加开关「页面世界访问」）。
只有声明了的脚本：① 其 matches 计入 stub 注册并集；② 其 DL 包装挂载可用的 `DL.page`。
未声明却调用 → `PERMISSION_DENIED`，报错文案指路配置开关（不做静默 stub）。

### 5.2 注册 / 注销算法（SW 侧）

- **数据源**：全部 `enabled && config.pageAccess` 的 ScriptProject 的 config 四字段
  （matches / excludeMatches / includeGlobs / excludeGlobs）。
- **时机**：script:create / update / delete / 启停、扩展 install/update 恢复完成后重算。
- **动作**：
  - 并集为空 → 若 stub 已注册则注销（`userScripts.unregister({ ids: ['dl-page-stub'] })`）。
  - 并集非空 → `register`（不存在时）或先 unregister 再 register（matches 变化时）——
    幂等可重入，与既有 `registerChain` 的串行化共用队列，避免并发注册踩踏。
- **stub 参数**：`world: 'MAIN'`、`runAt: 'document_start'`（必须早于脚本默认的
  document_end 握手窗口）、`allFrames: true`、`persistAcrossSessions: true`。
- **密钥生成**：每次（重）注册时 SW 生成随机 `stubSecret`，同时编入 stub 源与
  **全部 pageAccess 脚本**的包装源（`buildDlWrapper` 注入）。重注册即轮换密钥。

### 5.3 握手协议（挑战应答）

脚本包装在**首次调用任何 `DL.page.*`** 时惰性握手，每次文档加载一次：

```
脚本 → stub : { __dlPage:1, kind:'hello', sid, challenge }        challenge = 随机串
stub → 脚本 : { __dlPage:1, kind:'hello_ack', sid,
                proof = digest(stubSecret, challenge),
                v }                                               v = 协议版本
脚本校验 proof 与 v；通过则会话建立，此后每条消息携带 sid。
超时（1s）或 proof 不符 → DL.page 全线 reject PAGE_STUB_UNAVAILABLE / HANDSHAKE_FAILED。
```

- **防伪原理**：`stubSecret` 只存在于 stub 与包装的**闭包**里，从不出现在全局量、DOM、
  消息明文中（页面读不到闭包，这是威胁模型里唯一守得住的东西）。页面即便录下全部流量，
  也算不出下一次的 proof。
- **digest**：世界内置同步小哈希（FNV-1a 变体级别即可），不依赖 `crypto.subtle`
  ——HTTP 页面无 secure context，不能把握手建立在它上面。**定位是认证级，不是密码学级**；
  威胁是「页面脚本顺手冒充」，不是「页面主动机密计算」。
- **防重放**：`sid` 每次文档加载由脚本重新生成，stub 只应答含已知 sid 的消息；
  旧会话消息天然失效。
- **诚实声明（写进文档给脚本作者看）**：握手证明「应答方持有本次注册注入的密钥」，
  即「对面是本扩展注册的 stub、不是别人抢注的假 stub」；它**不能**阻止页面读取 stub 的
  一切行为、篡改 stub 的返回值（stub 本就活在页面的 realm 里）。凡脚本经 `DL.page` 送入
  页面世界的参数，视为已向页面公开。

### 5.4 多脚本 / 多帧隔离

- 每个脚本 × 每个 frame = 一个独立会话（各自 `sid`）。stub 端维护 `sid → 会话状态`
  （含该会话的句柄表），跨 sid 的句柄操作与消息一律拒答。
- 页面可见 `sid` 明文（传输公理），故 sid 隔离防的是**无意串扰**（A 脚本的句柄误被 B 用），
  不防页面蓄意冒充——同 §5.3 边界，页面冒充脚本会话无能力升级。

## 6. RPC 协议

### 6.1 `DL.page.eval(source, args?)`

- `source`：**字符串形式的 JS 源码**（脚本侧通常写 `fn.toString()` 传入函数），
  stub 端 `new Function(...args)` 执行；`args` 仅限 `Json`。
- 返回值按 §4 规则：可克隆 → 裸值；不可克隆 → 句柄；页内抛错 → `PAGE_EVAL_ERROR`
  （携带 error.message，不带页内 stack——那是页面的东西，长度也不可控）。
- **CSP 验证点**：userScripts 走浏览器注入通道，预期不受页面 CSP 约束（含 MAIN 世界），
  `new Function` 可用。实施时在严格 CSP 站点实测；若发现例外，回退方案 = stub 内置
  常用操作函数表（querySelector / getAttribute / callMethod…），`eval` 降级为受限 API。

### 6.2 消息信封

```
{ __dlPage: 1, kind, sid, seq?, ... }
  kind ∈ hello | hello_ack | call | reply | event | error
  call : { op: 'eval'|'get'|'call'|'free'|'listen'|'unlisten'|'hook', ... }
  reply: { seq, ok, value? | { handle? } | error: { code, message } }
```

- `seq` 由脚本侧分配，reply 原样带回；脚本侧超时（默认 5s，`eval` 可传 `timeout` 覆盖）
  reject `TIMEOUT`，超时的 reply 到达后丢弃（按 seq 匹配）。
- 错误码自有小组（不走 SW 桥的 `ApiErrorCode`）：`PAGE_STUB_UNAVAILABLE` / `HANDSHAKE_FAILED` /
  `PAGE_EVAL_ERROR` / `CLONE_UNSUPPORTED`（返回值既不可克隆也不可句柄化）/ `HANDLE_RELEASED` /
  `TIMEOUT` / `PERMISSION_DENIED`（未声明 pageAccess）。
- 所有错误 **reject Error、不静默**——沿用能力 API 的总则（userscript-api.md §4）。

## 7. 事件转发

- `DL.page.listen(type, { selector?, once? })`：stub 在本帧 `window`（或 selector 命中的
  元素）上 `addEventListener`，把事件**可克隆摘要**转发脚本：
  `{ type, key?, detail(尝试克隆，失败置 null), timeStamp }`。
- 返回 `off()` 注销函数（发 `unlisten`）。
- **回调是异步分发**：事件到达 ≠ 实时；高频事件（mouse-move / 滚动 / rAF 驱动）不承诺
  每帧送达，节流与合批是脚本自己的责任。规范明确不支持对同一事件类型的逐帧保证。

## 8. 预置 hook

一期只内置一个：**`DL.page.hook('fetch', handler)`**（页面 `window.fetch` 钩子）——
这是脚本最经典的 MAIN 世界需求，隔离世界里钩自己的 fetch 副本毫无意义。

- 语义：stub 用包装函数替换 `window.fetch`；页面每次调用 → 摘要
  `{ url, method, headers(可克隆部分), body(文本化尝试) }` → 转发脚本 →
  脚本回 `{ action: 'passthrough' }`（透传原调用）或 `{ action: 'respond', status, headers, body }`
  （stub 构造 Response 返回页面）。
- **超时放行**：脚本未在时限（默认 500ms）内答复 → 自动 passthrough。钩子卡顿等于卡页面
  网络层，宁可失效不可阻塞——这是 hook 的最高优先级约束。
- 返回 `off()`：恢复原 `fetch` 引用（恢复的是替换前捕获的原函数，页面后来自己又改过则不背锅）。
- XHR / WebSocket / 其他全局钩子：**后置**，实施时按需逐个立项（每个都有自己的参数克隆
  与超时语义，不做泛化 hook 框架）。

## 9. 契约与配置落点（实施时的改动清单，本文不写代码）

| 位置 | 改动 |
|---|---|
| `src/lib/userscripts/api-contract.ts` | `DuoLingApi` 加 `page` 命名空间类型；新增 `PageHandle` / 信封 / 错误码类型 |
| `types.ts` `ScriptConfig` | 加 `pageAccess: boolean`（默认 false） |
| `engine.ts` `buildDlWrapper` | 按 `pageAccess` 决定是否挂载 `DL.page` 客户端与 `stubSecret` |
| SW 注册逻辑 | §5.2 的并集维护算法，挂在既有 `registerChain` 串行队列上 |
| 新文件（建议）`page-stub.ts` / `page-client.ts` | stub 源（字符串模板，随注册注入）与脚本侧客户端 |
| 编辑器配置表单 | 「页面世界访问」开关 + 说明文案（指向本规范 §1 / §3） |

## 10. 明确不做

- **任何同步形态**的页面访问（含「看起来同步」的取值糖）
- **对象同一性**承诺、跨世界 `===` 语义
- **逐帧高频通道**（rAF 循环、mousemove 逐事件转发）
- 页面 → 脚本方向的调用能力（反向中继只中继到页面，不开放反向入口）
- 泛化 hook 框架（只逐个立项：一期 fetch）
- 跨帧句柄 / 跨帧事件聚合
- stub 内持久业务逻辑（stub 只做协议机器，页面特定逻辑一律由脚本经 eval 下发）

## 11. 未决项

- [ ] MAIN 世界 userScript 对页面 CSP 的豁免范围实测（严格 CSP 站点 `new Function`）→ 决定 §6.1 回退方案是否需要
- [ ] Proxy 语法糖（`await handle.prop`）的形态——若做，取值/调用歧义怎么解
- [ ] hook `fetch` 的 `respond` 是否需要支持流式 / `FetchPayload` 形状复用
- [ ] 跨帧需求（iframe 内页面元素的统一句柄空间）是否立项
- [ ] `stubSecret` 轮换粒度：目前 per 注册（全部 pageAccess 脚本共享），是否需要 per 脚本
      （需拆成多个 MAIN 注册，成本是 stub 副本数增加——倾向不做，维持共享）
