// workbench = 独立标签页工作区：工具运行 / 代码 / 版本 / 设置。
// 与对话界面（网页浮层）分工：对话在页面内进行，重界面的工具操作（脚本管理 / 会话历史 / 设置）开标签页。
import '@/assets/main.css'
import '@/assets/main.less'
// 包内 4 个 SFC 带 <style scoped>：lib 构建把它们抽成一份 style.css，须排在基础样式之后
import '@duoling/workbench/style.css'
import { createApp } from 'vue'
import { installTheme } from '@duoling/ui/lib/theme'
import { WorkbenchApp } from '@duoling/workbench'

installTheme()
createApp(WorkbenchApp).mount('#app')
