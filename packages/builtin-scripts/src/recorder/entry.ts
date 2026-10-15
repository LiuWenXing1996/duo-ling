// 录制件入口：esbuild 把它打成 dist/duoling-recorder.js，由 SW 以 `{ file }` 注册到页面
// MAIN 世界。件没有运行期参数，注入即安装，故只需这一段（无装配段）。
import { installTabRecorder } from './install'

installTabRecorder()
