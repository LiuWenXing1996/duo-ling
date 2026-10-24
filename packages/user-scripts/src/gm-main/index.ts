// GM 包装组装层：注入源码 = 前缀 + @require + 脚本正文 + 后缀（设计见 ADR 0001）
import type { GmWrapperOptions } from './exposure'
import type { GmMainOpts } from './opts'
import { buildScriptBridgeSource } from '../bridge-main/script-bridge'
import { GM_MAIN_SRC } from './gm-main.gen'
import { jsonLiteral, resolveGmExposure } from './exposure'

export type { GmWrapperOptions } from './exposure'
export { resolveGmExposure } from './exposure'

function gmDynamicHead(opts: GmWrapperOptions): string {
  const gm: GmMainOpts = {
    info: opts.info,
    has: resolveGmExposure(opts.grant),
    values: opts.values,
    resources: opts.resources ?? {},
    name: opts.name,
    savedAt: opts.savedAt ?? null,
    srcMark: 'duoling://script/' + opts.uuid + '/',
  }
  return (
    ';(function () {\n' +
    'var __gmOpts = ' +
    jsonLiteral(gm) +
    '\n' +
    'var __gmBridge = ' +
    buildScriptBridgeSource(opts.pageSecret, opts.uuid) +
    '\n'
  )
}

export function buildGmWrapperPrefix(opts: GmWrapperOptions): string {
  return gmDynamicHead(opts) + GM_MAIN_SRC
}

export const GM_WRAPPER_SUFFIX = '\n} catch (e) { __gmReportCaught(e) }\n})();'
