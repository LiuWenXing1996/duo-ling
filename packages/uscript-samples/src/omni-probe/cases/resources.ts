// 资源与外部依赖组：@resource 取内容、@require 的前置注入。
import { add, fail, pass, unknown } from '../harness'

export function register() {
  add('资源与依赖', '@resource 已知名取到内容（文本 + data URI）', function () {
    const text = GM_getResourceText('probeIcon')
    const url = GM_getResourceURL('probeIcon')
    const okText = typeof text === 'string' && text.length > 0
    const okUrl = typeof url === 'string' && url.length > 0
    if (!okText && !okUrl) {
      // @resource 的地址写在元数据里、只能是固定值，故它指向靶站默认端口；靶站没跑在默认端口上就取不到
      return unknown('两项都没取到 —— 检查靶站默认端口 5178 是否在跑（`pnpm run probe:serve`）')
    }
    const detail = '文本 ' + text.length + ' 字符 / data URI ' + url.length + ' 字符'
    return okText && okUrl ? pass(detail) : fail('只取到一项：text=' + okText + ' url=' + okUrl)
  })

  add('资源与依赖', '@require jQuery 前置注入生效', function () {
    if (typeof jQuery === 'undefined') {
      // 外部依赖抓不到是环境原因（离线 / CDN 不通），不是注入链路坏了 —— 记未判定
      return unknown('jQuery 不在 —— @require 的 CDN 依赖没抓到（离线环境？）')
    }
    return pass('jQuery ' + jQuery.fn.jquery + '（@require 的依赖已按序前置注入）')
  })
}
