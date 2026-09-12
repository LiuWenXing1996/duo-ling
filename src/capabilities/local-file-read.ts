// local.file.read 的浏览器实现（一期离线能力示例）。
// 对应方案 §4.6：桌面版可静默读任意绝对路径，浏览器插件不行——
// 必须用户主动授权（<input type=file> 拖入 / 选择）。Firefox 不支持 showDirectoryPicker，用 input 兜底。
export async function readUserFile(file: File): Promise<{ name: string; content: string }> {
  const content = await file.text()
  return { name: file.name, content }
}
