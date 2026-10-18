// GM 全能探针 · 入口：按**原探针的结果行顺序**注册各组用例，再启动。
//
// 顺序即结果行顺序（端测断言按总数与汇总行），**不得重排**；分组名与顺序的对应关系：
//   基础 → 存储 → 网络（往返） → 系统能力 → 站点与页面（第一批） → 网络·深语义 →
//   网络（请求体） → 下载 → cookie 域名门 → 路由与通知点击 → 资源与依赖
import { boot } from './harness'
import { register as registerBasic } from './cases/basic'
import { register as registerStorage } from './cases/storage'
import { register as registerNetBasic } from './cases/net-basic'
import { register as registerSystem } from './cases/system'
import { register as registerSite } from './cases/site'
import { register as registerNetDeep } from './cases/net-deep'
import { register as registerNetBody } from './cases/net-body'
import { register as registerDownload } from './cases/download'
import { register as registerCookieGate } from './cases/cookie-gate'
import { register as registerRouting } from './cases/routing'
import { register as registerResources } from './cases/resources'

registerBasic()
registerStorage()
registerNetBasic()
registerSystem()
registerSite()
registerNetDeep()
registerNetBody()
registerDownload()
registerCookieGate()
registerRouting()
registerResources()

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot)
} else {
  boot()
}
