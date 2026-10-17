// Agent 工具目录的转发层：真相源已归 @duoling/shared（面板展示 = 模型所见，同一份文本）。
// 本文件只维持既有 import 路径（`@/lib/agent-tools-catalog`）不变。
export {
  AGENT_RUNTIME_LIMITS,
  TOOL_PARAM_DESCRIPTIONS,
  agentToolTitle,
  agentToolViews,
  toolDescriptions,
} from '@duoling/shared'
export type { AgentToolName, AgentToolParamView, AgentToolView } from '@duoling/shared'
