// 打开（false = 没接上）走件的后台命令 float.open，探活查它在不在册；旧桥已拔，见 ADR 0046。

import { FLOAT_HOST_ID, FLOAT_HOST_OPEN_COMMAND } from '@duoling/user-scripts/builtin'
import { dlRuntimePort } from '../host-config'

export async function openFloatPanel(tabId: number): Promise<boolean> {
  const runtime = dlRuntimePort()
  if (!runtime) return false
  try {
    await runtime.invokeBackgroundCommand(tabId, FLOAT_HOST_ID, FLOAT_HOST_OPEN_COMMAND, { tabId })
    return true
  } catch {
    return false
  }
}

export function isFloatHostReady(tabId: number): boolean {
  const runtime = dlRuntimePort()
  if (!runtime) return false
  return runtime
    .listBackgroundCommands(tabId, FLOAT_HOST_ID)
    .some((cmd) => cmd.name === FLOAT_HOST_OPEN_COMMAND)
}
