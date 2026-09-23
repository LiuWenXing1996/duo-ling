// match 产物的行为验证：@match 通配 / 子域 / @include 的 glob 与正则形态 / @exclude / @exclude-match。
//
// 规则来源由 `custom.orig*` 标记决定（VM 语义：用户改过匹配规则才用 custom 的那份，否则用 meta）。
// 这里 orig* 全开 = 一律取 meta，等价于「脚本导入后没被用户改过」的常态。
const { loadBundle, check, fatal, report } = require('./_harness.cjs')

loadBundle('match')
const api = globalThis.__gmRuntimeMatch
if (!api || typeof api.testScript !== 'function') fatal('产物没有挂载 __gmRuntimeMatch.testScript')
if (typeof api.parseMeta !== 'function') fatal('产物没有挂载 __gmRuntimeMatch.parseMeta')

/** 用 metadata 文本造一个 VM 的 script 对象 */
function mkScript(metaCode) {
  return {
    meta: api.parseMeta(metaCode),
    custom: {
      origMatch: true,
      origInclude: true,
      origExclude: true,
      origExcludeMatch: true,
    },
  }
}

const meta = (lines) => `// ==UserScript==\n// @name t\n${lines}\n// ==/UserScript==\n`

// —— @match ——
const m1 = mkScript(meta('// @match *://example.com/*'))
check('@match 通配路径命中', !!api.testScript('https://example.com/a', m1), true)
check('@match 同 pattern 异域', !!api.testScript('https://other.com/a', m1), false)
check('@match 不覆盖子域', !!api.testScript('https://sub.example.com/a', m1), false)

const m2 = mkScript(meta('// @match *://*.example.com/*'))
check('@match 子域通配命中子域', !!api.testScript('https://sub.example.com/x', m2), true)
check('@match 子域通配也覆盖裸域（与 Chrome 一致）', !!api.testScript('https://example.com/x', m2), true)

const m3 = mkScript(meta('// @match *://*/*'))
check('@match 全通配命中', !!api.testScript('https://anything.io/x', m3), true)

// —— @include：glob 与正则两种形态（正则形态是我们自研实现明确不支持的）——
// ⚠️ @include 的 glob 是**锚定整个 URL 串**的（不是「URL 里包含」）—— 这是 VM 的实现口径，
// 与 Tampermonkey 的「路径片段」语义不同。本验证以 VM 为准（要的就是与 VM 一致）。
const i1 = mkScript(meta('// @include /foo/*'))
check('@include 路径 glob 锚定整串（不命中完整 URL）', !!api.testScript('https://any.com/foo/bar', i1), false)
check('@include 路径 glob 命中同形态串', !!api.testScript('/foo/bar', i1), true)

const i2 = mkScript(meta('// @include https://ex.com/if*'))
check('@include URL glob 命中', !!api.testScript('https://ex.com/iframe', i2), true)

const i3 = mkScript(meta('// @include /^https:\\/\\/re\\.example\\//'))
check('@include 正则形态命中', !!api.testScript('https://re.example/x', i3), true)
check('@include 正则形态不命中', !!api.testScript('https://other.example/x', i3), false)

// —— @exclude / @exclude-match ——
const e1 = mkScript(meta('// @match *://*/*\n// @exclude *://ex.com/*'))
check('@exclude 命中则排除', !!api.testScript('https://ex.com/a', e1), false)
check('@exclude 未命中仍注入', !!api.testScript('https://want.com/a', e1), true)

const e2 = mkScript(meta('// @match *://*/*\n// @exclude-match *://ex2.com/*'))
check('@exclude-match 命中则排除', !!api.testScript('https://ex2.com/a', e2), false)
check('@exclude-match 未命中仍注入', !!api.testScript('https://want.com/a', e2), true)

// —— 边界 ——
const n0 = mkScript(meta('// @grant none'))
check('无任何匹配规则 → 通过（长度为零的短路语义）', !!api.testScript('https://x.com/', n0), true)

// ★ 注意 testScript 的返回值是「true 或 undefined」，不是严格布尔 —— VM 自身也用真值判断
// （见 background/utils/db.js 的 `if (!testScript(url, script))`）。故上面统一 !! 归一，
// 免得把 undefined 误判成「与预期不符」。
report()
