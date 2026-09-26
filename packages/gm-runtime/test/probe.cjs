// probe 产物的行为验证：证明「以 VM 构建链产出的 bundle 能被外部加载并调用」。
const { loadBundle, check, fatal, report } = require('./_harness.cjs')

loadBundle('probe')
const api = globalThis.__gmRuntimeProbe
if (!api || typeof api.getScriptRunAt !== 'function') fatal('产物没有挂载 __gmRuntimeProbe.getScriptRunAt')

// 用例照 VM 的语义：`custom.runAt || meta.runAt` 里取 `document-<x>` 的 <x>，认不出或缺省 → 'end'
const cases = [
  ['缺省 → end', { custom: {}, meta: {} }, 'end'],
  ['@run-at document-start', { custom: {}, meta: { runAt: 'document-start' } }, 'start'],
  ['@run-at document-body', { custom: {}, meta: { runAt: 'document-body' } }, 'body'],
  ['user 覆盖优先（custom.idle + meta.start）', { custom: { runAt: 'document-idle' }, meta: { runAt: 'document-start' } }, 'idle'],
  ['认不出的取值 → end', { custom: {}, meta: { runAt: 'document-whenever' } }, 'end'],
  ['非 document- 前缀 → end', { custom: {}, meta: { runAt: 'start' } }, 'end'],
]

for (const [name, script, want] of cases) check(name, api.getScriptRunAt(script), want)
report()
