// 中继件入口：build-relay.mjs 把它打成 IIFE 并生成为 relay-code.gen.ts（字符串常量随包发），
// 由 SW 以 `{ code }` 注册到独立 USER_SCRIPT 世界（worldId 见 relay/sync.ts）。
//
// 件只做一件事：把安装函数挂到装配段能取到的键上。密钥是运行期参数（每扩展一把、随机生成），
// 进不了代码串，故注册必须是**两段** —— 本文件 + sync.buildRelayInit 生成的装配段。
import { BRIDGE_RELAY_BOOT_KEY } from '@duoling/shared'
import { installRelay } from './install'

Object.assign(window, { [BRIDGE_RELAY_BOOT_KEY]: installRelay })
