# 用户脚本 · 页面世界反向中继（`DL.page`）规范

> 状态：v2.1（2026-09-17 修订；Phase 4 已实施）
> 修订记录：
> - v1（2026-09-15）：首发，API 面 = eval / listen / hook + 句柄体系。
> - v2（2026-09-17）：**eval 与句柄体系整体后置**，一期 API 面收敛为 `listen` + `hook('fetch')`。
>   理由：句柄的唯一数据来源是 eval，eval 后置则句柄无来源，二者必须同进退；eval 是唯一依赖
>   `new Function` 的能力，后置后 v1 最大的未决项（严格 CSP 站点实测）不复存在，stub 成为纯
>   固定逻辑机器，风险面大幅缩小。一期先用 listen / hook 验证通道价值，不够用再立项 eval。
> - v2.1（2026-09-17，实施时修订）：**去掉 pageAccess 门禁**——`DL.page` 对全部脚本开放，
>   stub 注册并集 = 全部启用脚本的 matches；`ScriptConfig` 不再加字段，编辑器不加开关。
> 输入：v2 方案 §Phase 4 设计输入；同步动态判断 / 对象同一性 / 逐帧高频不可行；
> stub 注册进 MAIN 世界走 `chrome.userScripts.register({ world: 'MAIN' })`，
> 按「存在启用脚本」动态注册/注销；握手防伪。
> 本文档只定协议与语义，不含实现代码。契约位：`userscript-api.md` §2 已列 `DL.page.*`；
> 类型定义实施时补进 `src/lib/userscripts/api-contract.ts`（`DuoLingApi` 加 `page` 命名空间）。

## 1. 目标与威胁模型

**目标**：USER_SCRIPT 世界的脚本与页面 JS（MAIN 世界）是两个隔离的 JS realm，互相拿不到
对方对象。`DL.page` 提供一条受控通道，让脚本能**监听页面事件、钩住页面全局函数**——这些在
隔离世界里原生做不到（隔离世界的 `window.fetch` 是自己的副本，钩了也不影响页面；
`addEventListener` 挂的也是自己世界的事件通路）。

**方向**：单向反透——脚本 → 页面。页面拿不到脚本世界的任何东西（这正是隔离世界的价值），
规范不提供也不考虑「页面调用脚本」的能力。

**一期不提供「执行页面世界代码 / 引用页面对象」**（eval 与句柄体系，后置，见 §4）——
一期只验证事件转发与 fetch 钩子两条链路。

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
 计算「已启用」脚本的 matches 并集                              │
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
- **stub 是纯固定逻辑机器**：一期不含 `new Function`、不拼源码，只做事件监听转发与
  fetch 包装两个固定职责（§7 / §8），不存在页面特定业务逻辑。

## 3. 能力天花板（规范层面直接排除，不接受「想办法实现」）

这些是隔离世界 + postMessage 通道的物理上限，写进规范是为了让脚本作者与实现者都不再幻想：

| 不可行项 | 原因 | 规范态度 |
|---|---|---|
| 同步动态判断 | 跨世界只有异步消息通道，无同步等待原语 | `DL.page` 全 async；不支持任何同步取值形式 |
| 对象同一性 | 跨世界无法共享对象引用 | 不承诺 `===` / 引用相等；一期没有跨世界对象表示法（句柄随 eval 后置） |
| 逐帧高频（rAF 级读写、mousemove 类） | 每次往返一个消息循环开销（毫秒级），60fps 逐帧调用不可行 | 不提供逐帧 API；`listen` 不承诺逐帧送达（§7） |
| 传函数 / DOM 节点 / 类实例过桥 | 结构化克隆不支持 | 一期不跨越：listen 只转发**可克隆摘要**，hook 只转发文本化尝试（§7 / §8） |
| 跨帧直接访问 | 每帧 stub 只应答本帧 | 句柄/事件绑定发起帧；跨帧需求后置（未决项 §11） |

## 4. 一期能力面与后置能力

### 4.1 一期 API（全部）

