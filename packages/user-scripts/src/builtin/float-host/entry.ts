// 浮层宿主件入口：esbuild 把它打成 dist/duoling-float-host.js，应用侧取其内容作系统脚本源码
// （走统一注册链，见应用侧 system-scripts.ts）。源码里的 `__DL_FLOAT_PANEL_URL__` /
// `__DL_FLOAT_EXT_NAME__` 两个占位符由 floatHostProject 现场替换成 JSON 字面量。
import { installFloatHost } from './install'

installFloatHost()
