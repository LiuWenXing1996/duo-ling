import KERNEL_IIFE from '../dist/mount-dl-iife.js?raw'
import type { ScriptInfo } from './dl'

export interface BuildUserScriptInput {
  readonly uuid: string
  readonly name: string
  readonly source: string
  readonly requires?: readonly string[]
  readonly info?: ScriptInfo
}

export function buildUserScript(input: BuildUserScriptInput): string {
  const body = [...(input.requires ?? []), input.source].join('\n;\n')
  if (!body.trim()) throw new Error('buildUserScript：脚本正文为空，拒绝产出空注入体')
  return [
    ';(function () {',
    'var DL = undefined',
    `var registerId = "${input.uuid}"`,
    ...(input.info ? [`var dlInfo = ${JSON.stringify(input.info)}`] : []),
    KERNEL_IIFE,
    'console.log(' + JSON.stringify(input.name + ' 开始执行') + ')',
    body,
    'console.log(' + JSON.stringify(input.name + ' 执行完成') + ')',
    '})();',
    '//# sourceURL=' + sourceUrl(input.uuid, input.name),
  ].join('\n')
}

function sourceUrl(uuid: string, name: string): string {
  const base = name.replace(/\.js$/i, '').replace(/[^\w.-]/g, '_') || 'script'
  return 'duoling://script/' + uuid + '/' + base + '.js'
}
