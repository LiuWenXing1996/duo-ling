/**
 * 设置页分区注册表 —— 唯一的扩展点。
 *
 * 新增一个设置菜单只需两步：
 *   1. 在 src/components/settings/ 下新建分区组件（内容自包含）；
 *   2. 在本数组追加一条 { id, label, icon, component }。
 * SettingsPanel 是纯外壳：左栏按 label + icon 渲染导航，右栏渲染对应 component，
 * 自身不含任何业务逻辑，因此扩展菜单无需改动外壳。
 */
import type { Component } from 'vue'
import { Box as IconBox, Info as IconInfo, MessageSquare as IconMessageSquare } from '@lucide/vue'
import ModelSettingsSection from './ModelSettingsSection.vue'
import AboutSection from './AboutSection.vue'
import FloatPanelSection from './FloatPanelSection.vue'

export interface SettingsSection {
  /** 分区 id（作为 Tabs 的 value，需全局唯一） */
  id: string
  /** 左侧导航文案 */
  label: string
  /** 导航图标（lucide 组件对象，不是字符串键） */
  icon: Component
  /** 右侧内容组件 */
  component: Component
}

/** 设置分区清单（顺序即导航顺序，首个为默认选中项；「关于」这类只读信息固定放末位） */
export const SETTINGS_SECTIONS: SettingsSection[] = [
  { id: 'models', label: '模型管理', icon: IconBox, component: ModelSettingsSection },
  { id: 'float-panel', label: '网页浮层', icon: IconMessageSquare, component: FloatPanelSection },
  { id: 'about', label: '关于', icon: IconInfo, component: AboutSection },
]
