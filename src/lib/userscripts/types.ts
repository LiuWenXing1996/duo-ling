// 用户脚本形状的转发层：真相源已归 @duoling/shared（件包产生、offscreen 与面板消费）。
// 本文件只维持既有 import 路径（`@/lib/userscripts/types` / `./types`）不变。
export type {
  CommitActor,
  ImportItemFailed,
  ImportItemIgnored,
  ImportItemOk,
  ImportItemResult,
  ImportReport,
  RunEndReason,
  SaveOutcome,
  ScriptConfig,
  ScriptGroup,
  ScriptProject,
  ScriptSummary,
  TabEventRecord,
  TabSessionRecord,
  UserScriptErrorLookup,
  UserScriptErrorRecord,
  UserScriptRunEvent,
  UserScriptRunLogEntry,
  UserScriptRunLogRow,
  UserScriptsAvailability,
} from '@duoling/shared'

export {
  ACT_TAB_KIND,
  defaultConfig,
  defaultSource,
  ERR_TAB_KIND,
  ERROR_LOG_MAX,
  RUN_EVENT_MAX,
  RUN_LOG_MAX,
  RUN_TAB_KIND,
  SCRIPT_EXT,
  TAB_SESSION_MAX,
} from '@duoling/shared'
