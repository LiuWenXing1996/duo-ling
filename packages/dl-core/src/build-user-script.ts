import KERNEL_IIFE from '../dist/mount-dl-iife.js?raw'
import type { KernelTier, ScriptInfo } from './dl'

export interface BuildUserScriptInput {
  readonly uuid: string
  readonly name: string
  readonly source: string
  readonly requires?: readonly string[]
  readonly info?: ScriptInfo
  readonly tier?: KernelTier
}

export interface KernelPreludeInput {
  readonly uuid: string
  readonly info?: ScriptInfo
  readonly tier?: KernelTier
}

export function buildKernelPrelude(input: KernelPreludeInput): string {
  return [
    'var DL = undefined',
    `var registerId = ${JSON.stringify(input.uuid)}`,
    `var tier = ${JSON.stringify(input.tier ?? 'client')}`,
    ...(input.info ? [`var dlInfo = ${JSON.stringify(input.info)}`] : []),
    KERNEL_IIFE,
  ].join('\n')
}

export function buildUserScript(input: BuildUserScriptInput): string {
  const body = [...(input.requires ?? []), input.source].join('\n;\n')
  if (!body.trim()) throw new Error('buildUserScript：脚本正文为空，拒绝产出空注入体')
  return [
    ';(function () {',
    'var unsafeWindow = window',
    buildKernelPrelude({ uuid: input.uuid, info: input.info, tier: input.tier }),
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
