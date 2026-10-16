// 页面检查器入口：esbuild 把它打成 dist/duoling-page-inspector.js，由 SW 以 `{ file }` 注册到
// 独立 USER_SCRIPT 世界（worldId 见 registry.ts）。
//
// 件没有运行期参数，注入即安装，故只需这一段（无装配段）—— 与 recorder 同形。
import { installPageInspector } from './install'

installPageInspector()
