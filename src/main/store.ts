import Store, { type Schema } from 'electron-store'

export interface Task {
  id: number
  title: string
  createdAt: string
}

interface TaskState {
  tasks: Task[]
}

// JSON Schema 校验：拒绝畸形/被篡改的数据，防止损坏文件导致渲染层崩溃
const schema: Schema<TaskState> = {
  tasks: {
    type: 'array',
    items: {
      type: 'object',
      required: ['id', 'title', 'createdAt'],
      properties: {
        id: { type: 'number' },
        title: { type: 'string' },
        createdAt: { type: 'string' }
      },
      additionalProperties: false
    }
  }
}

let store: Store<TaskState> | undefined

// 惰性创建：首次调用发生在 IPC 处理时（app 就绪且 userData 覆盖已生效之后）
function getStore(): Store<TaskState> {
  store ??= new Store<TaskState>({
    name: 'tasks',
    defaults: { tasks: [] },
    schema
  })
  return store
}

export function listTasks(): Task[] {
  return getStore().get('tasks')
}

export function saveTasks(tasks: Task[]): void {
  getStore().set('tasks', tasks)
}
