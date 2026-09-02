import type { PendingPermission } from "./types.ts"

/**
 * In-memory registry of pending permission requests, keyed by the canonical
 * permission request ID.
 *
 * Guarantees required by the design:
 * - Insertion order is stable: oldest pending request first.
 * - Duplicate delivery of the same request ID is ignored.
 * - Enrichment applies only while the request is still pending (the
 *   resolution-before-enrichment race discards late enrichment).
 * - Removal is exact: resolving one request never removes sibling requests.
 */
export type PendingPatch = Partial<
  Pick<
    PendingPermission,
    "rootSessionID" | "originAgent" | "originTitle" | "toolName" | "sanitizedArgs" | "argsSource"
  >
>

export class PermissionTracker {
  #pending = new Map<string, PendingPermission>()

  get size(): number {
    return this.#pending.size
  }

  has(requestID: string): boolean {
    return this.#pending.has(requestID)
  }

  get(requestID: string): PendingPermission | undefined {
    return this.#pending.get(requestID)
  }

  /**
   * Inserts a request. Returns `false` when a request with the same ID is
   * already tracked (duplicate delivery) — the existing entry is preserved.
   */
  insert(request: PendingPermission): boolean {
    if (this.#pending.has(request.requestID)) return false
    this.#pending.set(request.requestID, request)
    return true
  }

  /** Ordered snapshot: oldest pending request first. */
  snapshot(): readonly PendingPermission[] {
    return Array.from(this.#pending.values())
  }

  /**
   * Applies an enrichment patch to a pending request. Returns `false` when
   * the request is no longer pending (resolved before enrichment completed).
   */
  enrich(requestID: string, patch: PendingPatch): boolean {
    const current = this.#pending.get(requestID)
    if (!current) return false
    this.#pending.set(requestID, { ...current, ...patch })
    return true
  }

  /** Removes exactly the matching request. Returns the removed request. */
  remove(requestID: string): PendingPermission | undefined {
    const removed = this.#pending.get(requestID)
    if (!removed) return undefined
    this.#pending.delete(requestID)
    return removed
  }

  /** Removes every request matching the predicate. Returns removed requests. */
  removeWhere(predicate: (request: PendingPermission) => boolean): PendingPermission[] {
    const removed: PendingPermission[] = []
    for (const [id, request] of this.#pending) {
      if (predicate(request)) {
        this.#pending.delete(id)
        removed.push(request)
      }
    }
    return removed
  }

  clear(): void {
    this.#pending.clear()
  }
}
