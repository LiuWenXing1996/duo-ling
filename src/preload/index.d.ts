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
      model: {
        list: () => Promise<{
          profiles: Array<{
            id: string
            name: string
            providerId: string
            baseUrl: string
            model: string
            enabled: boolean
            useFullUrl: boolean
            apiFormat: 'openai'
            hasApiKey: boolean
            contextOutputToken?: number
            temperature?: number
            topP?: number
            topK?: number
          }>
          activeId: string
        }>
        save: (profile: {
          id?: string
          name: string
          providerId?: string
          baseUrl: string
          apiKey: string
          model: string
          enabled?: boolean
          useFullUrl?: boolean
          contextOutputToken?: number
          temperature?: number
          topP?: number
          topK?: number
        }) => Promise<{
          id: string
          name: string
          providerId: string
          baseUrl: string
          model: string
          enabled: boolean
          useFullUrl: boolean
          apiFormat: 'openai'
          hasApiKey: boolean
          contextOutputToken?: number
          temperature?: number
          topP?: number
          topK?: number
        }>
        delete: (id: string) => Promise<void>
        setActive: (id: string) => Promise<void>
        toggle: (id: string, enabled: boolean) => Promise<void>
        test: (config: { baseUrl: string; apiKey: string }) => Promise<{
          ok: boolean
          models?: string[]
          error?: string
        }>
        testChat: (config: {
          baseUrl: string
          apiKey: string
          model: string
          useFullUrl?: boolean
          profileId?: string
        }) => Promise<{ ok: boolean; error?: string }>
      }
      provider: {
        list: () => Promise<
          Array<{
            id: string
            name: string
            baseUrl: string
            keyUrl: string
            models: string[]
            supported: boolean
          }>
        >
      }
      settings: {
        getSystemPrompt: () => Promise<string>
        setSystemPrompt: (value: string) => Promise<void>
      }
      window: {
        getBounds: () => Promise<{
          x: number
          y: number
          width: number
          height: number
        } | null>
      }
      capability: {
        list: () => Promise<
          Array<{
            id: string
            name: string
            description: string
            inputSchema: {
              type: string
              description: string
              fields?: Record<string, { type: string; description: string }>
            }
            outputSchema: {
              type: string
              description: string
              fields?: Record<string, { type: string; description: string }>
            }
            sideEffect: 'read' | 'write' | 'notify' | 'destructive'
            runtime: 'frontend' | 'backend'
            cost: 'offline' | 'online'
            scenario: { keywords: string[]; object: string }
          }>
        >
        run: (
          id: string,
          args: unknown
        ) => Promise<{ ok: true; result: unknown } | { ok: false; error: string }>
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
      generator: {
        send: (
          history: Array<{ role: 'user' | 'assistant'; content: string }>
        ) => Promise<{ ok: boolean; content?: string; error?: string }>
        abort: () => Promise<void>
        onEvent: (
          callback: (payload:
            | { type: 'token'; token: string }
            | { type: 'done'; content: string }
            | { type: 'aborted'; content: string }
            | { type: 'error'; error: string }) => void
        ) => void
        offEvent: () => void
      }
    }
  }
}

export {}
