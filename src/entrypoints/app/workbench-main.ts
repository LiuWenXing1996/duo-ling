import '@/assets/main.css'
import '@/assets/main.less'
// 包内 4 个 SFC 带 <style scoped>（lang=less）：workbench 源码直出，样式随组件模块
// 经本侧 Vite 编译进产物 —— 基础样式 import 在前、组件模块在后，层序天然成立
import { createApp } from 'vue'
import { installTheme } from '@duoling/ui/lib/theme'
import { WorkbenchApp } from '@duoling/workbench'

installTheme()
createApp(WorkbenchApp).mount('#app')
