import { add, pass, fail, unknown, errText } from '../harness'

const CLICK_KEY = 'dlp_notify_clicked'

export function register() {
  add('通知', 'notify 返回 id（title / icon 走宿主兜底）', async () => {
    const id = await DL.notify({ text: 'dl-probe ' + Date.now() })
    return typeof id === 'string' && id.length ? pass(id) : fail('id = ' + String(id))
  })

  add('通知', 'notify text 非字符串必须报错', async () => {
    try {
      await DL.notify({ text: 123 })
      return fail('非字符串 text 没有报错')
    } catch (e) {
      return pass(errText(e))
    }
  })

  add('通知', 'onclick 点击回推', async () => {
    try {
      if (localStorage.getItem(CLICK_KEY)) {
        localStorage.removeItem(CLICK_KEY)
        return pass('上次点击已回推到脚本')
      }
    } catch {}
    const id = await DL.notify({
      text: '点掉这条通知，再点一次「跑全部」',
      title: 'DL 探针',
      onclick: () => {
        try {
          localStorage.setItem(CLICK_KEY, '1')
        } catch {}
      },
    })
    return unknown('已发 ' + id + '：点掉它再跑一次')
  })
}
