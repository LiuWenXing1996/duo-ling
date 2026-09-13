// workbench = 独立标签页工作区：工具运行 / 代码 / 版本 / 设置。
// 与 side panel（对话入口）分工：对话常驻侧边栏，重界面的工具操作开标签页。
import '@/assets/main.css'
import '@/assets/main.less'
import { createApp } from 'vue'
import { installWindowApi } from '@/lib/window-api'
import { installTheme } from '@/lib/theme'
import WorkbenchApp from './WorkbenchApp.vue'

installWindowApi()
installTheme()
createApp(WorkbenchApp).mount('#app')
