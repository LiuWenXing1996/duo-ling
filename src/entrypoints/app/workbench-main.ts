// workbench = 独立标签页工作区：工具运行 / 代码 / 版本 / 设置。
// 与对话界面（网页浮层）分工：对话在页面内进行，重界面的工具操作（脚本管理 / 会话历史 / 设置）开标签页。
import '@/assets/main.css'
import '@/assets/main.less'
import { createApp } from 'vue'
import { installWindowApi } from '@/lib/window-api'
import { installTheme } from '@/lib/theme'
import WorkbenchApp from './WorkbenchApp.vue'

installWindowApi()
installTheme()
createApp(WorkbenchApp).mount('#app')
