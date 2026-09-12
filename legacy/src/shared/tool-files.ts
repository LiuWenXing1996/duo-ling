// 工具目录内「可被生成/编辑文件」的白名单：main（编辑链路 / git）与 renderer（生成器解析）共享。
//
// 目标结构（与 docs/tool-spec.md §3.2 一致）：
//   <工具目录>/
//   ├── meta.json     根级固定文件
//   ├── index.html    根级固定文件
//   ├── archive.md    根级固定文件（工具档案）
//   ├── js/           脚本目录（可嵌套）
//   ├── css/          样式目录（可嵌套）
//   └── assets/       静态资源目录（可嵌套）
// 除此之外（含 .git/）一律不可写。

/** 根级固定文件白名单 */
const TOOL_ROOT_FILES = ['index.html', 'meta.json', 'archive.md'] as const

/** 允许的子目录白名单（其下任意文件均可） */
const TOOL_SUBDIRS = ['js', 'css', 'assets'] as const

/**
 * 校验相对路径是否落在工具目录文件白名单内。
 * - 路径分隔符统一为 `/`，容忍 `./` 前缀；
 * - 含 `..`（越界）或空串直接拒绝；
 * - 根级命中固定文件，或首段命中允许子目录（支持嵌套）即放行。
 */
export function isAllowedToolFile(relPath: unknown): boolean {
  if (typeof relPath !== 'string' || !relPath) return false
  const normalized = relPath.replace(/\\/g, '/').replace(/^\.\//, '')
  if (!normalized || normalized.includes('..')) return false
  if ((TOOL_ROOT_FILES as readonly string[]).includes(normalized)) return true
  const segments = normalized.split('/')
  return segments.length >= 2 && (TOOL_SUBDIRS as readonly string[]).includes(segments[0]!)
}
