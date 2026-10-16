// 脚本归档（zip）跨语境搬运用的三个纯函数：字节 ↔ base64、目录 / 文件名安全化。
//
// 为什么归 shared：导出侧（offscreen 打包）与导入 / 下载侧（工作台面板）必须同源 ——
// 下载文件名与包内目录名同一套规则、字节往返逐字节保真；各自写一份迟早会漂。
// 面板只取这三个纯函数，不该为它们 import 整个文件库（那会把 git 栈拖进扩展页产物）。

/** 目录名 / 文件名长度上限（超长截断，防极端名称撑爆解压路径与下载名） */
const DIR_NAME_MAX = 64

/** 名字安全化：替换 Windows 保留字符与控制符、去结尾点/空白、截断；空值兜底 */
export function sanitizeDirName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/[\s.]+$/, '')
    .trim()
    .slice(0, DIR_NAME_MAX)
  return cleaned || 'script'
}

/** Uint8Array → base64（分块避免 String.fromCharCode 爆栈；zip 几 MB 也在安全余量内） */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

/** base64 → Uint8Array（与 bytesToBase64 互为逆；offscreen 解码入口用） */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
