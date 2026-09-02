import { compactSummary } from "./sanitize.ts"
import {
  ARGS_UNAVAILABLE_MARKER,
  NATIVE_DECISION_NOTE,
  SANITIZE_FAILED_MARKER,
  UNKNOWN_ORIGIN_LABEL,
  type ArgsSource,
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

/** Compact one-line payload summary, honestly labeled when unavailable. */
export function argsLine(request: PendingPermission): string {
  if (request.argsSource === "unavailable" || request.sanitizedArgs === undefined) {
    return ARGS_UNAVAILABLE_MARKER
  }
  if (request.sanitizedArgs === SANITIZE_FAILED_MARKER) {
    return `${request.permission}: ${ARGS_UNAVAILABLE_MARKER}`
  }
  return compactSummary(request.sanitizedArgs)
}

/** Source tag shown next to the payload so its provenance is never ambiguous. */
export function argsSourceLabel(source: ArgsSource): string {
  switch (source) {
    case "tool-cache":
      return "args: tool capture"
    case "session-parts":
      return "args: session tool call"
    case "permission-metadata":
      return "args: permission metadata"
    case "unavailable":
      return ""
  }
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
 *    Waiting for native Allow / Always / Reject
 * ```
 */
export function compactRows(requests: readonly PendingPermission[]): string[] {
  const rows: string[] = []
  requests.forEach((request, index) => {
    rows.push(truncateLine(`${index + 1}  ${originLabel(request)} · ${toolLabel(request)}`))
    rows.push(truncateLine(`   ${argsLine(request)}`))
    const source = argsSourceLabel(request.argsSource)
    rows.push(truncateLine(`   ${NATIVE_DECISION_NOTE}${source ? ` (${source})` : ""}`))
  })
  return rows
}

/**
 * Full detail lines for the scrollable dialog: identity fields plus the
 * sanitized payload, line-wrapped to stay inside the dialog.
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
  wrap(`permission: ${request.permission}`, "  ")
  wrap(`request: ${request.requestID}`, "  ")
  wrap(`session: ${request.requestSessionID}`, "  ")
  wrap(`root: ${request.rootSessionID ?? "unresolved"}`, "  ")
  if (request.callID) wrap(`call: ${request.callID}`, "  ")
  if (request.patterns.length > 0) wrap(`patterns: ${request.patterns.join(", ")}`, "  ")
  wrap(`payload source: ${request.argsSource}`, "  ")
  if (request.argsSource === "unavailable" || request.sanitizedArgs === undefined) {
    lines.push(`  ${ARGS_UNAVAILABLE_MARKER}`)
  } else {
    wrap(`payload: ${compactSummary(request.sanitizedArgs, { maxCompactLength: 4_000 })}`, "  ")
  }
  return lines
}
