// 主题：跟随系统深浅色。
//
// 桌面版是 Electron 窗口，只跑浅色（legacy 的 index.html 没有 .dark 类，main.css 的 :root 即浅色），
// 也无主题开关。扩展页面挂在浏览器里，跟随系统是更符合预期的行为，故在此显式补上：
// 用 prefers-color-scheme 驱动 html 的 .dark 类 —— main.css 的暗色变量（.dark { --background: ... }）
// 与组件里的 `dark:` 变体（@custom-variant dark (&:is(.dark *))）都挂在这个类下，
// 加类即整体切换，无需改动任何平移来的组件。
//
// 注意：扩展页面的 CSP 是 script-src 'self'，无法内联脚本抢先设置类，故由各入口在挂载前调用。

const DARK_QUERY = '(prefers-color-scheme: dark)'

/**
 * 按系统偏好设置 html.dark，并订阅后续切换。返回取消订阅函数。
 * 需在创建 Vue 应用之前调用（早于首帧渲染，避免深浅色闪烁）。
 */
export function installTheme(): () => void {
  const media = window.matchMedia(DARK_QUERY)
  document.documentElement.classList.toggle('dark', media.matches)
  const onChange = (event: MediaQueryListEvent): void => {
    document.documentElement.classList.toggle('dark', event.matches)
  }
  media.addEventListener('change', onChange)
  return () => media.removeEventListener('change', onChange)
}
