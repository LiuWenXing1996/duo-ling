// SW 侧保活应答：向 @duoling/messaging 认领保活 type，回一个固定值。
//
// 保活的真实效果来自「这条消息**到达** SW」本身 —— 一到达就重置 SW 的 30s 空闲计时。
// 应答值没有任何消费者；回它只是让这次往返完整，发送侧不必每跳都落进 catch
// （见 @duoling/offscreen-document 的 keepalive）。
//
// 与宿主总线的分工：本函数挂的是库自带的 runtime.onMessage listener（首次认领时同步挂上），
// 不占宿主总线的 matcher 位 —— 报文形状互斥，两条 listener 各认各的（见 @duoling/messaging）。
//
// 无状态、不缓存：一次注册、反复应答。幂等性由调用点保证（宿主入口顶层只调一次）——
// 二次认领同一条 type 是库的硬错（"only one listener can be setup for …"），不静默吞。
import { onSwKeepalive } from '@duoling/messaging'

/** 宿主 SW 入口顶层调用：注册保活应答；返回退订函数（测试用，生产路径不退订） */
export function registerKeepalive(): () => void {
  return onSwKeepalive(() => ({ alive: true }))
}
