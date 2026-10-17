// 起 offscreen 容器该做的事，一次做完：注册服务实体 → 启保活 → 报告就绪 →
// 首拉模型配置 + 启动对账。
//
// 注册必须在顶层**同步**完成：迟了会漏掉早到的服务调用。其余四件尽力而为，
// 失败不阻断启动（SW 未就绪、没有孤儿仓都属正常）。
//
// 总线不在本文件：`serveIpc` 的监听器归宿主入口，这里只导出它要的回调。
import { notifyRuntime, registerOffscreenService } from '@duoling/shared'
import { OffscreenService } from './offscreen-service'
import { startSwKeepalive } from './keepalive'
import { refreshActiveProfile } from './chat/profile-cache'
import { reconcileFs } from './userstate/reconcile'

/** 宿主入口顶层调一次 */
export function startOffscreenHost(): void {
  registerOffscreenService(new OffscreenService())
  startSwKeepalive()
  notifyRuntime({ kind: 'offscreen:ready' })
  void refreshActiveProfile()
  void reconcileFs()
}

/** 模型配置写侧推来变更：回拉一次（宿主旁听到就调） */
export function onConfigChanged(): void {
  void refreshActiveProfile()
}
