import { ElectronAPI } from '@electron-toolkit/preload'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      ping: () => Promise<string>
      listTasks: () => Promise<Array<{ id: number; title: string; createdAt: string }>>
      saveTasks: (
        tasks: Array<{ id: number; title: string; createdAt: string }>
      ) => Promise<void>
      llama: {
        init: () => Promise<{
          state: 'idle' | 'loading' | 'ready' | 'error'
          modelPath: string | null
          modelExists: boolean
          gpu?: string
          error?: string
        }>
        getStatus: () => Promise<{
          state: 'idle' | 'loading' | 'ready' | 'error'
          modelPath: string | null
          modelExists: boolean
          gpu?: string
          error?: string
        }>
        checkModel: () => Promise<{ exists: boolean; path: string }>
      }
      window: {
        getBounds: () => Promise<{
          x: number
          y: number
          width: number
          height: number
        } | null>
      }
    }
  }
}

export {}
