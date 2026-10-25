import { boot } from './harness'
import { register as registerSurface } from './cases/surface'
import { register as registerStorage } from './cases/storage'
import { register as registerTabs } from './cases/tabs'
import { register as registerClipboard } from './cases/clipboard'
import { register as registerNotify } from './cases/notify'

registerSurface()
registerStorage()
registerTabs()
registerClipboard()
registerNotify()

const HASH = /(^|[#&])dl-probe\b/
const onProbePage =
  !!document.querySelector('meta[name="dl-probe-target"]') || HASH.test(location.hash)

if (onProbePage) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
}
