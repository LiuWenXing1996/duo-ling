// 脚本引擎的**运行时**形态（未落库）：产生方在 SW 侧的件包实现里（注册、桥、依赖抓取），
// 落库形态见 userscript-shapes.ts（错误记录在那里被继承收窄成必有字段版）。
//
// 为什么在契约包：形状由件包产生、由应用侧落库与展示、由 offscreen 的工具集消费
// —— 放任何一侧都要另一侧反向依赖。

/** 错误记录（观测面）。不注入遥测则无处落盘 */
export interface UserscriptErrorRecord {
  id?: string
  uuid?: string | null
  name?: string
  phase: 'runtime' | 'register' | 'bridge' | 'require' | 'resource'
  message: string
  stack?: string
  url?: string
  time?: number
  runId?: string | null
  tabSessionId?: string
}

/** 一次运行期间脚本做过的关键动作摘要（只记轮廓、不记值本体） */
export interface UserscriptRunEvent {
  kind: string
  detail: string
  time: number
}

/** 引擎可用性状态（供管理页状态横幅展示） */
export interface UserScriptsAvailability {
  /** userScripts API 当前是否可用（getScripts 不抛错） */
  available: boolean
  /** 是否 Firefox（引导文案不同：Firefox 走 optional_permissions 授权） */
  isFirefox: boolean
  /** Chrome 大版本号（0 表示非 Chrome / 解析失败） */
  chromeMajor: number
  /** 不可用时的引导文案（按浏览器 / 版本分支） */
  guideText: string
}
