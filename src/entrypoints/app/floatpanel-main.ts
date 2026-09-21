// 浮层对话界面入口：装配 ChatApp（对话界面本体，唯一的对话载体）。
// 承载容器是网页内 iframe（由 content script 注入）。
// 注意：入口脚本不能用与 html 同名的约定名（floatpanel.ts 会与 floatpanel.html 冲突，
// WXT 报 "Multiple entrypoints with the same name"），故用 app/floatpanel-main.ts。
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
