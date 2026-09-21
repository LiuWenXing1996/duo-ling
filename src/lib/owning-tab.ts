// 「这个对话界面属于哪个标签页」的唯一解析处。
//
// 会话归属按标签页（一个 tab 一条会话），而对话界面是**网页浮层**：它跑在页面内嵌的 iframe
// 里，「自己是哪个 tab」这件事不能靠 `tabs.query({ active: true })` 现查 —— 用户切走之后
// 浮层仍挂在原标签页上，查「当前激活」会拿到别人。权威值只能由知情的 content script 提供
// （它经 SW 的 `sender.tab.id` 取到，见 `tab:identify`），拼进 iframe URL 的 `?tab=` 传进来。
//
// 兜底：参数缺失（content script 没取到 / 浮层被当普通标签页直接打开）时退回查当前激活
// 标签页 —— 打开浮层那一刻它必然是激活的。再取不到就返回 null，调用方按「不绑定」处理
// （照样能对话，只是这条会话不归属任何标签页），好过错绑到别人的标签页。
//
// 消费方：use-global-conversation（会话归属）、use-page-monitor（灵动岛显示哪个 tab 的脚本）。

/** 浮层经 iframe URL 传入的固定归属；没有该参数（非浮层上下文）返回 null */
export function readPinnedTabId(): number | null {
  try {
    const raw = new URLSearchParams(location.search).get('tab')
    if (!raw) return null
    const id = Number(raw)
    return Number.isInteger(id) && id > 0 ? id : null
  } catch {
    return null
  }
}

/** 本载体所属的标签页 id（pinned 优先，兜底查当前激活标签页）；取不到返回 null */
export async function resolveOwningTabId(): Promise<number | null> {
  const pinned = readPinnedTabId()
  if (pinned != null) return pinned
  try {
    if (!chrome.tabs?.query) return null
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    return tab?.id ?? null
  } catch {
    return null
  }
}
