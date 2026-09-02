import { describe, expect, it } from "vitest"
import { compactSummary, safeStringify, sanitizeArgs } from "../src/shared/sanitize.ts"
import { SANITIZE_FAILED_MARKER } from "../src/shared/types.ts"

describe("sanitizeArgs", () => {
  it("redacts sensitive keys at any depth, case-insensitively", () => {
    const result = sanitizeArgs({
      token: "abc",
      TOKEN: "abc",
      config: { ApiKey: "xyz", nested: { CLIENT_SECRET: "s" } },
      safe: "value",
    })
    expect(result).toEqual({
      token: "[REDACTED]",
      TOKEN: "[REDACTED]",
      config: { ApiKey: "[REDACTED]", nested: { CLIENT_SECRET: "[REDACTED]" } },
      safe: "value",
    })
  })

  it("redacts bearer tokens and private keys inside strings", () => {
    const result = sanitizeArgs({
      command: "curl -H 'Authorization: Bearer abc123def' https://example.com",
    })
    expect(JSON.stringify(result)).not.toContain("abc123def")
    expect(JSON.stringify(result)).toContain("Bearer [REDACTED]")

    const key = sanitizeArgs({
      data: "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----",
    })
    expect(JSON.stringify(key)).toContain("[REDACTED PRIVATE KEY]")
  })

  it("handles cyclic structures without throwing", () => {
    const node: Record<string, unknown> = { name: "root" }
    node["self"] = node
    const result = sanitizeArgs(node)
    expect(JSON.stringify(result)).toContain("[circular]")
  })

  it("enforces depth, item count and string length limits", () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: { h: "too deep" } } } } } } } }
    expect(JSON.stringify(sanitizeArgs(deep))).toContain("[depth limit]")

    const many = Array.from({ length: 60 }, (_, i) => i)
    const arrResult = sanitizeArgs({ list: many }) as { list: unknown[] }
    expect(arrResult.list).toHaveLength(51) // 50 items + truncation marker
    expect(JSON.stringify(arrResult.list?.[50])).toContain("more items")

    const long = "x".repeat(3000)
    const strResult = sanitizeArgs({ text: long }) as { text: string }
    expect((strResult.text as string).length).toBeLessThan(2200)
    expect((strResult.text as string).endsWith("…[truncated]")).toBe(true)
  })

  it("caps the total payload at 16 KiB", () => {
    const big = { blob: "y".repeat(40 * 1024) }
    const serialized = JSON.stringify(sanitizeArgs(big))
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(16 * 1024)
  })

  it("degrades non-JSON-compatible values to strings", () => {
    const result = sanitizeArgs({ big: 123n, fn: () => 1, sym: Symbol("tag") })
    const rendered = JSON.stringify(result)
    expect(rendered).toContain("123")
    expect(rendered).toContain("[function]")
    expect(rendered).toContain("tag")
  })

  it("does not mutate the input", () => {
    const input = { token: "secret", list: [1, 2] }
    const copy = structuredClone(input)
    sanitizeArgs(input)
    expect(input).toEqual(copy)
  })

  it("returns the failure marker when sanitization explodes", () => {
    const hostile = { get nested(): unknown { throw new Error("boom") } }
    expect(sanitizeArgs(hostile)).toBe(SANITIZE_FAILED_MARKER)
  })
})

describe("safeStringify", () => {
  it("survives cyclic input", () => {
    const node: Record<string, unknown> = {}
    node["loop"] = node
    expect(safeStringify(node, 1024)).toContain("[circular]")
  })

  it("truncates to the byte budget", () => {
    const out = safeStringify({ blob: "z".repeat(5000) }, 1000)
    expect(out).toBeDefined()
    expect((out as string).length).toBeLessThanOrEqual(1000)
    expect((out as string).endsWith("…[truncated]")).toBe(true)
  })
})

describe("compactSummary", () => {
  it("stays within the compact limit", () => {
    const out = compactSummary({ blob: "q".repeat(1000) })
    expect(out.length).toBeLessThanOrEqual(240)
    expect(out.endsWith("…[truncated]")).toBe(true)
  })

  it("returns empty string for undefined", () => {
    expect(compactSummary(undefined)).toBe("")
  })

  it("summarizes plain objects as JSON", () => {
    expect(compactSummary({ command: "rg permission.ask" })).toBe('{"command":"rg permission.ask"}')
  })
})
