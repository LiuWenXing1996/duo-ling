// 探针 entry：只用来验证「以 VM 的构建链产出可被外部 import 的 library」这条链路。
//
// 选 VM 的 `common/script.js` 里最浅的纯函数 getScriptRunAt（只吃 consts + banner 注入的
// safe globals），不碰 storage / options / chrome API —— 链路有问题时容易定位。
import { getScriptRunAt } from '@/common/script'

// 不用 webpack 的 output.library 导出：VM 的 wrapper 把整个 bundle 包在一个块作用域里
// （header 开 `{`、footer 收 `}`，safe globals 正定义在块内），导出语句也会被封在块里，
// 外部拿不到。改为运行时挂到 globalThis，宿主 import 本产物后从这里取。
globalThis.__gmRuntimeProbe = { getScriptRunAt }
