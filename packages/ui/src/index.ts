// UI 包的跨包出口：只出对话面板本体 —— 浮层（ChatApp）与工作台（会话历史）两处宿主共用它。
//
// 其余一律走子路径（`@duoling/ui/lib/...`、`@duoling/shadcn-registry/components/...`）：单桶会把
// ChatPanel → use-global-conversation 那棵树拖进每个页面，popup 这种只借三个原语的宿主
// 尤其吃亏。子路径由 package.json 的 exports 逐条登记。
export { default as ChatPanel } from './components/ChatPanel.vue'
