// Agent 工具目录：**工具契约与运行时闸门的展示侧单一来源**（纯数据、零依赖）。
//
// 为什么单独一份、而不是直接读 script-tools：
//   script-tools.ts 是 offscreen 专属模块（import us-git 源码库 / 裸 IDB 读侧），
//   工作台页面 import 它既拖大首屏产物、又会碰到它访问不到的东西。故把「工具描述文本 + 运行时闸门」
//   这两样纯数据抽到这里，运行时（script-tools / chat-host）与工作台「AI 工具」面板共用同一份 ——
//   模型收到的 description 与面板展示的必然一致，不需要人工对照。
//
// 漂移防护：工具名集合与各工具的参数名集合由单测从运行时 schema 反射比对
// （见 src/lib/agent-tools-catalog.test.ts），改了 tools 忘了改本文件会红。

/** 工具名（与 buildScriptTools 返回对象的键一一对应） */
export type AgentToolName =
  | 'script_spec'
  | 'script_read'
  | 'script_apply'
  | 'element_read'
  | 'page_snapshot'
  | 'net_capture_enable'
  | 'net_capture_read'
  | 'error_read'

/** 运行时闸门：面板展示的阈值与运行时真身共用这一份（改这里即改行为，别再各写一份） */
export const AGENT_RUNTIME_LIMITS = {
  /** 单次任务的步数上限（chat-host 的 stopWhen: stepCountIs） */
  maxSteps: 8,
  /** script_apply 连续失败上限：达到即让模型停手；再多一次 apply 直接中止整个任务 */
  maxApplyFailures: 6,
} as const

/** 工具 description 原文：**模型实际收到的就是这些字**，面板也展示这一份 */
export const TOOL_DESCRIPTIONS: Record<AgentToolName, string> = {
  script_spec:
    '获取哆灵用户脚本的完整规范（GM 能力 API、硬性约束、禁止事项）。写或改任何脚本前必须先调用它。',
  script_read:
    '读取脚本源码。不带参数 = 读当前任务的内存源码（本任务已写入的内容）；带 uuid = 读一个已保存的脚本（修改现有脚本时用）。',
  script_apply:
    '提交（整文件写）脚本源码并立即做语法检查。返回 ok=true 表示检查通过（任务收敛）；' +
    '返回 ok=false 时 errors 为 行:列 诊断列表，按诊断修改后再次整体提交。' +
    '修改既有脚本（本会话此前生成过的）时必须带 updateUuid，落盘才会原地更新该脚本；省略 = 生成一个全新脚本。',
  element_read:
    '读取用户点选元素的完整快照（system prompt 里只有摘要层）。' +
    '摘要层有不确定处时调用：返回全部属性、完整 outerHTML（拾取时刻截断快照，非活页面）、祖先链。' +
    '本次请求没有点选元素时返回 ok:false。',
  page_snapshot:
    '抓取当前页面的**渲染后 DOM** 快照（documentElement.outerHTML，截断 ~32KB，拾取时刻快照非实时）。' +
    '需要了解页面整体结构、找脚本目标节点的上下文、或摘要信息不够用时调用。' +
    '内置页（chrome:// 等）与非活动窗口不可采，返回 ok:false 带原因。',
  net_capture_enable:
    '为该站点开启接口录制（页面发出的 fetch / XHR）。调用后会在对话里出一张开启卡片，' +
    '**必须由用户点确认**——你不能替用户决定，卡片出现后就把话交给用户，不要重复调用。' +
    '用户点开启后，还要请其点浏览器的刷新按钮重载页面：钩子只在文档开头挂，' +
    '不刷新就录不到已经跑完的首屏请求。用户刷新完再调 net_capture_read 读回。',
  net_capture_read:
    '读回该站点已录制的接口语料（地址 / 方法 / 请求体 / 响应结构采样；鉴权头在采集时已剥离，' +
    '所以鉴权信息是缺的，别据此推断登录态）。需先 net_capture_enable 拿到用户同意、且用户已刷新过页面，' +
    '否则没有数据（返回 ok:false 并说明缺哪一步）。',
  error_read:
    '按错误 ID 查询一条脚本错误记录。用户可能直接粘贴一个错误 ID（脚本运行出错后，' +
    '工作台错误日志里每条错误旁都展示，前 8 位短形态）要求修复。返回错误详情（message / stack / ' +
    '报错页面 url）与脚本 uuid——uuid 可直接交给 script_read 读源码，改完带 updateUuid 调 script_apply 原地更新。',
}

