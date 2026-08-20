import { ElectronAPI } from '@electron-toolkit/preload'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      ping: () => Promise<string>
      listTasks: () => Promise<Array<{ id: number; title: string; createdAt: string }>>
      createTask: () => Promise<{ id: number; title: string; createdAt: string }>
      renameTask: (
        taskId: number,
        title: string
      ) => Promise<{ id: number; title: string; createdAt: string } | null>
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
      chat: {
        history: (
          taskId: number
        ) => Promise<
          Array<{ id: number; role: 'user' | 'assistant'; content: string; createdAt: string }>
        >
        send: (
          taskId: number,
          text: string
        ) => Promise<{ id: number; role: 'assistant'; content: string; createdAt: string } | null>
        abort: () => Promise<void>
        onEvent: (
          callback: (payload:
            | { type: 'token'; taskId: number; token: string }
            | { type: 'done'; taskId: number; message: { id: number; role: 'assistant'; content: string; createdAt: string } }
            | { type: 'aborted'; taskId: number; message: { id: number; role: 'assistant'; content: string; createdAt: string } | null }
            | { type: 'error'; taskId: number; error: string }) => void
        ) => void
        offEvent: () => void
      }
    }
  }
}

export {}
