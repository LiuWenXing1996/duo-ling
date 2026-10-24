const POLL_INTERVAL_MS = 1000

export async function isUserScriptsAvailable(): Promise<boolean> {
  try {
    await chrome.userScripts.getScripts()
    return true
  } catch {
    return false
  }
}

export class UserScriptsAvailabilityWatch {
  #listeners = new Set<(available: boolean) => void>()
  #timer: ReturnType<typeof setInterval> | null = null
  #last: boolean | null = null

  subscribe(listener: (available: boolean) => void): () => void {
    this.#listeners.add(listener)
    this.#timer ??= setInterval(() => void this.#tick(), POLL_INTERVAL_MS)
    return () => {
      this.#listeners.delete(listener)
      if (this.#listeners.size) return
      if (this.#timer) clearInterval(this.#timer)
      this.#timer = null
      this.#last = null
    }
  }

  async #tick(): Promise<void> {
    const available = await isUserScriptsAvailable()
    if (this.#last !== null && available !== this.#last) {
      for (const listener of this.#listeners) listener(available)
    }
    this.#last = available
  }
}