/** 参数 description 原文（zod `.describe()` 的文本，模型同样看得到）：UI 与运行时共用 */
export const TOOL_PARAM_DESCRIPTIONS = {
  script_read: {
    uuid: '已保存脚本的 uuid；省略则读当前任务内存源码',
  },
  script_apply: {
    summary: '本轮改动的一句话摘要（将作为落盘时的提交说明）',
    config: '脚本配置：matches 必填（收窄到目标站点）',
    code: '完整脚本源码（单文件纯 JS，不支持 import / export）',
    updateUuid:
      '要原地更新的既有脚本 uuid（system prompt 会给出本会话已落盘脚本的身份）；省略 = 生成新脚本',
  },
  element_read: {
    part: '只取一部分省 token；默认 all',
  },
  net_capture_enable: {
    host: '目标站点主机名（如 example.com）。从 system prompt 的当前页面 URL 取；只填主机名，不带协议与路径',
  },
  net_capture_read: {
    host: '目标站点主机名（与 net_capture_enable 同一个）',
  },
  error_read: {
    id: '错误 ID：完整 id，或至少 8 位的前缀（多命中会报不唯一）',
  },
} as const

/** 面板里的一个入参条目。`name` 用点号表达嵌套（如 `config.matches` 属顶层键 `config`） */
export interface AgentToolParamView {
  name: string
  /** 展示用类型记法 */
  type: string
  required: boolean
  /** 有默认值时展示（字符串形式，如 `'main.js'`） */
  default?: string
  /** 说明：zod 有 describe 的一律引用 TOOL_PARAM_DESCRIPTIONS（与模型所见同源） */
  desc: string
}

/** 面板里的一个工具条目（展示元数据；description 与运行时同源） */
export interface AgentToolView {
  name: AgentToolName
  /** 卡片标题（中文短名，便于一眼扫） */
  title: string
  /** 一句话作用（列表态） */
  summary: string
  description: string
  params: AgentToolParamView[]
  /** 返回值要点 */
  returns: string
  /** 什么情况下返 ok:false / 不可用 */
  unavailable: string
}

const T = TOOL_PARAM_DESCRIPTIONS

