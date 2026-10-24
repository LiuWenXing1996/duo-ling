declare const GM_VALUES: Record<string, any>
declare const __gmConnId: string
declare const NAME_PREFIX: string
declare const __gmConnect: () => void
declare const __gmWaitReady: () => Promise<void>
declare const __gmRegSend: (req: any) => Promise<any>
declare const __gmSend: (req: any) => Promise<any>
declare const __gmLog: (...args: unknown[]) => void

var __gmPendingWrites: Record<string, boolean> = {}
function __gmHas(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(GM_VALUES, key)
}
function __gmGetSync(key: string, def: any): any {
  return __gmHas(key) ? GM_VALUES[key] : def
}
function __gmListSync(): string[] {
  return Object.keys(GM_VALUES)
}

var __gmChannelReady: Promise<void> | null = null
function __gmEnsureChannel(): Promise<void> {
  if (__gmChannelReady) return __gmChannelReady
  __gmChannelReady = new Promise<void>(function (resolve) {
    __gmConnect()
    __gmWaitReady()
      .then(function () {
        return __gmRegSend({ c: 'store.watchAll', connId: __gmConnId })
      })
      .then(function () {
        return __gmSend({ c: 'store.all' }).then(function (all) {
          var fresh = all || {}
          for (var k in fresh)
            if (Object.prototype.hasOwnProperty.call(fresh, k) && !__gmPendingWrites[k])
              GM_VALUES[k] = fresh[k]
          for (var old in GM_VALUES)
            if (!Object.prototype.hasOwnProperty.call(fresh, old) && !__gmPendingWrites[old])
              delete GM_VALUES[old]
        })
      })
      .then(resolve, function (e) {
        console.warn(
          NAME_PREFIX +
            ' 值通道未就绪（跨标签页变更暂不可见，同步读仍可用快照）：' +
            ((e && e.message) || e),
        )
        resolve()
      })
  })
  return __gmChannelReady
}

function __gmSetSync(key: string, value: any, isDelete: boolean): Promise<any> {
  if (isDelete) delete GM_VALUES[key]
  else GM_VALUES[key] = value
  __gmPendingWrites[key] = true
  var req = isDelete
    ? { c: 'store.delete', key: key, connId: __gmConnId }
    : { c: 'store.set', key: key, value: value, connId: __gmConnId }
  return __gmSend(req).then(
    function () {
      delete __gmPendingWrites[key]
    },
    function (e: any) {
      delete __gmPendingWrites[key]
      __gmLog(
        (isDelete ? 'GM_deleteValue' : 'GM_setValue') + ' 落盘失败：' + ((e && e.message) || e),
      )
      throw e
    },
  )
}

function __gmSetManySync(input: any, isDelete: boolean): Promise<any> {
  var keys: string[] = isDelete ? (input || []).slice() : Object.keys(input || {})
  if (!keys.length) return Promise.resolve()
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i]
    if (isDelete) delete GM_VALUES[k]
    else GM_VALUES[k] = input[k]
    __gmPendingWrites[k] = true
  }
  var req = isDelete
    ? { c: 'store.deleteMany', keys: keys, connId: __gmConnId }
    : { c: 'store.setMany', entries: input, connId: __gmConnId }
  return __gmSend(req).then(
    function () {
      for (var j = 0; j < keys.length; j++) delete __gmPendingWrites[keys[j]]
    },
    function (e: any) {
      for (var j = 0; j < keys.length; j++) delete __gmPendingWrites[keys[j]]
      __gmLog(
        (isDelete ? 'GM_deleteValues' : 'GM_setValues') + ' 落盘失败：' + ((e && e.message) || e),
      )
      throw e
    },
  )
}

function __gmPickValues(source: any, keysOrDefaults: any): Record<string, any> {
  var out: Record<string, any> = {}
  if (keysOrDefaults == null) {
    for (var k in source) if (Object.prototype.hasOwnProperty.call(source, k)) out[k] = source[k]
    return out
  }
  if (Array.isArray(keysOrDefaults)) {
    for (var i = 0; i < keysOrDefaults.length; i++) {
      var key = keysOrDefaults[i]
      if (Object.prototype.hasOwnProperty.call(source, key)) out[key] = source[key]
    }
    return out
  }
  for (var d in keysOrDefaults)
    if (Object.prototype.hasOwnProperty.call(keysOrDefaults, d)) {
      out[d] = Object.prototype.hasOwnProperty.call(source, d) ? source[d] : keysOrDefaults[d]
    }
  return out
}
