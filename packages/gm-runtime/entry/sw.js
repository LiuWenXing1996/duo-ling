// VM background 的「库形态」装配 entry。
//
// 装配原则（对应老大定的原则「GM 面能用 VM 的就用 VM 的，绝不新造轮子」）：
//   · import 即装配 —— VM 的模块自带副作用式命令注册（db.js 里 addPublicCommands(ParseScript…)
//     、preinject.js 里 addPublicCommands(GetInjected/InjectionFeedback/Run…)），
//     且 db.js 在模块加载时就自动 initializeDatabase() 并 resolve init promise。
//   · 不 import VM 的 background/index.js —— 那是它的整包装配点，会连带 sync（云同步）、
//     update（脚本自动更新）。我们按子系统挑：脚本库(db) + 注入决策(preinject) + 脚本元数据处理
//     (script，随 db 传入) + @require 下载(storage-fetch) + 安装确认(tab-redirector)。
//   · 消息入口不在库里挂 —— 装配权归宿主（我们的 SW / e2e），宿主把 runtime.onMessage /
//     onUserScriptMessage 接到本库导出的 dispatch 上。
//
// dispatch 是 background/index.js 里 handleCommandMessage 的精简移植（那段代码无法单独 import，
// 它的宿主文件带着 sync/update 的 import）。保留的行为：
//   · init 未就绪时排队（init.then 重入）
//   · 把消息体里的 top 搬到 src 上（content 层把 isTop 放在消息体，Chrome 的 sender 没有）
//   · src.tab 兜底为 false（VM 的命令会解构 src.tab.id 等）
// 省略的行为（装配胶水不需要）：
//   · isOwn 命令的扩展页校验（SetClipboard 等 —— 宿主接入时如需再做）
//   · offscreen 命令名的字符串直调（__.MV3 func==='string' 分支，callOffscreen 场景）

import { commands, init } from '../vendor/violentmonkey/src/background/utils/init'
import { onClientMessage } from '../vendor/violentmonkey/src/common/messaging-sw'
import {
  initializeDatabase,
  parseScript,
  getScriptsByIdsOrAll,
  updateScriptInfo,
} from '../vendor/violentmonkey/src/background/utils/db'
// 副作用 import：注册命令 + 启动初始化链
import '../vendor/violentmonkey/src/background/utils/db'
import '../vendor/violentmonkey/src/background/utils/preinject'
import '../vendor/violentmonkey/src/background/utils/storage-fetch'
import '../vendor/violentmonkey/src/background/utils/tab-redirector'
// 补全 VM 官方背景装配（index.js/sw.js 注册的命令模块），否则下文命令从未注册、
// 注入侧 GM_* 包装发命令回包 undefined —— 表现为 XHR/cookie/通知/存储值变更/tab/菜单/下载/剪贴板 整批失败。
// requests.js 现接入：MV3 下 HttpRequest / GM.download 走 offscreen+DNR；offscreen 文档复用 duo-ling 常驻的
// offscreen.html（vendor 的 callOffscreen 把 URL 改成 offscreen.html、VM 包在 offscreen-main.ts 运行时注入），
// DNR 仅靠 VM 自带 dnr.js（duo-ling 自研 DNR 运行时注册已随 P4 移除，无冲突）。
import '../vendor/violentmonkey/src/background/utils/cookies'
import '../vendor/violentmonkey/src/background/utils/requests'
import '../vendor/violentmonkey/src/background/utils/notifications'
import '../vendor/violentmonkey/src/background/utils/script'
import '../vendor/violentmonkey/src/background/utils/values'
import '../vendor/violentmonkey/src/background/utils/tabs'
import '../vendor/violentmonkey/src/background/utils/page-menu-commands'
import '../vendor/violentmonkey/src/background/utils/popup-tracker'
import '../vendor/violentmonkey/src/background/utils/offscreen'
import '../vendor/violentmonkey/src/background/utils/download-via-api'
import callOffscreen from '../vendor/violentmonkey/src/background/utils/offscreen'

// SetClipboard：VM 只在 background/index.js 里注册它（MV3 → 转发 offscreen 文档内 execCommand('copy') 写
// 剪贴板），本 entry 刻意不引 index.js，导致 dispatch 对 SetClipboard 静默返回 undefined ——
// GM_setClipboard 的 bridge.post 是 fire-and-forget，调用不抛但剪贴板没变（2026-09-26 真机实测）。
// 这里补上；src 照 VM 原样透传（sendCmdTo 的 fakeSrc 通道）。
Object.assign(commands, {
  SetClipboard: (data, src) => callOffscreen('SetClipboard', data, src),
})

export async function dispatch(msg, src) {
  if (init) return init.then(() => dispatch(msg, src))
  let func = commands[msg?.cmd]
  if (!func) return
  if (src) {
    if (msg.url) src.url = msg.url
    if (!src.tab) src.tab = false
    if (msg.top != null) src.top = msg.top
  }
  return func(msg.data, src)
}

export async function initGM() {
  await init
  await initializeDatabase()
}

export { commands, parseScript, getScriptsByIdsOrAll, updateScriptInfo }

globalThis.__gmRuntime = {
  dispatch,
  initGM,
  commands,
  parseScript,
  getScriptsByIdsOrAll,
  updateScriptInfo,
  onClientMessage,
}
