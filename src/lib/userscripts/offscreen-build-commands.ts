// offscreen 侧的 esbuild 构建命令面（notes/content/userscript-ai-generation.md）。
//
// 构建宿主收敛到 offscreen：它是唯一同时满足「能派生 Worker（URL.createObjectURL）+
// 不会在任务中途被回收」的宿主。编辑器保存 / 历史恢复 / 将来的 AI 生成 loop 共用
// offscreen 里这一个常驻 wasm 实例——14MB 的 esbuild.wasm 整个浏览器会话只编译一次。
//
// BuildError **不跨 IPC 抛**：Error 过 chrome.runtime 消息桥只剩 message 字符串，
// 编辑器行内展示要的 issues（文件:行:列 列表）会丢。改为可辨识联合返回，由 UI 侧还原。
import { buildProject, BuildError } from './builder'
import type { BuildOutcome } from './builder'

/** 构建命令请求（ai: 前缀 = offscreen 应答，SW 静默让路） */
export type BuildRequest = { kind: 'ai:build'; files: Record<string, string>; entry: string }

export type BuildResult =
  | { status: 'ok'; outcome: BuildOutcome }
  | { status: 'buildError'; issues: string[] }
  | { status: 'error'; message: string }

/** 处理一条 ai:build 命令。自身不抛——所有失败都进结果联合 */
export async function handleBuildCommand(msg: BuildRequest): Promise<BuildResult> {
  try {
    return { status: 'ok', outcome: await buildProject(msg.files, msg.entry) }
  } catch (e) {
    if (e instanceof BuildError) return { status: 'buildError', issues: e.issues }
    return { status: 'error', message: e instanceof Error ? e.message : String(e) }
  }
}
