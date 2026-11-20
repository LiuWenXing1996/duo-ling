// 中继件入口：本包的 build.mjs 把它打成 IIFE 产物 dist/relay.iife.js（不入库），由 SW 以 `{ code }`
// 注册到独立 USER_SCRIPT 世界（宿主侧注册面在 service-worker 包的 relay/sync.ts，经 `?raw` 内嵌）。
//
// 件只做一件事：把安装函数挂到装配段能取到的键上。密钥是运行期参数（每扩展一把、随机生成），
// 进不了代码串，故注册必须是**两段** —— 本文件 + SW 侧 buildRelayInit 生成的装配段。
import { BRIDGE_RELAY_BOOT_KEY } from '@duoling/shared'
import { installRelay } from './install'

Object.assign(window, { [BRIDGE_RELAY_BOOT_KEY]: installRelay })
