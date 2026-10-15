// 宿主层通用小工具（自 src/lib/format.ts 收编 errorText：包内多处 catch 要拼错误文案）。

/**
 * 抛出物 → 可读文案。
 *
 * 收到一处的意义不是省字，是一致性：漏掉 `String(e)` 兜底的那种写法，遇到非 Error 抛出物
 * 会显示成 "[object Object]"。需要中文前缀的调用点自行拼接（如 `'保存失败：' + errorText(e)`）
 * —— 本函数不掺文案。
 */
export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
