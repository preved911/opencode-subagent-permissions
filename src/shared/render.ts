import { compactSummary } from "./sanitize.ts"
import {
  ARGS_UNAVAILABLE_MARKER,
  SANITIZE_FAILED_MARKER,
  UNKNOWN_ORIGIN_LABEL,
  type PendingPermission,
} from "./types.ts"

/**
 * Pure text rendering for the permission overlay panel.
 *
 * These helpers produce plain strings only — the Solid component in
 * `src/tui.tsx` places them inside OpenCode TUI primitives. Keeping rendering
 * out of JSX makes every panel state unit-testable without a terminal.
 */

export const COMPACT_LINE_LIMIT = 96

/** `@explore` when the origin agent is known, session title as fallback. */
export function originLabel(request: PendingPermission): string {
  if (request.originAgent) return `@${request.originAgent}`
  if (request.originTitle) return request.originTitle
  return UNKNOWN_ORIGIN_LABEL
}

/** Tool label: independent tool name when available, permission type otherwise. */
export function toolLabel(request: PendingPermission): string {
  return request.toolName ?? request.permission
}

/** Object keys whose scalar value is the request essence in plain form. */
const ESSENCE_KEYS: readonly string[] = [
  "command",
  "name",
  "url",
  "query",
  "pattern",
  "filepath",
  "path",
  "file",
  "description",
]

/**
 * Plain-text essence of the request payload: the value of the first known
 * essence key, a lone field's value, or undefined (JSON fallback upstream).
 * Tool inputs are single-purpose, so JSON is almost never the readable form.
 */
function essenceOfPayload(sanitizedArgs: unknown): string | undefined {
  if (typeof sanitizedArgs === "string") return sanitizedArgs
  if (typeof sanitizedArgs !== "object" || sanitizedArgs === null) return undefined
  const record = sanitizedArgs as { readonly [key: string]: unknown }
  for (const key of ESSENCE_KEYS) {
    const value = record[key]
    if (typeof value === "string" && value.trim().length > 0) return value
    if (typeof value === "number" || typeof value === "boolean") return String(value)
  }
  const keys = Object.keys(record)
  if (keys.length === 1) {
    const value = record[keys[0] as string]
    if (typeof value === "string" && value.trim().length > 0) return value
  }
  return undefined
}

/**
 * One-line essence for the panel row: plain payload value when available,
 * concrete pattern names (skill/task asks) otherwise, explicit marker last.
 */
export function essenceLine(request: PendingPermission): string {
  if (request.argsSource !== "unavailable" && request.sanitizedArgs !== undefined) {
    const plain = essenceOfPayload(request.sanitizedArgs)
    if (plain !== undefined) return plain
    if (request.sanitizedArgs === SANITIZE_FAILED_MARKER) {
      return `${request.permission}: ${ARGS_UNAVAILABLE_MARKER}`
    }
    return compactSummary(request.sanitizedArgs)
  }
  const named = namedPatterns(request.patterns)
  if (named.length > 0) return named.join(", ")
  return ARGS_UNAVAILABLE_MARKER
}

const CATCH_ALL_PATTERNS = new Set(["*", "**"])

/**
 * Concrete resource names carried by pattern-gated permissions (skill asks
 * carry `patterns: [skillName]` with empty metadata, task asks carry the
 * subagent type). Wildcard catch-alls carry no essence and are dropped.
 */
function namedPatterns(patterns: readonly string[]): readonly string[] {
  return patterns.filter((pattern) => !CATCH_ALL_PATTERNS.has(pattern))
}

function truncateLine(text: string, limit = COMPACT_LINE_LIMIT): string {
  if (text.length <= limit) return text
  return text.slice(0, limit - 1) + "…"
}

/** `Permission requests (2)` header; hidden entirely by the panel when empty. */
export function header(count: number): string {
  return `Permission requests (${count})`
}

/**
 * Compact panel rows, oldest request first:
 *
 * ```
 * 1  @explore · bash
 *    rg "permission.ask" packages/opencode
 * ```
 */
export function compactRows(requests: readonly PendingPermission[]): string[] {
  const rows: string[] = []
  requests.forEach((request, index) => {
    rows.push(truncateLine(`${index + 1}  ${originLabel(request)} · ${toolLabel(request)}`))
    rows.push(truncateLine(`   ${essenceLine(request)}`))
  })
  return rows
}

/**
 * Full detail lines for the scrollable dialog: identity header plus the two
 * fields with review value — matched patterns and the sanitized payload.
 */
export function detailLines(request: PendingPermission): string[] {
  const lines: string[] = []
  const wrap = (text: string, prefix: string): void => {
    const width = COMPACT_LINE_LIMIT - prefix.length
    for (let i = 0; i < text.length; i += width) {
      lines.push(i === 0 ? `${prefix}${text.slice(i, i + width)}` : `${" ".repeat(prefix.length)}${text.slice(i, i + width)}`)
    }
  }
  lines.push(truncateLine(`${originLabel(request)} · ${toolLabel(request)}`, COMPACT_LINE_LIMIT * 2))
  if (request.patterns.length > 0) wrap(`patterns: ${request.patterns.join(", ")}`, "  ")
  if (request.argsSource === "unavailable" || request.sanitizedArgs === undefined) {
    lines.push(`  ${ARGS_UNAVAILABLE_MARKER}`)
  } else {
    wrap(`payload: ${compactSummary(request.sanitizedArgs, { maxCompactLength: 4_000 })}`, "  ")
  }
  return lines
}
