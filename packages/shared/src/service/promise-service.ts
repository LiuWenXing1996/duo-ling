/** 全 Promise 闸：同步签名的键落成 never，实现侧必然报错 */
export type PromiseService<T> = {
  [K in keyof T]: T[K] extends (...args: any[]) => Promise<any> ? T[K] : never
}
