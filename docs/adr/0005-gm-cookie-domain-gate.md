# 0005. GM_cookie 域名门：门在 SW、能力边界对齐注入面

日期: 2026-10-18
状态: 已接受
代码落点: packages/service-worker/src/cookie-gate.ts（文件头指针指回本文件）

## 背景

GM_cookie 是全扩展权限最大的 API（读改任意 cookie），必须有一条安全边界，且执行点必须可信。

## 决策

- 门在 **SW 侧、唯一执行点**。包装层跑在页面里、是脚本改写得到的运行环境，身份与参数都不可信——包装层只负责填 url 缺省，安全判断全在门上，包装层传什么 url 都要过这道门。
- 规则：
  - url 必须落在**该脚本自身**的 matches 内、不命中 excludeMatches——**不与其它脚本取并集**，脚本能碰的 cookie ⊆ 它能注入的页面能碰的 cookie，能力边界与注入面严格对齐；
  - 匹配只比 scheme + host（忽略 pattern 的 path 段，理由见 match-pattern.ts 文件头）；
  - matches 为空 / 项目不存在 → 一律拒绝；
  - `domain` / `path` 不参与门判定（`set` 照 TM 收下这两个字段）：门永远按 url 算，「domain 必须与 url 同域或其父域」由 chrome.cookies.set 自己保证（真越域会被浏览器拒）。
- config 读取带缓存（cookie 调用可能成串），失效走数据变更广播的 `script` 域。**缓存失效漏了就是安全 bug**（改了 matches 但门还用旧配置），故：
  - 只缓存配置，不缓存判定结果；
  - 收到任何 script 域变更就整表清空（脚本数量级很小，不做精细失效，避免漏清）；
  - 单测专门覆盖「配置改了 + 广播后门即时生效」（cookie-gate.test.ts）。

## 备选与否决

- **门放包装层**：运行环境不可信，等于没有门。
- **按 domain 参与判定**：脚本可用 domain 把判定挪到别的域上，打破与注入面的对齐。
- **精细缓存失效**：清漏一处就是安全 bug，整表清空的代价可以忽略。
