// 拾取结论的暂存所：下发即返回，结论按标签页存在 session，载体重开时取回（设计见 ADR 0047）。

import type { ElementPickContext, PickState } from '@duoling/shared'

const FLIGHT_PREFIX = 'dl-pick-flight:'
const RESULT_PREFIX = 'dl-pick-result:'

export const PICK_TIMEOUT_MS = 60_000

export const PICK_TIMEOUT_MESSAGE = '拾取已取消：60 秒内未完成点选（页面可能已关闭或刷新）'

interface PickFlight {
  reqId: string
  startedAt: number
}

type PickOutcome = { element: ElementPickContext } | { message: string }

function sessionArea(): chrome.storage.StorageArea | null {
  try {
    return chrome?.storage?.session ?? null
  } catch {
    return null
  }
}

async function allKeys(): Promise<string[]> {
  const area = sessionArea()
  if (!area) return []
  try {
    return Object.keys((await area.get(null)) ?? {})
  } catch {
    return []
  }
}

export async function recordFlight(tabId: number, reqId: string, startedAt: number): Promise<void> {
  const area = sessionArea()
  if (!area) return
  try {
    await area.remove(RESULT_PREFIX + tabId)
    await area.set({ [FLIGHT_PREFIX + tabId]: { reqId, startedAt } satisfies PickFlight })
  } catch {
    return
  }
}

export async function findFlightTab(reqId: string): Promise<number | null> {
  const area = sessionArea()
  if (!area) return null
  for (const key of await allKeys()) {
    if (!key.startsWith(FLIGHT_PREFIX)) continue
    try {
      const bag = await area.get(key)
      const flight = bag?.[key] as PickFlight | undefined
      if (flight?.reqId === reqId) return Number(key.slice(FLIGHT_PREFIX.length))
    } catch {
      return null
    }
  }
  return null
}

export async function clearFlight(tabId: number, reqId?: string): Promise<void> {
  const area = sessionArea()
  if (!area) return
  const key = FLIGHT_PREFIX + tabId
  try {
    if (reqId != null) {
      const bag = await area.get(key)
      const flight = bag?.[key] as PickFlight | undefined
      if (flight && flight.reqId !== reqId) return
    }
    await area.remove(key)
  } catch {
    return
  }
}

export async function settlePick(
  tabId: number,
  reqId: string,
  outcome: PickOutcome,
): Promise<void> {
  const area = sessionArea()
  if (!area) return
  try {
    await clearFlight(tabId, reqId)
    await area.set({ [RESULT_PREFIX + tabId]: outcome })
  } catch {
    return
  }
}

export async function readPickState(tabId: number): Promise<PickState> {
  const area = sessionArea()
  if (!area) return { status: 'idle' }
  const resultKey = RESULT_PREFIX + tabId
  const flightKey = FLIGHT_PREFIX + tabId
  try {
    const bag = await area.get([resultKey, flightKey])
    const outcome = bag?.[resultKey] as PickOutcome | undefined
    if (outcome) {
      if ('element' in outcome) return { status: 'done', element: outcome.element }
      await area.remove(resultKey)
      return { status: 'error', message: outcome.message }
    }
    const flight = bag?.[flightKey] as PickFlight | undefined
    if (!flight) return { status: 'idle' }
    if (Date.now() - flight.startedAt < PICK_TIMEOUT_MS) return { status: 'picking' }
    await area.remove(flightKey)
    return { status: 'error', message: PICK_TIMEOUT_MESSAGE }
  } catch {
    return { status: 'idle' }
  }
}

export async function dropPickState(tabId: number): Promise<void> {
  const area = sessionArea()
  if (!area) return
  try {
    await area.remove([RESULT_PREFIX + tabId, FLIGHT_PREFIX + tabId])
  } catch {
    return
  }
}
