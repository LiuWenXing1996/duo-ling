import type { FileUIPart } from 'ai'
import type { Ref } from 'vue'

export interface PromptInputMessage {
  text: string
  /** 提交时的附件。
   *  声明为 AttachmentFile 而不是 FileUIPart：submitForm 实际传的就是它
   *  （含 id 与原始 File），而调用方需要原始 File —— 文本附件要读内容、
   *  图片要压缩重编码，只拿到 data URL 就做不了这两件事。 */
  files: AttachmentFile[]
}

export interface AttachmentFile extends FileUIPart {
  id: string
  file?: File
}

export interface PromptInputContext {
  textInput: Ref<string>
  files: Ref<AttachmentFile[]>
  isLoading: Ref<boolean>
  fileInputRef: Ref<HTMLInputElement | null>
  setTextInput: (val: string) => void
  addFiles: (files: File[] | FileList) => void
  removeFile: (id: string) => void
  clearFiles: () => void
  clearInput: () => void
  openFileDialog: () => void
  submitForm: () => void
}

export const PROMPT_INPUT_KEY = Symbol('PromptInputContext')
