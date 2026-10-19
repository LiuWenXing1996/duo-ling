// 网络组 · 请求体与响应形态：从「GM 能力 API 二轮」并过来 —— 请求体的 FormData / Blob 形态，
// 以及 responseType 取 blob() 的正反例。
import { BASE, add, fail, gmFetch, netFail, pass } from '../harness'

export function register() {
  add('网络', 'FormData 请求体（文本 + 文件字段）', function () {
    const fd = new FormData()
    fd.set('field1', 'hello')
    fd.set('num', '42')
    fd.set('note', new File(['file-body-xyz'], 'note.txt', { type: 'text/plain' }))
    return gmFetch(BASE + '/post', { method: 'POST', body: fd, responseType: 'json' }).then(
      function (r) {
        if (!r.ok) return fail('靶站非 2xx: ' + r.status)
        const d = r.json() as { form: Record<string, string>; files?: Record<string, string> }
        if (d.form.field1 !== 'hello' || d.form.num !== '42')
          return fail('文本字段未回显: ' + JSON.stringify(d.form))
        if (!d.files || d.files.note !== 'file-body-xyz')
          return fail('文件字段未回显: ' + JSON.stringify(d.files))
        return pass('form=' + JSON.stringify(d.form) + ' file=' + d.files.note)
      },
      function (e) {
        return netFail(e)
      },
    )
  })

  add('网络', 'Blob 请求体', function () {
    return gmFetch(BASE + '/post', {
      method: 'POST',
      body: new Blob(['rawblobdata'], { type: 'application/octet-stream' }),
      responseType: 'json',
    }).then(
      function (r) {
        if (!r.ok) return fail('非 2xx: ' + r.status)
        const data = (r.json() as { data?: unknown }).data
        return data === 'rawblobdata'
          ? pass('data=' + data)
          : fail('raw body 未回显: ' + JSON.stringify(data))
      },
      function (e) {
        return netFail(e)
      },
    )
  })

  add('网络', 'blob() 响应（64 字节二进制）', function () {
    return gmFetch(BASE + '/bytes/64', { responseType: 'arraybuffer' }).then(
      function (r) {
        if (!r.ok) return fail('非 2xx: ' + r.status)
        const blob = r.blob()
        if (!(blob instanceof Blob)) return fail('blob() 返回值不是 Blob')
        return blob.size === 64
          ? pass('size=' + blob.size + ' type=' + (blob.type || '（空）'))
          : fail('size 错: ' + blob.size)
      },
      function (e) {
        return netFail(e)
      },
    )
  })

  add('网络', 'blob() 负例（text 模式抛错）', function () {
    return gmFetch(BASE + '/get').then(
      function (r) {
        let threw = false
        try {
          r.blob()
        } catch (e) {
          threw = /responseType/i.test((e as Error).message)
        }
        return threw ? pass('已按预期抛错') : fail('text 模式竟能调 blob()')
      },
      function (e) {
        return netFail(e)
      },
    )
  })
}
