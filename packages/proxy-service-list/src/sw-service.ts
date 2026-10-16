// key 契约：两端共用同一字符串，只 import type 借形状。
import type { SWService } from '@duoling/service-worker'
import type { ProxyServiceKey } from '@webext-core/proxy-service'

export const SW_SERVICE_KEY = 'sw-service' as ProxyServiceKey<SWService>
