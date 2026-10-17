// 构建期注入信息的读取口（诊断用）。
//
// 唯一来源 = vite.define 注入的裸标识符 `__BUILD_INFO__`（见 wxt.config.ts），编译进所有 JS
// bundle（页面 / SW / offscreen 三处同源）。不走 HTML 内联注入（`window.__BUILD_INFO__`）
// ——它撞 MV3 extension_pages CSP（不含 `'unsafe-inline'`），生产环境拿不到值。
//
// 本文件只放「读全局」这一半：它被 offscreen 的环境快照直接消费。展示格式化与 `sw:buildInfo`
// 命令面需要 IPC 总线，归应用侧的 lib/build-info.ts。

/** 构建期由 vite.define 注入的结构 */
export interface InjectedBuildInfo {
  /** ISO 时间戳：dev = dev server 启动时刻，build = 构建时刻 */
  time: string
  /** 构建所在分支 */
  branch: string
  /** package.json 完整版本（含预发布标签） */
  version: string
  /**
   * 仓库标识 `owner/repo`（构建期从 git remote 推导，见 wxt.config.ts）。
   * 供检查更新调 GitHub Releases；推导不到时为 `unknown`，检查更新会自行跳过。
   */
  repo: string
}

// 本包不吃 chrome 全局，同理也不吃应用侧的 shims：就地声明这个注入标识符。
// 模块内声明只在本文件生效，不会与应用侧的全局声明冲突。
declare const __BUILD_INFO__: InjectedBuildInfo | undefined

/**
 * 读构建期注入的构建信息。未应用该 define 的环境（如 vitest）里标识符不存在，返回 null。
 * typeof 守卫必需：直接读不存在的裸标识符会抛 ReferenceError，typeof 不会。
 */
export function readInjectedBuildInfo(): InjectedBuildInfo | null {
  const info = typeof __BUILD_INFO__ !== 'undefined' ? __BUILD_INFO__ : undefined
  return info ?? null
}
