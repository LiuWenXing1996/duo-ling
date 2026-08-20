import Store, { type Schema } from 'electron-store'

export interface Task {
  id: number
  title: string
  createdAt: string
}

interface TaskState {
  tasks: Task[]
  // 自增序号：用于新会话标题「新会话 N」
  nextSeq: number
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
  },
  nextSeq: { type: 'number' }
}

let store: Store<TaskState> | undefined

// 惰性创建：首次调用发生在 IPC 处理时（app 就绪且 userData 覆盖已生效之后）
function getStore(): Store<TaskState> {
  store ??= new Store<TaskState>({
    name: 'tasks',
    defaults: { tasks: [], nextSeq: 1 },
    schema
  })
  return store
}

export function listTasks(): Task[] {
  return getStore().get('tasks')
}

export function createTask(): Task {
  const seq = getStore().get('nextSeq')
  getStore().set('nextSeq', seq + 1)
  const task: Task = {
    id: Date.now(),
    title: `新会话 ${seq}`,
    createdAt: new Date().toISOString().slice(0, 10)
  }
  const tasks = getStore().get('tasks')
  getStore().set('tasks', [...tasks, task])
  return task
}

/** 重命名会话（手动改名或首条消息自动命名） */
export function renameTask(taskId: number, title: string): Task | null {
  const trimmed = title.trim()
  if (!trimmed) return null
  const tasks = getStore().get('tasks')
  const index = tasks.findIndex((task) => task.id === taskId)
  if (index === -1) return null
  const next = [...tasks]
  next[index] = { ...next[index], title: trimmed }
  getStore().set('tasks', next)
  return next[index]
}

export function saveTasks(tasks: Task[]): void {
  getStore().set('tasks', tasks)
}
