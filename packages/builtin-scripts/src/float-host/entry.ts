// 浮层宿主件入口：esbuild 把它打成 dist/duoling-float-host.js，由 SW 以 `{ file }` 注册到独立
// USER_SCRIPT 世界（worldId 见 registry.ts）。
//
// 与 recorder / forwarder / 页面检查器不同，本件**只装不装配**：注入只把世界级 hook
// （window 上的 FLOAT_HOST_HOOK_KEY）挂出去，收指令的消息面要等第二段 `{ code }` 把浮层页地址与
// 扩展显示名递进来才装 —— 那两样只有扩展侧取得到，而注册项是静态字符串，只能这么递。
import { installFloatHost } from './install'

installFloatHost()
