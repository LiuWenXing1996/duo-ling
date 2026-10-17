/**
 * 抛出物 → 可读文案。应用侧（package 外）与包侧写出口共用同一处实现。
 *
 * 收到一处的意义不是省字，是一致性：漏掉 `String(e)` 兜底的那种写法，遇到非 Error
 * 抛出物会显示成 "[object Object]"。需要中文前缀的调用点自行拼接
 * （如 `'保存失败：' + errorText(e)`）—— 本函数不掺文案。
 */
export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
