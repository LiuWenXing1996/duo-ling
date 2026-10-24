// 中继件本体的源码出口：installRelay 供 SW 侧单测直接以源码形态调用（产物形态是 IIFE 字符串，
// 随 SW 以 `?raw` 内嵌（见 relay/sync.ts）。件本体刻意不从 `./builtin` 桶导出 —— 桶被 SW bundle 消费，re-export 会
// 把件源码拉进 SW；本子路径只被测试取用，无此顾虑。
export { installRelay } from './install'
