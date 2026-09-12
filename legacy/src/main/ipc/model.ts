// 在线大模型 IPC：模型配置列表管理（OpenAI 兼容接口）、服务商预设。
import { ipcMain } from 'electron'
import type { ModelProfile, ModelProfileInput, ModelProvider, ModelTestChatConfig, TestChatResult } from '../../shared/types'
import {
  deleteProfile,
  getActiveProfileId,
  getProfileApiKey,
  getPublicProfiles,
  saveProfile,
  setActiveProfile,
  setProfileEnabled
} from '../model-store'
import { testChatConnection } from '../openai-client'
import { getProviders } from '../providers'

export function registerModelIpc(): void {
  ipcMain.handle(
    'model:list',
    (): { profiles: ModelProfile[]; activeId: string } => ({
      profiles: getPublicProfiles(),
      activeId: getActiveProfileId()
    })
  )
  ipcMain.handle('model:save', (_event, profile: ModelProfileInput): ModelProfile =>
    saveProfile(profile)
  )
  ipcMain.handle('model:delete', (_event, id: string) => deleteProfile(id))
  ipcMain.handle('model:setActive', (_event, id: string) => setActiveProfile(id))
  // 启用/禁用模型（开关）
  ipcMain.handle('model:toggle', (_event, id: string, enabled: boolean) =>
    setProfileEnabled(id, enabled)
  )
  // 服务商预设列表（用于「添加模型」弹窗）
  ipcMain.handle('provider:list', (): ModelProvider[] => getProviders())

  // 连通性测试：发一次「最小」chat 请求验证地址/Key/模型（会消耗极少量 Token）
  ipcMain.handle(
    'model:testChat',
    async (
      _event,
      config: ModelTestChatConfig
    ): Promise<TestChatResult> => {
      try {
        // 编辑态 Key 未回显：apiKey 为空时回退到该配置已保存的 Key
        const apiKey = config.apiKey?.trim() || (config.profileId ? getProfileApiKey(config.profileId) : '')
        await testChatConnection({ ...config, apiKey })
        return { ok: true }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )
}
