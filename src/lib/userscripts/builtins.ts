// 内置脚本清单（docs/proposals/done/element-picker.md「内置脚本承载」）。
//
// 内置脚本**不进状态库**（写只归 offscreen 是红线；内置件没有用户可改状态），
// 也不注册进 userScripts 注册表——拾取器经 execute() 按需注入，无「启用」概念。
// 本清单是随扩展包分发的常量（打包即内置），管理页「内置」分组从这里只读渲染；
// 未来再添内置件（如 DL.page 中继辅助件）只需往数组加条目。

export interface BuiltinScriptInfo {
  /** 固定 id（拾取器世界 id 与此对应：us-builtin-picker） */
  id: string
  name: string
  description: string
}

export const BUILTIN_SCRIPTS: BuiltinScriptInfo[] = [
  {
    id: 'duoling-picker',
    name: '页面元素拾取器',
    description:
      '侧边栏「点选元素 / 页面快照」的执行端：点按钮那一刻注入当前页面，亮拾取框或静默抓取渲染后 HTML，用完即走（平时页面里没有它的代码）。',
  },
]
