// 模型配置存取（IndexedDB duoling-app 库替换桌面版的 electron-store + safeStorage）。
//
// 语义对齐桌面版原实现（model-store）：
//   1. **展示名为空时回退模型 ID**（契约见 `shared/types.ts` 的 `ModelProfile.name`）。
//      ChatPanel 的模型 chip 与下拉只读 `name`、不做回退，因此回退必须在存储层完成，
//      否则会渲染出空白项（桌面版正是在 toPublic / saveProfile 两处做的）。
//   2. **activeProfileId 始终指向一条「已启用」配置**，唯一出口是 syncActiveProfileId；
//      读取时不做事后兜底（避免「界面显示的当前模型」与「实际发送用的模型」不一致）。
//
// ⚠️ 安全边界：浏览器扩展没有 safeStorage 等价物，apiKey 经 AES-GCM 加密后落盘
// （`key-cipher.ts`，随机密钥同存本机扩展存储）——属防扫描级，非保密级；
// 真实降损靠引导用户使用子 Key + 额度上限 + 定期轮换。
//
// 变更通知：IDB 没有跨上下文通知，写出口（writeState，唯一落盘点）负责广播 `model` 域
// （扩展页的模型下拉 / 设置页回拉）并推送 offscreen:configChanged（offscreen 的
// profile-cache 回拉，apiKey 只在它取用时过界）。原 chrome.storage.onChanged 钩子已随
// 迁移删除。offscreen 不 import 本模块（SW 命令中转），故无循环依赖。
import type { ModelProfile, ModelProfileInput, ModelTestChatConfig } from '../shared/types'
import type { ModelProfileState } from '../shared/extension-ipc'
import { decryptApiKey, encryptApiKey, type EncPayload } from './key-cipher'
import * as appDb from './app-db'
import { broadcastDataChange } from './data-broadcast'

const KEY = 'modelProfiles'

/** 落盘形态：apiKey 不落明文，只存密文载荷（老数据的明文字段在读取时迁移） */
type StoredProfile = Omit<ModelProfileState, 'apiKey'> & { apiKeyEnc?: EncPayload }

interface ModelState {
  profiles: ModelProfileState[]
  activeProfileId: string
}

async function readState(): Promise<ModelState> {
  const stored =
    (await appDb.get<{ profiles: StoredProfile[]; activeProfileId: string }>(KEY)) ??
    { profiles: [], activeProfileId: '' }
  // 解密为内部形态
  const profiles: ModelProfileState[] = await Promise.all(
    stored.profiles.map(async (p) => {
      const rest = p as Omit<ModelProfileState, 'apiKey'>
      if (p.apiKeyEnc) {
        let apiKey = ''
        try {
          apiKey = await decryptApiKey(p.apiKeyEnc)
        } catch {
          // 密钥丢失或载荷损坏：宁缺勿假，清空待用户重填
        }
        return { ...rest, apiKey }
      }
      return { ...rest, apiKey: '' }
    }),
  )
  const state: ModelState = { profiles, activeProfileId: stored.activeProfileId }
  // 自愈：扩展早期版本保存时未维护 activeProfileId（可能悬空或指向已停用项）。
  // 仅在确实不一致时回写一次；此后读路径不再兜底，保持「activeProfileId 即真源」的严格语义。
  const before = state.activeProfileId
  syncActiveProfileId(state)
  if (state.activeProfileId !== before) await writeState(state)
  return state
}

async function writeState(state: ModelState): Promise<void> {
  const profiles: StoredProfile[] = await Promise.all(
    state.profiles.map(async (p) => {
      const { apiKey, ...rest } = p
      return apiKey ? { ...rest, apiKeyEnc: await encryptApiKey(apiKey) } : rest
    }),
  )
  await appDb.set(KEY, { profiles, activeProfileId: state.activeProfileId })
  // 写出口广播（见文件头）：扩展页回拉 + offscreen 的 profile-cache 回拉。
  // 推送尽力而为：offscreen 不在场就不为一条通知唤醒它。
  broadcastDataChange('model')
  void chrome.runtime
    .sendMessage({ kind: 'offscreen:configChanged' })
    .catch(() => {
      // 无人监听（容器刚被关掉 / SW 侧自愈回写）不阻断
    })
}

/**
 * 展示名回退：name 未填（或只有空白）时用模型 ID。
 * 早期数据可能连 name 字段都没有，故用可选链读取。
 */
function displayName(profile: ModelProfileState): string {
  return profile.name?.trim() || profile.model
}

/** 内部使用：完整配置（含 apiKey），供请求发起方读取 */
export async function listProfileStates(): Promise<ModelProfileState[]> {
  return (await readState()).profiles
}

/** UI 使用：剔除 apiKey 明文，仅保留 hasApiKey */
export async function listProfiles(): Promise<ModelProfile[]> {
  return (await readState()).profiles.map(toPublic)
}

function toPublic(s: ModelProfileState): ModelProfile {
  const { apiKey, ...rest } = s
  return { ...rest, name: displayName(s), hasApiKey: Boolean(apiKey) }
}

/**
 * 当前生效配置（含 apiKey）：activeProfileId 指向的**已启用**模型，否则视为未配置。
 * 此处不做运行时兜底——回退统一由 syncActiveProfileId 保证，避免隐含状态。
 */
async function getActiveProfile(): Promise<ModelProfileState | undefined> {
  const state = await readState()
  return state.profiles.find((p) => p.id === state.activeProfileId && p.enabled !== false)
}