```
DL.page.listen(type, handler, opts?)  订阅页面事件（§7），handler 收事件摘要，返回 off()
DL.page.hook(name, handler)          钩住页面全局函数，一期仅 'fetch'（§8），返回 off()
```

就这两个。回调全 async，错误一律 reject 不静默（§6.2 错误码组）。

### 4.2 后置：eval 与句柄体系（整体后置，非砍掉）

v1 设计过的 `DL.page.eval(source, args?)`（在 MAIN 世界执行一段源码）与句柄方案
（不可克隆值登记进 stub 句柄表、回传 `{ __dlHandle, hid }` 引用，脚本侧 `get/call/free`）
**整体后置**，本版规范不展开其协议细节。

- **为什么一起后置**：句柄的唯一产生途径是 eval 的返回值登记，eval 不做则句柄无来源，
  单独保留句柄协议是死代码。
- **为什么不砍掉**：listen / hook 覆盖不了「读页面 JS 全局、执行页面逻辑」的需求，
  这是反向中继的终极形态；一期用下来确认通道有价值，再单独立项补 eval。
- **后置时必须一并做的事**：v1 的 CSP 实测项（严格 CSP 站点 MAIN 世界 `new Function`
  是否可用）随 eval 立项重新生效；不可用的回退预案 = stub 内置受限操作函数表
  （querySelector / getAttribute / callMethod…）。

## 5. stub 的动态注册 / 注销与握手防伪

### 5.1 开放范围

`DL.page` 对**全部脚本**开放（无配置门禁）：任何启用脚本的 matches 计入 stub 注册并集，
其 DL 包装都挂载可用的 `DL.page`。

### 5.2 注册 / 注销算法（SW 侧）

- **数据源**：全部 `enabled` 的 ScriptProject 的 config 四字段
  （matches / excludeMatches / includeGlobs / excludeGlobs）。
- **时机**：script:create / update / delete / 启停、扩展 install/update 恢复完成后重算。
- **动作**：
  - 并集为空 → 若 stub 已注册则注销（`userScripts.unregister({ ids: ['dl-page-stub'] })`）。
  - 并集非空 → `register`（不存在时）或先 unregister 再 register（matches 变化时）——
    幂等可重入，与既有 `registerChain` 的串行化共用队列，避免并发注册踩踏。
- **stub 参数**：`world: 'MAIN'`、`runAt: 'document_start'`（必须早于脚本默认的
  document_end 握手窗口）、`allFrames: true`（userScripts API 无 `persistAcrossSessions`
  字段，注册本身即跨会话持久——传了会被 Chrome 拒收）。
- **密钥生成与持久化（实施修订 2026-09-17）**：`stubSecret` 由 SW 生成后持久化于
  chrome.storage.local（键 `us:page:secret`）——MV3 SW 随时休眠，模块变量会归零，单脚本注册
  路径（create / updateFiles / toggle）必须能独立取到与在位桩一致的密钥。轮换时机收敛为
  **扩展 install/update 恢复时**（`recoverOnUpdate`）：轮换后 `registerAllEnabled` 把桩与全部
  启用脚本包装在同一遍里带上新密钥。日常注册期不轮换，避免桩与包装密钥错代。

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
  一切行为、篡改 stub 的返回值（stub 本就活在页面的 realm 里）。凡脚本经 `DL.page`
  交给页面的数据，视为已向页面公开。

### 5.4 多脚本 / 多帧隔离

- 每个脚本 × 每个 frame = 一个独立会话（各自 `sid`）。stub 端维护 `sid → 会话状态`
  （含该会话的监听注册与 hook 状态），跨 sid 的消息一律拒答。
- 页面可见 `sid` 明文（传输公理），故 sid 隔离防的是**无意串扰**（A 脚本的事件被 B 收到），
  不防页面蓄意冒充——同 §5.3 边界，页面冒充脚本会话无能力升级。

## 6. RPC 协议

### 6.1 一期操作集

stub 只应答四类业务操作：`listen` / `unlisten` / `hook` / `unhook`（+ 握手 `hello` / `hello_ack`）。
无 eval、无句柄操作——一期 stub 不执行任何脚本下发的源码。

