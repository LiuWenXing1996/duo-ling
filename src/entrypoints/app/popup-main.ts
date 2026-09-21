// popup = 点工具栏图标弹出的配置面板（浮层显示开关 + 唤起对话）。
// 与 floatpanel-main.ts 同机制挂载，差异：popup 是纯配置面板、不承载对话，
// 故只装 installTheme 跟随系统深浅色，不装 installWindowApi（该面板不发起任何对话调用）。
// 入口脚本不能用与 html 同名的约定名（popup.ts 会与 popup.html 冲突，WXT 报 "Multiple entrypoints"）。
import '@/assets/main.css'
import '@/assets/main.less'
import { createApp } from 'vue'
import { installTheme } from '@/lib/theme'
import PopupPanel from '@/components/PopupPanel.vue'

// 早于首帧设置深浅色，避免闪烁
installTheme()
createApp(PopupPanel).mount('#app')
