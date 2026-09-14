// offscreen 侧的模型配置缓存（方案 §4.8 配置通道）。
//
// offscreen 拿不到 chrome.storage，配置只能从 SW 经 model:getActiveProfile 取一次并缓存；
// 变更由 SW 推 offscreen:configChanged、这里回拉。apiKey 属同扩展内上下文之间的传递
// （offscreen 与 SW 信任级别等同），边界要求：**取一次、缓存、不写日志、不落盘**。

import { offscreenBridge } from '@/lib/offscreen-bridge'
import type { ModelProfileState } from '@/shared/extension-ipc'

let activeProfile: ModelProfileState | undefined

/** 拉取（并缓存）当前生效的模型配置。失败保留原缓存，等下次变更推送重试 */
export async function refreshActiveProfile(): Promise<void> {
  try {
    activeProfile = await offscreenBridge.getActiveProfile()
  } catch {
    // SW 尚未就绪 / 容器刚起时可能失败：保留原缓存即可
  }
}

/** 当前模型配置（chat-host 取用；可能为 undefined = 尚未配置模型） */
export function getActiveProfile(): ModelProfileState | undefined {
  return activeProfile
}
