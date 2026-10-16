// key 只在本包内出现：两端各取一个入口，不各自持字符串。
import type { SWService } from '@duoling/service-worker'
import { createProxyService, registerService, type ProxyServiceKey } from '@webext-core/proxy-service'

const SW_SERVICE_KEY = 'sw-service' as ProxyServiceKey<SWService>

/** SW 侧：宿主入口顶层同步调，迟了会漏掉早到的调用 */
export function registerSWService(service: SWService): void {
  registerService(SW_SERVICE_KEY, service)
}

/** 消费侧：取代理，调用转发到 SW 里注册的实现 */
export function createSWService() {
  return createProxyService(SW_SERVICE_KEY)
}
