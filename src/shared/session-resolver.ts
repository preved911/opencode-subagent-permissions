/**
 * Resolves a requesting session up to its root by walking `parentID` links,
 * deriving the origin agent name and session title from actual session data.
 *
 * - The request `sessionID` is the source of truth.
 * - Missing parents, lookup failures and cycles degrade gracefully: the
 *   resolver never guesses, the UI labels unresolved origins explicitly.
 * - A bounded memo keeps repeat lookups cheap; `invalidate` drops entries
 *   (e.g. on `session.deleted`).
 */
export type SessionLike = {
  id: string
  parentID?: string
  agent?: string
  title?: string
}

export type OriginInfo = {
  rootSessionID: string | undefined
  /** Chain from the requesting session up to the resolved root (inclusive). */
  chain: readonly string[]
  originAgent: string | undefined
  originTitle: string | undefined
}

export const DEFAULT_RESOLVER_MEMO_LIMIT = 256

export class SessionResolver {
  #fetch: (sessionID: string) => Promise<SessionLike | null | undefined>
  #memo = new Map<string, SessionLike | null>()
  #inflight = new Map<string, Promise<SessionLike | null>>()
  #memoLimit: number

  constructor(
    fetch: (sessionID: string) => Promise<SessionLike | null | undefined>,
    memoLimit: number = DEFAULT_RESOLVER_MEMO_LIMIT,
  ) {
    this.#fetch = fetch
    this.#memoLimit = memoLimit
  }

  /** Cached session record, or `undefined` when never resolved. */
  cached(sessionID: string): SessionLike | null | undefined {
    return this.#memo.get(sessionID)
  }

  /** Cached chain for a session, or `undefined` when not resolved yet. */
  cachedChain(sessionID: string): readonly string[] | undefined {
    const cached = this.#memo.get(sessionID)
    if (cached === undefined) return undefined
    const chain: string[] = []
    const visited = new Set<string>()
    let cursor: SessionLike | null | undefined = cached
    let currentID: string = sessionID
    while (cursor) {
      if (visited.has(currentID)) break
      visited.add(currentID)
      chain.push(currentID)
      const parentID = cursor.parentID
      if (!parentID) break
      currentID = parentID
      cursor = this.#memo.get(parentID)
      if (cursor === undefined) return undefined // chain incomplete
    }
    return chain
  }

  async #load(sessionID: string): Promise<SessionLike | null> {
    const cached = this.#memo.get(sessionID)
    if (cached !== undefined) return cached
    const inflight = this.#inflight.get(sessionID)
    if (inflight) return inflight
    const promise = (async () => {
      let record: SessionLike | null
      try {
        const fetched = await this.#fetch(sessionID)
        record = fetched ?? null
      } catch {
        record = null
      }
      // Bound the memo: drop the oldest entry when full.
      if (this.#memo.size >= this.#memoLimit) {
        const oldest = this.#memo.keys().next()
        if (!oldest.done) this.#memo.delete(oldest.value)
      }
      this.#memo.set(sessionID, record)
      this.#inflight.delete(sessionID)
      return record
    })()
    this.#inflight.set(sessionID, promise)
    return promise
  }

  /** Resolves the full origin info for a requesting session. */
  async resolve(requestSessionID: string): Promise<OriginInfo> {
    const chain: string[] = []
    const visited = new Set<string>()
    let currentID: string | undefined = requestSessionID

    while (currentID && !visited.has(currentID)) {
      visited.add(currentID)
      const session = await this.#load(currentID)
      // Unresolvable sessions never enter the chain: the last successfully
      // loaded session is reported as root, never a guess.
      if (!session) break
      chain.push(currentID)
      currentID = session.parentID
    }

    const rootSessionID = chain.length > 0 ? (chain[chain.length - 1] as string) : undefined
    const requesting = await this.#load(requestSessionID)
    return {
      rootSessionID,
      chain,
      originAgent: requesting?.agent,
      originTitle: requesting?.title,
    }
  }

  /** Drops one session from the memo, or the whole memo when omitted. */
  invalidate(sessionID?: string): void {
    if (sessionID === undefined) {
      this.#memo.clear()
      return
    }
    this.#memo.delete(sessionID)
  }
}
