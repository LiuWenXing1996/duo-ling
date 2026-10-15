// 中继件入口：esbuild 把它打成 dist/duoling-relay.js，由 SW 以 `{ file }` 注册到独立
// USER_SCRIPT 世界（worldId 见 registry.ts）。
//
// 件只做一件事：把安装函数挂到装配段能取到的键上。密钥是运行期参数（每扩展一把、随机生成），
// 进不了文件，故注册必须是**两段** —— 本文件 + registry.buildRelayInit 生成的装配段。
import { BRIDGE_RELAY_BOOT_KEY } from '../protocol/bridge'
import { installRelay } from './install'

Object.assign(window, { [BRIDGE_RELAY_BOOT_KEY]: installRelay })
