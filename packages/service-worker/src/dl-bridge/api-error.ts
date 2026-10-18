// 桥错误的统一载体：dispatch 及各支撑域模块（fetch / download / cookie / clipboard）抛出后，
// 由监听器统一写入响应信封的 code 字段。code 语义真相源是 @duoling/shared 的 ApiErrorCode。
import type { ApiErrorCode } from '@duoling/shared'

/** 带 ApiErrorCode 的错误：dispatch 抛出后由监听器写入响应信封的 code 字段 */
export class ApiError extends Error {
  code: ApiErrorCode
  constructor(code: ApiErrorCode, message: string) {
    super(message)
    this.code = code
  }
}
