/**
 * Shared types for the subagent permission overlay plugin.
 *
 * Shape of `PendingPermission` follows the design contract, adapted to the
 * exact fields exposed by the installed OpenCode SDK (1.18.25):
 *
 * - `Permission` (permission.ask hook input) carries a canonical request `id`,
 *   `sessionID`, `callID?`, permission `type`, `pattern?: string | string[]`
 *   and `metadata`.
 * - The v2 `PermissionRequest` (TUI state / `client.permission.list`) carries
 *   `id`, `sessionID`, `permission`, `patterns`, `metadata` and
 *   `tool?: { messageID; callID }`.
 */

/**
 * Where displayed invocation arguments came from.
 *
 * - `tool-cache`: snapshot captured by the server plugin in
 *   `tool.execute.before` (fullest context).
 * - `session-parts`: tool input read from the session tool part by
 *   `(messageID, callID)` — the same source the native TUI permission prompt
 *   uses.
 * - `permission-metadata`: sanitized `permission.metadata` fallback.
 * - `unavailable`: nothing could be captured; UI must say so explicitly.
 */
export type ArgsSource = "tool-cache" | "session-parts" | "permission-metadata" | "unavailable"

export type PendingPermission = {
  /** Canonical permission request ID (primary key). */
  requestID: string
  /** Session that raised the request (source of truth for origin resolution). */
  requestSessionID: string
  /** Root session of the requesting tree, when it could be resolved. */
  rootSessionID: string | undefined
  /** Agent name of the requesting session, when known. */
  originAgent: string | undefined
  /** Title of the requesting session, when known. */
  originTitle: string | undefined
  /** Permission type, e.g. `bash`, `edit`, or a generated MCP tool name. */
  permission: string
  /** Tool display name when it can be determined independently of `permission`. */
  toolName: string | undefined
  /** Tool call ID carried by the permission request, when present. */
  callID: string | undefined
  patterns: readonly string[]
  /** Sanitized, bounded display payload. Never raw arguments. */
  sanitizedArgs: unknown | undefined
  argsSource: ArgsSource
  /** First-seen time (ms epoch) — used for stable oldest-first ordering. */
  createdAt: number
}

export type SanitizeLimits = {
  maxDepth: number
  maxItems: number
  maxStringLength: number
  maxTotalBytes: number
  maxCompactLength: number
}

export const DEFAULT_SANITIZE_LIMITS: SanitizeLimits = {
  maxDepth: 6,
  maxItems: 50,
  maxStringLength: 2_000,
  maxTotalBytes: 16 * 1024,
  maxCompactLength: 240,
}

/** Marker rendered when a payload could not be sanitized at all. */
export const SANITIZE_FAILED_MARKER = "[Arguments unavailable from OpenCode]"

/** Marker rendered when nothing captured the invocation arguments. */
export const ARGS_UNAVAILABLE_MARKER = "Arguments unavailable from OpenCode"

/** Note rendered under every row: decisions happen in the native dialog. */
export const NATIVE_DECISION_NOTE = "Waiting for native Allow / Always / Reject"

/** Label rendered when the origin session could not be resolved. */
export const UNKNOWN_ORIGIN_LABEL = "Unknown subagent"

/** Normalizes `Permission.pattern` (`string | string[] | undefined`). */
export function normalizePatterns(pattern: string | readonly string[] | undefined): readonly string[] {
  if (pattern === undefined) return []
  if (typeof pattern === "string") return [pattern]
  return pattern
}
