/**
 * Bounded in-memory cache of sanitized tool invocation snapshots.
 *
 * Keys are `(sessionID, callID)`. Entries expire after a TTL (default 10
 * minutes) and the cache evicts the oldest entries beyond a maximum count
 * (default 500) so unbounded sessions cannot grow memory.
 *
 * The cache stores only sanitized values — raw arguments never enter it.
 */
export type InvocationCacheLimits = {
  ttlMs: number
  maxEntries: number
}

export const DEFAULT_INVOCATION_CACHE_LIMITS: InvocationCacheLimits = {
  ttlMs: 10 * 60 * 1000,
  maxEntries: 500,
}

type Entry = {
  sessionID: string
  callID: string
  value: unknown
  expiresAt: number
}

const KEY_SEPARATOR = "\u0000"

function compositeKey(sessionID: string, callID: string): string {
  return `${sessionID}${KEY_SEPARATOR}${callID}`
}

export class ToolInvocationCache {
  #limits: InvocationCacheLimits
  #entries = new Map<string, Entry>()
  #now: () => number

  constructor(limits: Partial<InvocationCacheLimits> = {}, now: () => number = Date.now) {
    this.#limits = { ...DEFAULT_INVOCATION_CACHE_LIMITS, ...limits }
    this.#now = now
  }

  get size(): number {
    return this.#entries.size
  }

  /** Stores a sanitized snapshot, refreshing recency for the key. */
  put(sessionID: string, callID: string, value: unknown): void {
    this.prune()
    const key = compositeKey(sessionID, callID)
    // Re-insert to move the key to the back of the insertion order.
    this.#entries.delete(key)
    this.#entries.set(key, {
      sessionID,
      callID,
      value,
      expiresAt: this.#now() + this.#limits.ttlMs,
    })
    while (this.#entries.size > this.#limits.maxEntries) {
      const oldest = this.#entries.keys().next()
      if (oldest.done) break
      this.#entries.delete(oldest.value)
    }
  }

  /** Returns the live snapshot for the key without removing it. */
  peek(sessionID: string, callID: string): unknown | undefined {
    const entry = this.#entries.get(compositeKey(sessionID, callID))
    if (!entry) return undefined
    if (entry.expiresAt <= this.#now()) return undefined
    return entry.value
  }

  /** Returns and deletes the snapshot — used when attaching it to a request. */
  take(sessionID: string, callID: string): unknown | undefined {
    const key = compositeKey(sessionID, callID)
    const entry = this.#entries.get(key)
    if (!entry) return undefined
    this.#entries.delete(key)
    if (entry.expiresAt <= this.#now()) return undefined
    return entry.value
  }

  /** Drops one entry (e.g. after the tool finished or failed). */
  drop(sessionID: string, callID: string): void {
    this.#entries.delete(compositeKey(sessionID, callID))
  }

  /** Removes every entry belonging to any of the given session IDs. */
  clearSessionTree(sessionIDs: ReadonlySet<string>): number {
    let removed = 0
    for (const [key, entry] of this.#entries) {
      if (sessionIDs.has(entry.sessionID)) {
        this.#entries.delete(key)
        removed++
      }
    }
    return removed
  }

  /** Removes expired entries. */
  prune(): number {
    const now = this.#now()
    let removed = 0
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) {
        this.#entries.delete(key)
        removed++
      }
    }
    return removed
  }

  clear(): void {
    this.#entries.clear()
  }
}
