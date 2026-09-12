import { defineConfig } from 'wxt'
import vue from '@vitejs/plugin-vue'

// 哆灵 · 浏览器插件版（一期 MVP）
// 不依赖已下架的 @wxt/vue，直接用 vite 的 vue 插件编译 .vue 组件。
// 工作台形态：side panel（Chrome）+ sidebar_action（Firefox，见 docs 方案 §5 风险7）。
export default defineConfig({
  vite: () => ({
    plugins: [vue()],
    // service worker 里没有 Node 的 `global`，而 isomorphic-git/lightning-fs 的
    // 打包代码写的是 `global.TextEncoder`。构建期把 `global` 别名成原生 globalThis
    // （SW 里自带 TextEncoder/TextDecoder），否则加载即抛
    // "Cannot read properties of undefined (reading 'TextEncoder')"，连带 SW 注册失败。
    define: {
      global: 'globalThis',
    },
  }),
  manifest: {
    name: '哆灵',
    description: '哆灵 AI 工具工厂 · 浏览器插件版（side panel 工作台）',
    // sidePanel 是使用 chrome.sidePanel API 的必需权限（Chrome 114+），不要剔除。
    // setPanelBehavior({openPanelOnActionClick:true}) 还需声明 action 键，点工具栏图标才会开面板。
    permissions: ['storage', 'sidePanel'],
    action: {
      default_title: '打开哆灵',
    },
    // 一期用 side panel 工作台。Chrome 用 side_panel key；Firefox 的 sidebar_action 在
    // 三期跨端时再补（方案 §5 风险7）。
    side_panel: {
      default_path: 'sidepanel.html',
    },
  },
})