/** 当前真正生效的模型 id（始终指向一条启用配置；无则空串） */
export async function getActiveProfileId(): Promise<string> {
  return (await getActiveProfile())?.id ?? ''
}

/** 当前生效配置（含 apiKey），未配置则 undefined */
export async function getActiveProfileState(): Promise<ModelProfileState | undefined> {
  return getActiveProfile()
}

/** 当前默认模型是否可用（baseUrl + apiKey + model 齐全） */
export async function isConfigured(): Promise<boolean> {
  const profile = await getActiveProfile()
  return Boolean(profile && profile.baseUrl && profile.apiKey && profile.model)
}

/** 读取指定配置的明文 API Key（编辑态连通性测试用，Key 未回显时回退） */
export async function getProfileApiKey(id: string): Promise<string> {
  const state = await readState()
  return state.profiles.find((p) => p.id === id)?.apiKey ?? ''
}

/**
 * 保证 activeProfileId 指向一条已启用配置；没有启用配置时置空串。
 * profiles 任何变更后都要经由此处收敛（原地修改并返回同一对象，调用方随后 writeState）。
 */
function syncActiveProfileId(state: ModelState): ModelState {
  const enabled = state.profiles.filter((p) => p.enabled !== false)
  if (!enabled.some((p) => p.id === state.activeProfileId)) {
    state.activeProfileId = enabled[0]?.id ?? ''
  }
  return state
}

/** 切换当前默认模型；id 不存在时忽略（对应桌面版 setActiveProfile 的守卫） */
export async function setActiveProfile(id: string): Promise<void> {
  const state = await readState()
  if (!state.profiles.some((p) => p.id === id)) return
  state.activeProfileId = id
  await writeState(state)
}

/**
 * 新增或更新模型配置。新增时若还没有默认模型则自动成为默认；
 * 编辑时 apiKey 为空保留原 Key；展示名为空回退为模型 ID。
 */
export async function saveProfile(input: ModelProfileInput): Promise<ModelProfile> {
  const state = await readState()
  const existing = input.id ? state.profiles.find((p) => p.id === input.id) : undefined
  const id = existing?.id ?? crypto.randomUUID()
  const apiKey = input.apiKey.trim()
  const next: ModelProfileState = {
    id,
    name: input.name.trim() || input.model.trim() || '未命名模型',
    providerId: input.providerId ?? existing?.providerId ?? '',
    // 末尾斜杠会与 openai-compatible 的 /chat/completions 拼出双斜杠，统一在此剥离
    baseUrl: input.baseUrl.trim().replace(/\/+$/, ''),
    model: input.model.trim(),
    enabled: input.enabled ?? existing?.enabled ?? true,
    useFullUrl: input.useFullUrl ?? existing?.useFullUrl ?? false,
    apiFormat: 'openai',
    hasApiKey: Boolean(apiKey) || Boolean(existing?.apiKey),
    apiKey: apiKey || existing?.apiKey || '',
      contextOutputToken: input.contextOutputToken,
      temperature: input.temperature,
      topP: input.topP,
      topK: input.topK,
      streamIdleTimeoutSec: input.streamIdleTimeoutSec ?? existing?.streamIdleTimeoutSec,
      // 能力声明缺省为关闭：老配置没有这个字段，一律按「不支持图片」起步 ——
      // 默认开着会把图片发给读不了图的模型（失败方式见 shared/types 的 ModelProfile.vision）
      vision: input.vision ?? existing?.vision ?? false
    }
  state.profiles = existing
    ? state.profiles.map((p) => (p.id === id ? next : p))
    : [...state.profiles, next]
  // 第一条配置自动成为默认模型
  if (!state.activeProfileId) state.activeProfileId = next.id
  await writeState(syncActiveProfileId(state))
  return toPublic(next)
}

export async function removeProfile(id: string): Promise<void> {
  const state = await readState()
  state.profiles = state.profiles.filter((p) => p.id !== id)
  await writeState(syncActiveProfileId(state))
}

/** 启用/停用某条模型配置（对应 ModelFormDialog 的开关）；停用当前模型会自动改选其它启用项 */
export async function setProfileEnabled(id: string, enabled: boolean): Promise<void> {
  const state = await readState()
  if (!state.profiles.some((p) => p.id === id)) return
  state.profiles = state.profiles.map((p) => (p.id === id ? { ...p, enabled } : p))
  await writeState(syncActiveProfileId(state))
}

/**
 * 连通性测试：发一次最小 chat 请求（非流式）。
 * 保持与桌面版 openai-client 相同的地址拼接规则（useFullUrl=false 时追加 /chat/completions）。
 */
export async function testChat(config: ModelTestChatConfig): Promise<void> {
  const baseUrl = config.baseUrl.trim().replace(/\/+$/, '')
  const apiKey = config.apiKey.trim()
  const model = config.model.trim()
  if (!baseUrl) throw new Error('请先填写接口地址')
  if (!apiKey) throw new Error('请先填写 API Key')
  if (!model) throw new Error('请先填写模型 ID')

  const url = config.useFullUrl ? baseUrl : `${baseUrl}/chat/completions`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        stream: false,
        max_tokens: 8,
      }),
      signal: controller.signal,
    })
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300)
      throw new Error(`HTTP ${res.status}：${text}`)
    }
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw new Error('请求超时（15s）')
    throw e
  } finally {
    clearTimeout(timer)
  }
}
