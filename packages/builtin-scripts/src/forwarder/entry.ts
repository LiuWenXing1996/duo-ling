// 转发件入口：esbuild 把它打成 dist/duoling-forwarder.js，由 SW 以 `{ file }` 注册到独立
// USER_SCRIPT 世界（worldId 见 registry.ts）。件没有运行期参数，注入即安装，故只需这一段。
import { installTabForwarder } from './install'

installTabForwarder()