/** 面板渲染用的工具清单（顺序 = 建议的调用顺序：拿规范 → 读 → 写） */
export const AGENT_TOOL_VIEWS: AgentToolView[] = [
  {
    name: 'script_spec',
    title: '脚本规范',
    summary: '取用户脚本的完整规范（GM 能力 API、硬约束、禁止事项）',
    description: TOOL_DESCRIPTIONS.script_spec,
    params: [],
    returns: '{ spec: string } —— 规范全文',
    unavailable: '无入参、不会失败',
  },
  {
    name: 'script_read',
    title: '读源码',
    summary: '读当前任务的内存源码，或按 uuid 读一个已保存脚本',
    description: TOOL_DESCRIPTIONS.script_read,
    params: [
      {
        name: 'uuid',
        type: 'string',
        required: false,
        desc: T.script_read.uuid,
      },
    ],
    returns:
      '{ ok:true, config, code }；带 uuid 时另有 { uuid, name, enabled }',
    unavailable: '源码库不可用 / 已损坏 → { ok:false, error }',
  },
  {
    name: 'script_apply',
    title: '写 + 语法检查',
    summary: '整文件提交源码并立刻做语法检查；写与验证合并成一步',
    description: TOOL_DESCRIPTIONS.script_apply,
    params: [
      {
        name: 'summary',
        type: 'string',
        required: true,
        desc: T.script_apply.summary,
      },
      {
        name: 'config.matches',
        type: 'string[]',
        required: true,
        desc: 'URL 匹配模式，至少一条（收窄注入范围）',
      },
      {
        name: 'config.excludeMatches',
        type: 'string[]',
        required: false,
        desc: '要排除的匹配模式',
      },
      {
        name: 'config.includeGlobs',
        type: 'string[]',
        required: false,
        desc: '限定注入的页面路径（glob）',
      },
      {
        name: 'config.excludeGlobs',
        type: 'string[]',
        required: false,
        desc: '排除注入的页面路径（glob）',
      },
      {
        name: 'config.allFrames',
        type: 'boolean',
        required: false,
        default: 'true',
        desc: '是否注入所有 frame',
      },
      {
        name: 'config.runAt',
        type: "'document_start' | 'document_end' | 'document_idle'",
        required: false,
        default: "'document_end'",
        desc: '注入时机',
      },
      { name: 'code', type: 'string', required: true, desc: T.script_apply.code },
      {
        name: 'updateUuid',
        type: 'string',
        required: false,
        desc: T.script_apply.updateUuid,
      },
    ],
    returns:
      '成功 { ok:true, bytes }；失败 { ok:false, errors: string[] }（连败达阈值另带 stop）',
    unavailable: '入参非法或语法检查失败 → errors 为 行:列 诊断',
  },
  {
    name: 'element_read',
    title: '读点选元素',
    summary: '取用户点选元素的完整快照（属性 / outerHTML / 祖先链）',
    description: TOOL_DESCRIPTIONS.element_read,
    params: [
      {
        name: 'part',
        type: "'attrs' | 'html' | 'parents' | 'all'",
        required: false,
        default: "'all'",
        desc: T.element_read.part,
      },
    ],
    returns: '{ ok:true, pickedAt, pageUrl, summaryTag, attrs?, outerHTML?, parentChain? }',
    unavailable: '本次请求没有点选元素 → { ok:false, error }',
  },
  {
    name: 'page_snapshot',
    title: '抓页面快照',
    summary: '抓当前页渲染后 DOM（截断 ~32KB）',
    description: TOOL_DESCRIPTIONS.page_snapshot,
    params: [],
    returns: '{ ok:true, pageUrl, capturedAt, html }',
    unavailable: '未接采集通道 / 内置页（chrome://）/ 非活动窗口 → { ok:false, error }',
  },
  {
    name: 'net_capture_enable',
    title: '开启接口录制',
    summary: '出录制同意卡（用户点确认），为该站点开接口录制',
    description: TOOL_DESCRIPTIONS.net_capture_enable,
    params: [
      { name: 'host', type: 'string', required: true, desc: T.net_capture_enable.host },
    ],
    returns:
      '未开时 { ok:true, awaitingUser:true, host }（等用户点卡片）；已开时 { ok:true, enabled:true, host }',
    unavailable: '当前环境未接入录制通道 → { ok:false, error }',
  },
  {
    name: 'net_capture_read',
    title: '读接口录制',
    summary: '读回该站点已录的接口语料（请求 / 响应结构采样）',
    description: TOOL_DESCRIPTIONS.net_capture_read,
    params: [
      { name: 'host', type: 'string', required: true, desc: T.net_capture_read.host },
    ],
    returns: '{ ok:true, host, count, captures }（captures 为逐条文本）',
    unavailable: '该站点未开启录制、或用户还没刷新过页面（无数据）→ { ok:false, error }',
  },
  {
    name: 'error_read',
    title: '查错误记录',
    summary: '按错误 ID 反查错误详情 + 脚本 uuid（用于「修这个报错」）',
    description: TOOL_DESCRIPTIONS.error_read,
    params: [
      { name: 'id', type: 'string', required: true, desc: T.error_read.id },
    ],
    returns:
      '{ ok:true, errorId, scriptUuid, scriptName, phase, message, stack?, pageUrl?, time }',
    unavailable: '未接查询通道 / 前缀多命中 / 记录已被环形日志（最近 50 条）挤掉 → { ok:false, error }',
  },
]

/** 工具名 → 展示名的快速映射（面板列表 / 轨迹行用） */
export const AGENT_TOOL_TITLES: Record<string, string> = Object.fromEntries(
  AGENT_TOOL_VIEWS.map((t) => [t.name, t.title]),
)
