// gm-main 注入源 · 值存储段（页面世界**真源码**，esbuild 构建后经 gen 常量注入）。
// 同步快照读写（GM_VALUES 底座）、单键与批量写、批量取值口径（__gmPickValues）、
// 常驻值通道（读过值即建 Port + 全量校准）与值变更监听登记。
//
// 跨段引用（声明在 header / channel 段，同属一个注入作用域）用 declare const 标注 ——
// 类型只活在编译期，esbuild 擦掉声明、保留自由标识符，注入后按名命中同作用域的声明。
// 函数在本模块内「无人调用」是常态（使用方在同作用域的其他段与装配段），
// 故 tsconfig.main.json 对本目录关闭 noUnusedLocals。

declare const GM_VALUES: Record<string, any>
declare const __gmConnId: string
declare const NAME_PREFIX: string
declare const __gmConnect: () => void
declare const __gmWaitReady: () => Promise<void>
declare const __gmRegSend: (req: any) => Promise<any>
declare const __gmSend: (req: any) => Promise<any>
declare const __gmLog: (...args: unknown[]) => void

// —— 值缓存（同步读的底座）——
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

/**
 * 常驻通道：**读过值**就要把 Port 建起来，否则别的标签页写的新值永远到不了本实例，
 * 同步快照会整个页面生命周期陈旧。建立后补一次全量校准（覆盖 Port 就绪前的窗口）。
 */
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
        // 全量校准：跳过本实例还在飞行中的写（否则会用旧值覆盖本地刚写的）
        return __gmSend({ c: 'store.all' }).then(function (all) {
          var fresh = all || {}
          for (var k in fresh) if (Object.prototype.hasOwnProperty.call(fresh, k) && !__gmPendingWrites[k]) GM_VALUES[k] = fresh[k]
          for (var old in GM_VALUES) if (!Object.prototype.hasOwnProperty.call(fresh, old) && !__gmPendingWrites[old]) delete GM_VALUES[old]
        })
      })
      .then(resolve, function (e) {
        console.warn(NAME_PREFIX + ' 值通道未就绪（跨标签页变更暂不可见，同步读仍可用快照）：' + ((e && e.message) || e))
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
      __gmLog((isDelete ? 'GM_deleteValue' : 'GM_setValue') + ' 落盘失败：' + ((e && e.message) || e))
      throw e
    },
  )
}

/**
 * 批量写 / 批量删（GM_setValues / GM_deleteValues 的底座）。
 *
 * 与单键 __gmSetSync 的差别只在**请求次数**：本地镜像仍逐键改（同步读立刻可见），
 * 落盘走一条 store.setMany / store.deleteMany（服务端一个事务），变更事件在服务端逐键发。
 * 同步形态（GM_setValues）不关心返回值、失败只记日志；异步形态（GM.setValues）直接返回它。
 */
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
      __gmLog((isDelete ? 'GM_deleteValues' : 'GM_setValues') + ' 落盘失败：' + ((e && e.message) || e))
      throw e
    },
  )
}

/**
 * GM_getValues 的取值口径 —— 同步与异步两个形态**共用这一处**，免得两套语义：
 *   · 不给参数 → 整份存储；
 *   · 给键数组 → 只含**存在**的键（不存在的键不出现在结果里，对齐 TM）；
 *   · 给默认值对象 → 按它补缺，键存在时用真值。
 * 一律返回**新对象**：绝不把内部镜像透出去（脚本改它不该动到包装层的缓存）。
 */
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
  for (var d in keysOrDefaults) if (Object.prototype.hasOwnProperty.call(keysOrDefaults, d)) {
    out[d] = Object.prototype.hasOwnProperty.call(source, d) ? source[d] : keysOrDefaults[d]
  }
  return out
}
