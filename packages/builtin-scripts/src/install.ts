// 件的安装函数出口 —— **只给跨两侧的测试用**。
//
// 应用运行时（SW / offscreen / UI）不要 import 本模块：件要注入页面，不该同时住进 SW 的
// bundle（外面那层 index.ts 刻意不导出它们，理由见其文件头）。这里的消费者是各件自己的
// 单测 —— 把件与它的协议对端接在同一个假窗口上对跑。
//
// 注意：中继件（relay）已随 `@duoling/userscript-runtime` 包内化，它的安装函数出口在
// 包内（包的 script-bridge.test 直接相对导入 ./relay/install），不再从这里出。

export { installTabRecorder } from './recorder/install'
