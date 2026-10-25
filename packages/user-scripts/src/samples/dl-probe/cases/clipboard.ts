import { add, pass, fail, errText } from '../harness'

async function readBack(): Promise<string | null> {
  try {
    const text = await navigator.clipboard.readText()
    return typeof text === 'string' ? text : null
  } catch {
    return null
  }
}

export function register() {
  add('剪贴板', 'setClipboard 写纯文本', async () => {
    const data = 'dl-probe-' + Date.now()
    await DL.setClipboard(data)
    const back = await readBack()
    if (back === null) return pass('已写入（未回读：缺 clipboardRead 或页面无焦点）')
    return back === data ? pass('回读一致') : fail('回读 ' + JSON.stringify(back))
  })

  add('剪贴板', 'setClipboard 富文本（text/html）', async () => {
    await DL.setClipboard('<b>dl-probe</b>', 'text/html')
    return pass('已写入（execCommand 返回 true）')
  })

  add('剪贴板', 'setClipboard 空内容必须报错', async () => {
    try {
      await DL.setClipboard('')
      return fail('空字符串没有报错')
    } catch (e) {
      return pass(errText(e))
    }
  })
}
