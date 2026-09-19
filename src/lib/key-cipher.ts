// API Key 落盘加密（防扫描级，非保密级）。
//
// 定位：扩展拿不到系统钥匙串（Chrome 未提供 safeStorage 等价物），又不引入
// 用户口令方案，因此采用「安装期随机密钥 + AES-GCM」的静默加密：Key 不再以
// 明文出现在本地存储（duoling-app 库），可挡住备份同步、文件拷走后的明文扫描
// （grep `sk-` 等）。⚠️ 密钥同样存于本机，能读到存储的人就能解密——
// 这不是对抗本机恶意软件的防线，真实降损靠「子 Key + 额度上限 + 定期轮换」。
import * as appDb from './app-db'

const DEK_KEY = 'apiKeyDek'

/** AES-GCM 密文载荷（iv 与密文均 base64） */
export interface EncPayload {
  iv: string
  ct: string
}

/** 同一上下文内的密钥缓存；MV3 SW 被回收后下次调用重新从 storage 读取 */
let dekCache: CryptoKey | undefined
function toB64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s)
}

function fromB64(value: string): Uint8Array<ArrayBuffer> {
  const s = atob(value)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

/** 惰性获取（或首次生成）落盘加密密钥 */
async function getDek(): Promise<CryptoKey> {
  if (dekCache) return dekCache
  const raw = await appDb.get<string>(DEK_KEY)
  let bytes: Uint8Array<ArrayBuffer>
  if (raw) {
    bytes = fromB64(raw)
  } else {
    bytes = crypto.getRandomValues(new Uint8Array(32))
    await appDb.set(DEK_KEY, toB64(bytes))
  }
  dekCache = await crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ])
  return dekCache
}

export async function encryptApiKey(plain: string): Promise<EncPayload> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  // 经 Uint8Array 再包一层，规避新版 lib.dom 对 BufferSource 的泛型收窄
  const data = new Uint8Array(new TextEncoder().encode(plain))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await getDek(), data)
  return { iv: toB64(iv), ct: toB64(new Uint8Array(ct)) }
}

export async function decryptApiKey(payload: EncPayload): Promise<string> {
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64(payload.iv) },
    await getDek(),
    fromB64(payload.ct),
  )
  return new TextDecoder().decode(pt)
}

/** 密文载荷判别（读取时区分新老数据形态） */
export function isEncPayload(value: unknown): value is EncPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as EncPayload).iv === 'string' &&
    typeof (value as EncPayload).ct === 'string'
  )
}
