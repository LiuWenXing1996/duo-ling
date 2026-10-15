// 件的安装函数出口 —— **只给跨两侧的测试用**。
//
// 应用运行时（SW / offscreen / UI）不要 import 本模块：件要注入页面，不该同时住进 SW 的
// bundle（外面那层 index.ts 刻意不导出它们，理由见其文件头）。这里的唯一消费者是
// script-bridge.test.ts —— 它把 MAIN 侧的脚本桥与 USER_SCRIPT 侧的中继件接在同一个假窗口上
// 对跑，是唯一需要同时持有两侧的那类用例。

export { installRelay } from './relay/install'
export { installTabRecorder } from './recorder/install'
export { installTabForwarder } from './forwarder/install'
