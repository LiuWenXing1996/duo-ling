import { describe, expect, it } from 'vitest'
import type { RuntimeRequest } from '@duoling/shared'
import { SW_KIND_PREFIXES } from './entrypoints/background'

type OwnershipRow = { kind: RuntimeRequest['kind']; side: 'sw' }

const ALL_KINDS = [
  { kind: 'userscript:list', side: 'sw' },
  { kind: 'userscript:getProject', side: 'sw' },
  { kind: 'userscript:save', side: 'sw' },
  { kind: 'userscript:create', side: 'sw' },
  { kind: 'userscript:createProject', side: 'sw' },
  { kind: 'userscript:remove', side: 'sw' },
  { kind: 'userscript:removeAll', side: 'sw' },
  { kind: 'userscript:toggle', side: 'sw' },
  { kind: 'userscript:rename', side: 'sw' },
  { kind: 'userscript:availability', side: 'sw' },
  { kind: 'userscript:tabSessions', side: 'sw' },
  { kind: 'userscript:tabTimeline', side: 'sw' },
  { kind: 'userscript:tabActivityEnable', side: 'sw' },
  { kind: 'userscript:tabActivityDisable', side: 'sw' },
  { kind: 'userscript:tabActivityDelete', side: 'sw' },
  { kind: 'userscript:tabActivityClear', side: 'sw' },
  { kind: 'userscript:import', side: 'sw' },
  { kind: 'userscript:importText', side: 'sw' },
  { kind: 'userscript:builtins', side: 'sw' },
  { kind: 'userscript:runlog', side: 'sw' },
  { kind: 'userscript:groups', side: 'sw' },
  { kind: 'userscript:setGroup', side: 'sw' },
  { kind: 'userscript:group-create', side: 'sw' },
  { kind: 'userscript:group-rename', side: 'sw' },
  { kind: 'userscript:group-remove', side: 'sw' },
  { kind: 'userscript:group-reorder', side: 'sw' },
  { kind: 'offscreen:ensure', side: 'sw' },
  { kind: 'offscreen:close', side: 'sw' },
  { kind: 'offscreen:status', side: 'sw' },
  { kind: 'offscreen:call', side: 'sw' },
  { kind: 'page:overview', side: 'sw' },
  { kind: 'picker:pick', side: 'sw' },
  { kind: 'picker:cancel', side: 'sw' },
  { kind: 'float:open', side: 'sw' },
  { kind: 'float:collapse', side: 'sw' },
  { kind: 'float:busy', side: 'sw' },
  { kind: 'float:ping', side: 'sw' },
  { kind: 'tab:identify', side: 'sw' },
  { kind: 'conv:create', side: 'sw' },
  { kind: 'conv:rename', side: 'sw' },
  { kind: 'conv:delete', side: 'sw' },
  { kind: 'conv:deleteAll', side: 'sw' },
  { kind: 'chat:start', side: 'sw' },
  { kind: 'chat:abort', side: 'sw' },
  { kind: 'chat:resume', side: 'sw' },
  { kind: 'chat:orphans', side: 'sw' },
  { kind: 'chat:orphanAction', side: 'sw' },
  { kind: 'sw:runningChats', side: 'sw' },
  { kind: 'sw:buildInfo', side: 'sw' },
] as const satisfies readonly OwnershipRow[]

type Expect<T extends true> = T

const _allKindsCovered: Expect<
  Exclude<RuntimeRequest['kind'], (typeof ALL_KINDS)[number]['kind']> extends never ? true : false
> = true

it('kind 面完整性断言恒真（编译期 + 运行时双兜底）', () => {
  expect(_allKindsCovered).toBe(true)
})

describe('(a) RuntimeRequest kind 路由完整性', () => {
  it.each(ALL_KINDS)('$kind → $side', ({ kind }) => {
    expect(
      SW_KIND_PREFIXES.some((p) => kind.startsWith(p)),
      `${kind} 无前缀认领`,
    ).toBe(true)
  })

  it('表内无重复 kind', () => {
    const kinds = ALL_KINDS.map((r) => r.kind)
    expect(new Set(kinds).size).toBe(kinds.length)
  })

  it('前缀表无互相包含（短前缀会吞掉长前缀的 kind）', () => {
    for (const a of SW_KIND_PREFIXES) {
      for (const b of SW_KIND_PREFIXES) {
        if (a === b) continue
        expect(a.startsWith(b), `${a} 被 ${b} 吞掉`).toBe(false)
      }
    }
  })
})
