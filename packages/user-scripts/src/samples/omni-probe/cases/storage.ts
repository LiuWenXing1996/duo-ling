// 存储组：单键读写删（同步 / Promise 两形态）、批量形态、值变更监听。
import { PFX, add, fail, pass, sleep } from '../harness'

const K = PFX + 'k'

export function register() {
  add('存储', 'GM_setValue → GM_getValue（同步）', function () {
    GM_setValue(K, 'v1')
    const got = GM_getValue(K, '__none__')
    // 同步读走注入时的本地快照 + 写时更新的缓存，故写后**立即**读应命中
    return got === 'v1' ? pass('同步读命中本实例刚写的值') : fail('读回 ' + JSON.stringify(got))
  })

  add('存储', 'GM.setValue → GM.getValue（异步过桥）', async function () {
    await GM.setValue(K, 'v2')
    const got = await GM.getValue(K, '__none__')
    // 异步形态每次回后台读，读到 v2 才证明桥真通（同步形态读快照，证明不了）
    return got === 'v2' ? pass('异步读回后台真值 v2') : fail('读回 ' + JSON.stringify(got))
  })

  add('存储', 'GM_listValues / GM.listValues', async function () {
    const syncKeys = GM_listValues()
    const asyncKeys = await GM.listValues()
    const inSync = syncKeys.indexOf(K) >= 0
    const inAsync = asyncKeys.indexOf(K) >= 0
    return inSync && inAsync ? pass('两形态都含探针键（共 ' + asyncKeys.length + ' 键）') : fail('同步含=' + inSync + ' 异步含=' + inAsync)
  })

  add('存储', 'GM_deleteValue / GM.deleteValue', async function () {
    // ⚠️ 本用例刻意**逐步 await**：它验的是「两形态都能删」，不是写序。不等的话会撞上 SW 值存储的
    // 写序竞争 —— 同步形态是 fire-and-forget（本地缓存先改、桥不等应答），连着发的几条命令在 SW 里
    // 并发落盘，而 deleteGMValue 读到「键不存在」会提前返回 → 后到的 set 把值留在了盘上，
    // 用例会（✓/✗）摇摆。
    await GM.setValue(K, 'v3')
    GM_deleteValue(K)
    const syncLocal = GM_getValue(K, '__none__') === '__none__' // 同步形态：本地缓存立刻生效
    await sleep(500) // 让那次不等应答的删除过桥落盘
    const syncBridge = (await GM.getValue(K, '__none__')) === '__none__' // 后台也真没了
    await GM.setValue(K, 'v4')
    await GM.deleteValue(K)
    const asyncGone = (await GM.getValue(K, '__none__')) === '__none__'
    return syncLocal && syncBridge && asyncGone
      ? pass('两形态删后都读不到（本地缓存 + 后台两层都验）')
      : fail('本地=' + syncLocal + ' 过桥=' + syncBridge + ' 异步=' + asyncGone)
  })

  add('存储', '批量读写删（同步形态）', function () {
    // 同步形态是 fire-and-forget（本地缓存先改、桥不等应答），故这里只验**本地快照**是否立刻正确
    // ——落盘正确性归下面那条 Promise 形态的用例验（同 deleteValue 用例的坑，见那里的长注释）。
    const ka = PFX + 'ba', kb = PFX + 'bb'
    const batch: Record<string, unknown> = {}
    batch[ka] = 1
    batch[kb] = 2
    GM_setValues(batch)
    const picked = GM_getValues([ka, PFX + 'missing'])
    const whole = GM_getValues()
    const defaults: Record<string, unknown> = {}
    defaults[ka] = 99
    defaults[PFX + 'missing'] = 9
    const filled = GM_getValues(defaults)
    GM_deleteValues([ka, kb])
    const after = GM_getValues()
    return picked[ka] === 1 && !(PFX + 'missing' in picked) && whole[kb] === 2 &&
      filled[ka] === 1 && filled[PFX + 'missing'] === 9 && !(ka in after) && !(kb in after)
      ? pass('数组只回存在的键 / 默认值对象补缺 / 无参取全量 / 批量删本地立即可见')
      : fail('picked=' + JSON.stringify(picked) + ' filled=' + JSON.stringify(filled) + ' after=' + JSON.stringify(after))
  })

  add('存储', '批量读写删（Promise 形态）', async function () {
    // 异步形态读的是后台真值，能证明批量写真的落了盘（且是一个事务）
    const ka = PFX + 'p1', kb = PFX + 'p2'
    const batch: Record<string, unknown> = {}
    batch[ka] = 'a'
    batch[kb] = 'b'
    await GM.setValues(batch)
    const byKeys = await GM.getValues([ka, kb, PFX + 'pMissing'])
    const defaults: Record<string, unknown> = {}
    defaults[ka] = '__default__'
    defaults[PFX + 'pMissing'] = 9
    const filled = await GM.getValues(defaults)
    const whole = await GM.getValues()
    await GM.deleteValues([ka, kb])
    const after = await GM.getValues([ka, kb])
    return byKeys[ka] === 'a' && byKeys[kb] === 'b' && !(PFX + 'pMissing' in byKeys) &&
      filled[ka] === 'a' && filled[PFX + 'pMissing'] === 9 && whole[ka] === 'a' &&
      Object.keys(after).length === 0
      ? pass('过桥读写：数组 / 默认值对象 / 无参 / 批量删都正确')
      : fail('byKeys=' + JSON.stringify(byKeys) + ' filled=' + JSON.stringify(filled) + ' after=' + JSON.stringify(after))
  })

  add('存储', 'GM_addValueChangeListener / GM_removeValueChangeListener', async function () {
    const seen: Array<{ key: string; oldV: unknown; newV: unknown; remote: unknown }> = []
    const id = GM_addValueChangeListener(K, function (key, oldV, newV, remote) {
      seen.push({ key: key, oldV: oldV, newV: newV, remote: remote })
    })
    if (typeof id !== 'number') throw new Error('GM_addValueChangeListener 没返回数字 id')
    await GM.setValue(K, 'w1')
    await sleep(400) // 等 Port 下行把 store.change 推回来
    GM_removeValueChangeListener(id)
    await GM.setValue(K, 'w2')
    await sleep(400) // 摘除后不该再来一条
    const first = seen[0]
    const ok = seen.length === 1 && first && first.newV === 'w1' && first.remote === false
    return ok
      ? pass('收到 1 条（本实例写 remote=false），摘除后不再收')
      : fail('收到 ' + seen.length + ' 条，首条=' + JSON.stringify(first || null))
  })

  add('存储', 'GM.addValueChangeListener / GM.removeValueChangeListener', async function () {
    let got: unknown = null
    const id = await GM.addValueChangeListener(K, function (_key, _oldV, newV) { got = newV })
    if (typeof id !== 'number') throw new Error('GM.addValueChangeListener 没 resolve 出数字 id')
    await GM.setValue(K, 'w3')
    await sleep(300)
    GM.removeValueChangeListener(id)
    return got === 'w3' ? pass('GM.* 形态收到回调并摘除') : fail('回调收到 ' + JSON.stringify(got))
  })
}