### 6.2 消息信封

```
{ __dlPage: 1, kind, sid, seq?, ... }
  kind ∈ hello | hello_ack | call | reply | event | hookcall | hookreply
  call : { op: 'listen'|'unlisten'|'hook'|'unhook', ... }
  reply: { seq, ok, value? | error: { code, message } }
```

- `seq` 由脚本侧分配，reply 原样带回；脚本侧超时（默认 5s）reject `TIMEOUT`，
  超时的 reply 到达后丢弃（按 seq 匹配）。
- `event`（stub → 脚本，事件摘要）与 `hookcall` / `hookreply`（fetch 钩子的双向调用，
  见 §8）不占 seq 配对，各自携带会话内自增序号。
- 错误码自有小组（不走 SW 桥的 `ApiErrorCode`）：`PAGE_STUB_UNAVAILABLE` / `HANDSHAKE_FAILED` /
  `TIMEOUT` / `PERMISSION_DENIED`（hook 参数非法）。
- 所有错误 **reject Error、不静默**——沿用能力 API 的总则（userscript-api.md §4）。

## 7. 事件转发

- `DL.page.listen(type, { selector?, once? })`：stub 在本帧 `window`（或 selector 命中的
  元素）上 `addEventListener`，把事件**可克隆摘要**转发脚本：
  `{ type, key?, detail(尝试克隆，失败置 null), timeStamp }`。
- 返回 `off()` 注销函数（发 `unlisten`）。
- **回调是异步分发**：事件到达 ≠ 实时；高频事件（mouse-move / 滚动 / rAF 驱动）不承诺
  每帧送达，节流与合批是脚本自己的责任。规范明确不支持对同一事件类型的逐帧保证。
- 一期脚本触及页面元素的唯一方式是 listen 的 `selector`——没有句柄浏览能力，
  stub 不为脚本做任意 DOM 查询。

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
| `src/lib/userscripts/api-contract.ts` | `DuoLingApi` 加 `page` 命名空间类型（`listen` / `hook` / `off` / 事件摘要 / fetch 摘要）；信封与错误码类型 |
| `engine.ts` `buildDlWrapper` | 内联 `DL.page` 客户端与 `stubSecret` |
| SW 注册逻辑 | §5.2 的并集维护算法，挂在既有 `registerChain` 串行队列上 |
| 新文件（建议）`page-stub.ts` / `page-client.ts` | stub 源（字符串模板，随注册注入）与脚本侧客户端 |

## 10. 明确不做

- **eval 与句柄体系**（一期不实现，后置非砍掉，见 §4.2；降级函数表也只在 eval 立项时才讨论）
- **任何同步形态**的页面访问（含「看起来同步」的取值糖）
- **对象同一性**承诺、跨世界 `===` 语义
- **逐帧高频通道**（rAF 循环、mousemove 逐事件转发）
- stub 为脚本做任意 DOM 查询（一期脚本触及元素的唯一入口是 listen 的 selector）
- 页面 → 脚本方向的调用能力（反向中继只中继到页面，不开放反向入口）
- 泛化 hook 框架（只逐个立项：一期 fetch）
- 跨帧句柄 / 跨帧事件聚合
- stub 内持久业务逻辑（stub 只做协议机器，页面特定逻辑一律等 eval 立项后经 eval 下发）

## 11. 未决项

- [ ] `hook('fetch')` 的 `respond` 是否需要支持流式 / `FetchPayload` 形状复用
- [ ] 跨帧需求（iframe 内页面事件 / fetch 钩子的统一聚合）是否立项
- [ ] `stubSecret` 轮换粒度：目前 per 注册（全部启用脚本共享），是否需要 per 脚本
      （需拆成多个 MAIN 注册，成本是 stub 副本数增加——倾向不做，维持共享）
- [ ] `listen` 的 selector 摘要（`key` 字段的取法）具体形状，实施时定
- [ ] eval 立项的触发条件（一期 listen / hook 覆盖不了哪些真实需求时启动）——待一期用后复盘
