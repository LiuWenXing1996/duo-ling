// 打开的工作区标签：主页 / 工具 / 设置 / 工具版本历史
export type OpenTool = {
  /** 标签唯一标识：主页与设置固定，工具用工具 ID，版本历史用「工具ID:history」 */
  id: string
  title: string
  /** 标签种类：home 渲染工具主页，tool 渲染三栏工具页，settings 渲染设置面板，history 渲染版本历史 */
  kind: 'home' | 'tool' | 'settings' | 'tool-history'
  /** 仅 tool-history：对应的工具 ID 与标题（用于加载并展示该工具的 git 历史） */
  toolId?: string
  toolTitle?: string
  /** 工具图标（单个字符），来自 meta.icon，labels 标签展示 */
  icon?: string
}
