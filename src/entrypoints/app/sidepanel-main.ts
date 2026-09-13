// side panel = 应用入口 = AI 对话界面。
// 注意：入口脚本不能用与 html 同名的约定名（sidepanel.ts 会与 sidepanel.html 冲突，WXT 报 "Multiple entrypoints with the same name"）。
import '@/assets/main.css'
import '@/assets/main.less'
import { createApp } from 'vue'
import { installWindowApi } from '@/lib/window-api'
import { installTheme } from '@/lib/theme'
import ChatApp from './ChatApp.vue'

// 必须在挂载前装配：ChatPanel 等平移来的组件在 onMounted 就会读 window.api
installWindowApi()
// 早于首帧设置深浅色，避免闪烁
installTheme()
createApp(ChatApp).mount('#app')
