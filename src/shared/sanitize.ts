import { DEFAULT_SANITIZE_LIMITS, SANITIZE_FAILED_MARKER, type SanitizeLimits } from "./types.ts"

/**
 * Case-insensitive key fragments whose values are always redacted before
 * rendering or logging. Matching is deliberately conservative: any key whose
 * lowercased name *contains* one of these fragments is redacted.
 */
const REDACTED_KEY_FRAGMENTS: readonly string[] = [
  "authorization",
  "cookie",
  "password",
  "passwd",
  "secret",
  "token",
  "api_key",
  "apikey",
  "private_key",
  "client_secret",
]

const BEARER_REGEX = /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi
const PRIVATE_KEY_REGEX =
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----(?:END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----|$)/g

const TRUNCATED_SUFFIX = "…[truncated]"
const DEPTH_MARKER = "[depth limit]"
const ITEMS_MARKER = "[+N more items]"
const KEYS_MARKER = "[+N more keys]"
const BYTES_MARKER = "[payload exceeded byte limit]"

/**
 * JSON stringify that never throws: cyclic references are replaced with
 * markers, BigInt and other non-JSON values degrade to strings. Returns
 * `undefined` when even the fallback fails.
 */
export function safeStringify(value: unknown, maxBytes: number): string | undefined {
  const seen = new WeakSet<object>()
  let out: string
  try {
    out = JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === "bigint") return `${item}n`
      if (typeof item === "function") return "[function]"
      if (typeof item === "symbol") return String(item)
      if (item instanceof Error) return `${item.name}: ${item.message}`
      if (typeof item === "object" && item !== null) {
        if (seen.has(item)) return "[circular]"
        seen.add(item)
      }
      return item
    })
  } catch {
    return undefined
  }
  if (out === undefined) return undefined
  const bytes = Buffer.byteLength(out, "utf8")
  if (bytes <= maxBytes) return out
  return out.slice(0, Math.max(0, maxBytes - TRUNCATED_SUFFIX.length)) + TRUNCATED_SUFFIX
}

function isRedactedKey(key: string): boolean {
  const lower = key.toLowerCase()
  return REDACTED_KEY_FRAGMENTS.some((fragment) => lower.includes(fragment))
}

function redactString(value: string): string {
  return value.replace(PRIVATE_KEY_REGEX, "[REDACTED PRIVATE KEY]").replace(BEARER_REGEX, "Bearer [REDACTED]")
}

type Budget = { bytesLeft: number }

function sizeOf(value: unknown): number {
  // Approximate per-node cost; precise accounting happens on the final string.
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8")
  } catch {
    return 8
  }
}

function sanitizeNode(
  input: unknown,
  depth: number,
  limits: SanitizeLimits,
  budget: Budget,
  seen: WeakSet<object>,
): unknown {
  if (input === null || input === undefined) return input

  if (typeof input === "string") {
    let str = input
    if (str.length > limits.maxStringLength) {
      str = str.slice(0, limits.maxStringLength) + TRUNCATED_SUFFIX
    }
    return redactString(str)
  }

  if (typeof input === "number" || typeof input === "boolean") return input

  if (typeof input === "bigint" || typeof input === "function" || typeof input === "symbol") {
    if (typeof input === "function") return "[function]"
    return String(input)
  }

  if (input instanceof Error) return `${input.name}: ${input.message}`

  if (typeof input === "object") {
    if (seen.has(input)) return "[circular]"
    if (depth >= limits.maxDepth) return DEPTH_MARKER
    seen.add(input)
    try {
      if (Array.isArray(input)) {
        const out: unknown[] = []
        const entries = input.length > limits.maxItems ? limits.maxItems : input.length
        for (let i = 0; i < entries; i++) {
          out.push(sanitizeNode(input[i], depth + 1, limits, budget, seen))
        }
        if (input.length > limits.maxItems) {
          out.push(ITEMS_MARKER.replace("N", String(input.length - limits.maxItems)))
        }
        return out
      }
      const record = input as Record<string, unknown>
      const keys = Object.keys(record)
      const out: Record<string, unknown> = {}
      const entries = keys.length > limits.maxItems ? limits.maxItems : keys.length
      for (let i = 0; i < entries; i++) {
        const key = keys[i] as string
        if (isRedactedKey(key)) {
          out[key] = "[REDACTED]"
          continue
        }
        out[key] = sanitizeNode(record[key], depth + 1, limits, budget, seen)
      }
      if (keys.length > limits.maxItems) {
        out[KEYS_MARKER.replace("N", String(keys.length - limits.maxItems))] = true
      }
      return out
    } finally {
      seen.delete(input)
    }
  }

  return String(input)
}

/**
 * Produces a display-safe structured copy of tool invocation arguments.
 *
 * - Redacts sensitive keys and sensitive string patterns.
 * - Enforces depth, item-count, string-length and total-byte limits.
 * - Never throws: on internal failure returns `SANITIZE_FAILED_MARKER`.
 * - Does not mutate the input.
 */
export function sanitizeArgs(
  input: unknown,
  limits: Partial<SanitizeLimits> = {},
): unknown {
  const resolved: SanitizeLimits = { ...DEFAULT_SANITIZE_LIMITS, ...limits }
  try {
    const budget: Budget = { bytesLeft: resolved.maxTotalBytes }
    const result = sanitizeNode(input, 0, resolved, budget, new WeakSet<object>())
    const serialized = safeStringify(result, resolved.maxTotalBytes)
    if (serialized === undefined) return BYTES_MARKER
    if (Buffer.byteLength(serialized, "utf8") > resolved.maxTotalBytes) return BYTES_MARKER
    return result
  } catch {
    return SANITIZE_FAILED_MARKER
  }
}

/**
 * Bounded one-line summary for the compact panel row. Always defined and
 * always within `limits.maxCompactLength` characters.
 */
export function compactSummary(value: unknown, limits: Partial<SanitizeLimits> = {}): string {
  const resolved: SanitizeLimits = { ...DEFAULT_SANITIZE_LIMITS, ...limits }
  if (value === undefined) return ""
  if (typeof value === "string") {
    const str = redactString(value)
    return str.length > resolved.maxCompactLength
      ? str.slice(0, resolved.maxCompactLength - TRUNCATED_SUFFIX.length) + TRUNCATED_SUFFIX
      : str
  }
  const serialized = safeStringify(value, resolved.maxTotalBytes)
  if (serialized === undefined) return "[unserializable arguments]"
  if (serialized.length > resolved.maxCompactLength) {
    return serialized.slice(0, resolved.maxCompactLength - TRUNCATED_SUFFIX.length) + TRUNCATED_SUFFIX
  }
  return serialized
}
