// 取代理：调用转发到 SW 里注册的实现；形状由 key 的品牌类型推出。
import { createProxyService } from '@webext-core/proxy-service'
import { SW_SERVICE_KEY } from '@duoling/proxy-service-list'

export function useSWService() {
  return createProxyService(SW_SERVICE_KEY)
}
