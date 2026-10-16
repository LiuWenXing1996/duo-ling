// 契约与 key 同处：接口不引任何子包，实现在子包（依赖单向）。
import {
  createProxyService,
  registerService,
  type ProxyService,
  type ProxyServiceKey,
} from '@webext-core/proxy-service'
import type { PromiseService } from './types'

/** SW 侧服务契约：调用面由它钉死 */
export interface ISWService extends PromiseService<{
  /** 保活探针：调用到达 SW 即重置其空闲计时；返回值仅供判断链路是否通 */
  isAlive(): Promise<boolean>
}> {}

const SW_SERVICE_KEY = 'sw-service' as ProxyServiceKey<ISWService>

/** SW 侧：宿主入口顶层同步调，迟了会漏掉早到的调用 */
export function registerSWService(service: ISWService): void {
  registerService(SW_SERVICE_KEY, service)
}

/** 消费侧：取代理，调用转发到 SW 里注册的实现；跨上下文，返回一律 Promise */
export function createSWService(): ProxyService<ISWService> {
  return createProxyService(SW_SERVICE_KEY)
}
