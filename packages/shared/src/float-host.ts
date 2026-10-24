export interface FloatHostMessage {
  cmd: 'collapse' | 'busy'
  busy?: boolean
}
