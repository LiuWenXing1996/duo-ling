// 入口脚本不能用与 html 同名的约定名（popup.ts 会与 popup.html 冲突，WXT 报 "Multiple entrypoints"）。
import '@/assets/main.css'
import '@/assets/main.less'
import { createApp } from 'vue'
import { installTheme } from '@duoling/ui/lib/theme'
import { PopupPanel } from '@duoling/popup'

// 早于首帧设置深浅色，避免闪烁
installTheme()
createApp(PopupPanel).mount('#app')
