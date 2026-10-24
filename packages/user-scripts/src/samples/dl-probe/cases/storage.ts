import { add, pass, fail, unknown, PFX } from '../harness'

const KA = PFX + 'a'
const KB = PFX + 'b'
const KC = PFX + 'c'
const MISSING = PFX + 'missing'

interface Change {
  key: string
  oldValue: unknown
  newValue: unknown
  remote: boolean
}

function once(key: string, act: () => Promise<void>): Promise<Change | null> {
  return new Promise((resolve) => {
    const id = DL.addValueChangeListener(
      key,
      (k: string, o: unknown, n: unknown, remote: boolean) => {
        DL.removeValueChangeListener(id)
        resolve({ key: k, oldValue: o, newValue: n, remote })
      },
    )
    setTimeout(() => {
      DL.removeValueChangeListener(id)
      resolve(null)
    }, 5000)
    act().catch(() => {})
  })
}

function sleep(ms: number) {
  return new Promise<void>((r) => {
    setTimeout(r, ms)
  })
}

export function register() {
  add('存储', 'setValue / getValue 往返（对象值）', async () => {
    await DL.setValue(KA, { n: 1, s: 'x' })
    const v = await DL.getValue(KA)
    return v && v.n === 1 && v.s === 'x' ? pass('{n:1,s:x}') : fail(JSON.stringify(v))
  })

  add('存储', 'getValue 缺省值（键不存在）', async () => {
    const v = await DL.getValue(MISSING, 'def')
    return v === 'def' ? pass('def') : fail('实际 ' + JSON.stringify(v))
  })

  add('存储', 'listValues 含已写入的键', async () => {
    const keys = await DL.listValues()
    return keys.indexOf(KA) >= 0 ? pass(keys.length + ' 个键') : fail(JSON.stringify(keys))
  })

  add('存储', 'getValues(键数组) 只回有值的', async () => {
    const v = await DL.getValues([KA, MISSING])
    const ok = v[KA] && v[KA].n === 1 && !(MISSING in v)
    return ok ? pass('1 有 1 无') : fail(JSON.stringify(v))
  })

  add('存储', 'getValues() 无参给全量', async () => {
    const all = await DL.getValues()
    const keys = Object.keys(all)
    return all[KA] !== undefined ? pass(keys.length + ' 个键') : fail(JSON.stringify(keys))
  })

  add('存储', 'getValues(默认值对象) 按默认补缺', async () => {
    const v = await DL.getValues({ [KA]: { n: 0 }, [MISSING]: 'fallback' })
    const ok = v[KA] && v[KA].n === 1 && v[MISSING] === 'fallback'
    return ok ? pass('命中取真值、缺失取默认') : fail(JSON.stringify(v))
  })

  add('存储', 'setValues 批量写', async () => {
    await DL.setValues({ [KB]: 2, [KC]: 3 })
    const v = await DL.getValues([KB, KC])
    return v[KB] === 2 && v[KC] === 3 ? pass('2 个键') : fail(JSON.stringify(v))
  })

  add('存储', 'deleteValue 后读不到', async () => {
    await DL.deleteValue(KB)
    const v = await DL.getValue(KB, '<none>')
    return v === '<none>' ? pass('已删') : fail('仍是 ' + JSON.stringify(v))
  })

  add('存储', 'deleteValues 批量删', async () => {
    await DL.deleteValues([KA, KC])
    const keys = await DL.listValues()
    const left = keys.filter((k: string) => k === KA || k === KC)
    return left.length === 0 ? pass('已删 2 个') : fail('残留 ' + JSON.stringify(left))
  })

  add('存储', 'setValue(k, null) 等同删键', async () => {
    await DL.setValue(KB, 9)
    await DL.setValue(KB, null)
    const v = await DL.getValue(KB, '<none>')
    return v === '<none>' ? pass('null 落成删键') : fail('仍是 ' + JSON.stringify(v))
  })

  add('存储', 'addValueChangeListener 收到本地变更', async () => {
    const r = await once(KA, () => DL.setValue(KA, 7))
    if (!r) return fail('5s 内没收到变更事件（DL 通道没通？）')
    const ok = r.key === KA && r.newValue === 7 && r.remote === false
    return ok ? pass('remote=false') : fail(JSON.stringify(r))
  })

  add('存储', 'removeValueChangeListener 后不再触发', async () => {
    let fired = 0
    const id = DL.addValueChangeListener(KA, () => {
      fired++
    })
    DL.removeValueChangeListener(id)
    await DL.setValue(KA, 8)
    await sleep(1200)
    return fired === 0 ? pass('注销后 0 次') : fail('仍然触发 ' + fired + ' 次')
  })

  add('存储', '与 GM 面存储不互通（预期 ✓：两个库）', async () => {
    if (typeof GM_getValue !== 'function') return unknown('没有 @grant GM_getValue，跳过对照')
    await DL.setValue(PFX + 'iso', 'dl-only')
    const gm = GM_getValue(PFX + 'iso')
    await DL.deleteValue(PFX + 'iso')
    return gm === undefined ? pass('DL 写的键 GM 读不到') : fail('GM 读到了 ' + JSON.stringify(gm))
  })
}
