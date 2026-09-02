import {
  ARGS_UNAVAILABLE_MARKER,
  normalizePatterns,
  type ArgsSource,
  type PendingPermission,
} from "./types.ts"
import { sanitizeArgs } from "./sanitize.ts"

/**
 * Pure view-model logic for the TUI overlay panel. The Solid component in
 * `src/tui.tsx` wires OpenCode's reactive stores into these functions; the
 * functions themselves are plain and unit-testable ("UI tests").
 */

/** Minimal structural subset of the v2 `PermissionRequest` the panel needs. */
export type PermissionRequestLike = {
  id: string
  sessionID: string
  permission: string
  patterns: readonly string[]
  metadata: { readonly [key: string]: unknown }
  tool?: { readonly messageID: string; readonly callID: string }
}

export type ArgsLookupResult = {
  value: unknown
  source: ArgsSource
}

export type PanelLookups = {
  /**
   * Returns the sanitized arguments for a request, preferring the tool part
   * (session tool call) over permission metadata. Must not throw.
   */
  argsOf(request: PermissionRequestLike): ArgsLookupResult
  /**
   * Chain from the request's session up to its resolved root, or `undefined`
   * while resolution is still in flight. May be partial.
   */
  chainOf(sessionID: string): readonly string[] | undefined
  /** Origin info from the resolved requesting session, when available. */
  originOf(sessionID: string): { agent: string | undefined; title: string | undefined } | undefined
  /** First-seen clock for stable ordering of newly observed requests. */
  now(): number
}

/**
 * Selects the requests visible in the ROOT session view: a request belongs to
 * the panel of the root of its session tree. Requests whose chain has not
 * resolved yet are shown only when they target the viewed session directly.
 */
export function selectVisibleRequests(
  requests: readonly PermissionRequestLike[],
  viewedSessionID: string,
  chainOf: (sessionID: string) => readonly string[] | undefined,
): PermissionRequestLike[] {
  return requests.filter((request) => {
    if (request.sessionID === viewedSessionID) return true
    const chain = chainOf(request.sessionID)
    if (!chain || chain.length === 0) return false
    return chain[chain.length - 1] === viewedSessionID
  })
}

/**
 * Independent tool name when the permission itself is not the tool name
 * (e.g. `doom_loop` carries `metadata.tool`). MCP tools keep their generated
 * OpenCode name as the permission type.
 */
function toolNameOf(request: PermissionRequestLike): string | undefined {
  const candidate = request.metadata["tool"]
  if (typeof candidate === "string" && candidate.length > 0 && candidate !== request.permission) {
    return candidate
  }
  return undefined
}

function isToolPartWithInput(value: unknown): value is { callID: string; state: { input: unknown } } {
  if (typeof value !== "object" || value === null) return false
  const record = value as { type?: unknown; callID?: unknown; state?: unknown }
  if (record.type !== "tool" || typeof record.callID !== "string") return false
  if (typeof record.state !== "object" || record.state === null) return false
  if (!("input" in record.state)) return false
  return typeof (record.state as { input?: unknown }).input === "object"
}

/**
 * Argument resolution shared by the panel: prefer the session tool part
 * (fullest, matches the native permission prompt), then permission metadata,
 * then an explicit "unavailable" state. Consumes raw parts structurally —
 * no casts — so the native v1 `Part` union can be passed as-is.
 */
export function createArgsLookup(
  partsOf: (messageID: string) => readonly unknown[] | undefined,
): (request: PermissionRequestLike) => ArgsLookupResult {
  return (request) => {
    const tool = request.tool
    if (tool) {
      const parts = partsOf(tool.messageID)
      if (parts) {
        for (const part of parts) {
          if (!isToolPartWithInput(part)) continue
          if (part.callID !== tool.callID) continue
          return { value: sanitizeArgs(part.state.input), source: "session-parts" }
        }
      }
    }
    if (Object.keys(request.metadata).length > 0) {
      return { value: sanitizeArgs(request.metadata), source: "permission-metadata" }
    }
    return { value: undefined, source: "unavailable" }
  }
}

/**
 * Converts native permission requests into the internal `PendingPermission`
 * display model in arrival order. `firstSeen` keeps ordering stable across
 * re-renders; unseen requests get `now()` plus their arrival index.
 */
export function toPendingRequests(
  requests: readonly PermissionRequestLike[],
  lookups: PanelLookups,
  firstSeen: ReadonlyMap<string, number> = new Map(),
): PendingPermission[] {
  const now = lookups.now()
  return requests.map((request, index) => {
    const args = lookups.argsOf(request)
    const chain = lookups.chainOf(request.sessionID)
    const origin = lookups.originOf(request.sessionID)
    const createdAt = firstSeen.get(request.id) ?? now + index
    return {
      requestID: request.id,
      requestSessionID: request.sessionID,
      rootSessionID: chain && chain.length > 0 ? (chain[chain.length - 1] as string) : undefined,
      originAgent: origin?.agent,
      originTitle: origin?.title,
      permission: request.permission,
      toolName: toolNameOf(request),
      callID: request.tool?.callID,
      patterns: normalizePatterns(request.patterns),
      sanitizedArgs: args.value,
      argsSource: args.source,
      createdAt,
    } satisfies PendingPermission
  })
}

/** Marker string the panel renders when args could not be resolved. */
export const ARGS_UNAVAILABLE = ARGS_UNAVAILABLE_MARKER
