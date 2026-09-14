// offscreen document 入口 —— AI 生成链路的执行宿主（定位 B）。
//
// 为什么需要这个容器（docs/userscript-ai-generation.md §4.8 三层宿主寿命对照）：
//   · 侧边栏 / 工作台（document）：用户点 X 关面板即**立即销毁**，连保存现场的时机都没有
//   · background SW：空闲 30s 即回收，且单次调用有 5 分钟硬顶（不可绕过，官方不鼓励保活）
//   · offscreen document：**不主动关就一直活着**（唯一）
// 而 esbuild 要求宿主「能派生 Worker（拿得到 URL.createObjectURL）+ 不会在任务中途被回收」，
// agent loop 要求后者——三条件只有 offscreen 全过，所以 loop 与构建一起搬进来。
//
// 能力边界（官方原话：runtime API is the only extensions API supported by offscreen documents）：
//   · 只有 chrome.runtime 可用 —— chrome.storage / chrome.userScripts / chrome.tabs 全拿不到，
//     需要它们时必须经消息请 SW 代办（见 src/lib/offscreen-bridge.ts）
//   · IndexedDB 同源共享，可直连（会话历史 duoling-chat 走这条，无需经 background 中转）
//   · console 输出落在 **SW 的 inspector**（chrome://extensions → Service Worker），不在面板 DevTools
//   · 不能聚焦；opener 恒为 null；URL 必须是打包进扩展的静态 HTML（即本文件对应的 offscreen.html）
//
// 模块归属（硬约束，§4.8）：本入口只允许 import builder.ts（纯 esbuild）、
// extension-chat-transport.ts、ai SDK、offscreen-bridge.ts，以及 offscreen-only 的
// lib/userscripts/offscreen-fs-commands.ts（其内部只引 us-git / us-fs，均不碰 chrome.storage）。
// 一旦 import store.ts / fs-store.ts / model-store.ts 这类 SW 专属模块，就会在运行时报
// chrome.storage is undefined —— 这条规则的价值正是把「能不能在这里跑」变成编译器可查的问题。
//
// 生命周期：每扩展同时只能有一份；不主动关就一直活着，但**关窗口 / 扩展重载 / 浏览器崩溃
// 三者它一个都挡不住**，故「任务可恢复」的简化兜底不能省（§4.8 机制 4）。
//
// 当前进度：一期 A 组（容器与通道）。本文件暂时只有就绪握手，真正的编排（streamText +
// tools + esbuild 构建）在 B 组接入。

import '@/polyfills'
import { offscreenBridge } from '@/lib/offscreen-bridge'
import type { ModelProfileState, OffscreenPush, RuntimeRequest } from '@/shared/extension-ipc'
import { handleAiFsCommand, reconcileFs, type AiFsRequest } from '@/lib/userscripts/offscreen-fs-commands'

/** 当前模型配置（含 apiKey）：只驻内存，不写日志、不落盘（§4.8 配置通道的边界要求） */
let activeProfile: ModelProfileState | undefined

/** 就绪握手：告知 SW 容器已起（SW 侧据此确认状态、排查启动问题） */
function announceReady(): void {
  chrome.runtime.sendMessage({ kind: 'offscreen:ready' }).catch(() => {
    // 尽力而为：SW 未就绪或未注册该命令时，不阻断 offscreen 自身启动
  })
}

/** 拉取（并缓存）当前生效的模型配置 */
async function refreshActiveProfile(): Promise<void> {
  try {
    activeProfile = await offscreenBridge.getActiveProfile()
  } catch {
    // SW 尚未就绪 / 容器刚起时可能失败：保留原缓存即可，下次变更推送会重试
  }
}

/** 当前模型配置（B 组的 loop 取用；A 组先只有缓存与刷新） */
export function getCachedProfile(): ModelProfileState | undefined {
  return activeProfile
}

// SW 的单向推送：offscreen 收不到 storage.onChanged，配置变更由 SW 转告后回拉。
// ai:* 命令面：UI / SW 经 chrome.runtime.sendMessage 共享总线发来，offscreen 在此处理并回传。
// 注意 return true —— 告诉 chrome.runtime 我们要异步 sendResponse（否则响应会被丢弃）。
chrome.runtime.onMessage.addListener((raw, _sender, sendResponse): boolean => {
  const msg = raw as RuntimeRequest | OffscreenPush | undefined
  if (msg?.kind === 'offscreen:configChanged') {
    void refreshActiveProfile()
    return false
  }
  if (msg && typeof msg.kind === 'string' && msg.kind.startsWith('ai:')) {
    void (async () => {
      try {
        const data = await handleAiFsCommand(msg as AiFsRequest)
        sendResponse({ ok: true, data })
      } catch (e) {
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) })
      }
    })()
    return true
  }
  return false
})

announceReady()
void refreshActiveProfile()
// 启动一次最终一致对账：补齐缺失仓、清理多余仓目录（幂等，失败不阻断）
void reconcileFs()
