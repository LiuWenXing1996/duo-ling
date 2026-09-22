// 桥命令面**防漂移**测试：契约登记表（`API_COMMANDS`）↔ 注入侧真实发出的命令。
//
// 为什么需要它：注入的 GM 包装是 gm-wrapper.ts 里的**源码字符串**，包装层发出的命令名
// （`__gmSend({ c: 'store.get' … })`）对 typecheck 完全不可见 —— 名字拼错、或改了 dispatch
// 漏改包装层，编译与分层单测都不报，只有真机跑到那条 API 才炸（且报的是「未实现的 DL 命令」，
// 离现场很远）。故从**真实注入源码**反射发送侧命令集合，与登记表双向比对。
//
// 命令面共三条缝，另两条不需要反射（别在这里重复造）：
//   · 登记表 ↔ `ApiRequest['c']`：`Record<ApiRequest['c'], true>` 两向约束（编译期）；
//   · `ApiRequest['c']` ↔ dispatch 的 switch：`default` 里的 `never` 穷尽性检查已覆盖。
// 本文件只管**发送侧**那一条缝。
import { describe, expect, it } from 'vitest'
import type { GmInfo } from './api-contract'
import { API_COMMANDS } from './api-contract'
import { buildGmWrapperPrefix } from './gm-wrapper'

/** 造一份最小 GM_info（userAgent / isIncognito 由包装运行时就地补，故不传） */
function info(): Omit<GmInfo, 'userAgent' | 'isIncognito'> {
  return {
    script: {
      name: '命令面反射',
      matches: ['https://example.com/*'],
      includes: [],
      excludes: [],
      runAt: 'document-end',
      grant: [],
      requires: [],
      resources: {},
    },
    scriptMetaStr: '',
    scriptHandler: '哆灵',
    version: '0.0.0-test',
    uuid: 'u-cmd',
    sandboxMode: 'js',
  }
}

/**
 * 反射注入侧发出的命令名。
 *
 * 反射对象是 `buildGmWrapperPrefix()` 的**产出**（真身字节），不是 ts 源文本 —— 这样注释里的
 * 「`c: 'xxx'`」不会误入（产出里只留注入体自身的注释），改包装也不会绕开这条检查。
 *
 * 匹配 `c: '<字面量>'`：包装层全部命令名都是字面量（无拼接、无 `.c =` 赋值；新增时也别拼接，
 * 否则本反射会静默漏掉 —— 真出现拼接，比对会以「登记表里的命令没有生产者」的形式红出来）。
 */
function producers(grant?: string[]): string[] {
  const src = buildGmWrapperPrefix({
    uuid: 'u-cmd',
    name: '命令面反射',
    values: { k: 'v' },
    info: info(),
    pageSecret: 'secret',
    ...(grant ? { grant } : {}),
  })
  const out = new Set<string>()
  for (const m of src.matchAll(/\bc:\s*'([A-Za-z][\w.]*)'/g)) out.add(m[1]!)
  return [...out].sort()
}

/** 契约登记表里的全部命令（键即命令名） */
const CONTRACT = Object.keys(API_COMMANDS).sort()

describe('桥命令面：登记表 ↔ 注入侧发送', () => {
  it('反射真的取到了命令（防反射锚点失效后「两边都空」的假绿）', () => {
    const sent = producers()
    expect(sent.length).toBeGreaterThan(20)
    expect(sent).toContain('store.get')
    expect(sent).toContain('fetch')
  })

  it('注入侧发出的命令都在契约里（SW 不会收到它不认识的命令）', () => {
    const sent = producers()
    const unknown = sent.filter((c) => !CONTRACT.includes(c))
    expect(unknown, `包装层发了契约里没有的命令：${unknown.join(', ')}`).toEqual([])
  })

  it('契约里的每条命令都有生产者（两侧严格相等，不留没人发的死命令）', () => {
    const sent = producers()
    const orphans = CONTRACT.filter((c) => !sent.includes(c))
    expect(
      orphans,
      `契约里有、注入侧从不发的命令：${orphans.join(', ')}` +
        '（要么是死命令该删，要么它的生产者在别的上下文 —— 那就在本文件里加一张带理由的白名单）',
    ).toEqual([])
  })

  it('@grant 裁剪不影响命令面（命令名恒在注入体里，与开哪些成员无关）', () => {
    expect(producers(['GM_getValue'])).toEqual(producers())
  })
})
