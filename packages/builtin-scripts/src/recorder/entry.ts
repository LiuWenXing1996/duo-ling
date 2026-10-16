// 录制件入口：esbuild 把它打成 dist/duoling-recorder.js，应用侧取文件内容作源码、
// 经统一脚本注册链（registerScript + GM 包装）注入页面 MAIN 世界。
// 件没有运行期参数（幂等守卫 + 桥由包装层供给），故只需这一段（无装配段）。
import { installTabRecorder } from './install'

installTabRecorder()
