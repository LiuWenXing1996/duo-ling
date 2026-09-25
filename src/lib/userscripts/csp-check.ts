// 脚本 CSP 预警（VM 运行时版）。
//
// 自研引擎时代：脚本注入浏览器默认严 CSP 世界（禁止 eval / new Function），源码出现动态执行即预警。
// 切换到 VM 后，脚本跑在 VM 的独立世界（worldId:'vm'），其 CSP 含 'unsafe-eval'
// （见 vm-runtime-host.ts 的 VM_CSP），动态执行不被拦 —— 故此处不再预警。
//
// 保留函数签名以便调用点最小改动；若后续要在 VM 上做其它源码级校验，从这里扩展。

export function collectCspWarnings(_code: string): string[] {
  return []
}
