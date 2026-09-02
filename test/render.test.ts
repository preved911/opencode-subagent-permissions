import { describe, expect, it } from "vitest"
import { argsLine, compactRows, detailLines, header, originLabel, toolLabel } from "../src/shared/render.ts"
import type { PendingPermission } from "../src/shared/types.ts"

function makeRequest(overrides: Partial<PendingPermission> = {}): PendingPermission {
  return {
    requestID: "perm_1",
    requestSessionID: "ses_child",
    rootSessionID: "ses_root",
    originAgent: "explore",
    originTitle: "Search the codebase",
    permission: "bash",
    toolName: undefined,
    callID: "call_1",
    patterns: ["rg *"],
    sanitizedArgs: { command: 'rg "permission.ask" packages/opencode' },
    argsSource: "session-parts",
    createdAt: 1_000,
    ...overrides,
  }
}

describe("panel rendering", () => {
  it("renders the header with the request count", () => {
    expect(header(2)).toBe("Permission requests (2)")
  })

  it("labels the origin agent and tool in the compact row", () => {
    const rows = compactRows([makeRequest()])
    expect(rows[0]).toBe("1  @explore · bash")
    expect(rows[1]).toContain("rg")
    expect(rows[1]).toContain("permission.ask")
    expect(rows[2]).toContain("Waiting for native Allow / Always / Reject")
  })

  it("falls back to Unknown subagent when the origin is unresolved", () => {
    const request = makeRequest({ originAgent: undefined, originTitle: undefined })
    expect(originLabel(request)).toBe("Unknown subagent")
    expect(compactRows([request])[0]).toContain("Unknown subagent")
  })

  it("uses the session title when no agent is known", () => {
    const request = makeRequest({ originAgent: undefined })
    expect(originLabel(request)).toBe("Search the codebase")
  })

  it("shows the explicit unavailable marker when args are missing", () => {
    const request = makeRequest({ sanitizedArgs: undefined, argsSource: "unavailable" })
    expect(argsLine(request)).toBe("Arguments unavailable from OpenCode")
  })

  it("marks the payload source in the compact row", () => {
    const rows = compactRows([makeRequest()])
    expect(rows[2]).toContain("args: session tool call")
  })

  it("truncates long payloads in the compact view", () => {
    const request = makeRequest({
      sanitizedArgs: { command: "x".repeat(500) },
    })
    const rows = compactRows([request])
    for (const row of rows) {
      expect(row.length).toBeLessThanOrEqual(97)
    }
    expect(argsLine(request).endsWith("…[truncated]")).toBe(true)
  })

  it("keeps multiple requests independently numbered in arrival order", () => {
    const rows = compactRows([
      makeRequest({ requestID: "a", permission: "bash" }),
      makeRequest({ requestID: "b", permission: "context7.query-docs", originAgent: "librarian" }),
    ])
    expect(rows[0]).toBe("1  @explore · bash")
    expect(rows[3]).toBe("2  @librarian · context7.query-docs")
  })

  it("resolving one request leaves the other visible", () => {
    const remaining = [
      makeRequest({
        requestID: "b",
        originAgent: "librarian",
        sanitizedArgs: { url: "https://example.com" },
      }),
    ]
    const rows = compactRows(remaining)
    expect(rows[0]).toBe("1  @librarian · bash")
    expect(rows.join("\n")).toContain("https://example.com")
    expect(rows.join("\n")).not.toContain("permission.ask")
  })

  it("uses the tool name from metadata when it differs from the permission", () => {
    const request = makeRequest({ permission: "bash", toolName: "custom-runner" })
    expect(toolLabel(request)).toBe("custom-runner")
  })

  it("renders full detail lines with identity fields and payload", () => {
    const lines = detailLines(makeRequest())
    const joined = lines.join("\n")
    expect(joined).toContain("@explore · bash")
    expect(joined).toContain("permission: bash")
    expect(joined).toContain("request: perm_1")
    expect(joined).toContain("session: ses_child")
    expect(joined).toContain("root: ses_root")
    expect(joined).toContain("call: call_1")
    expect(joined).toContain("payload source: session-parts")
    expect(joined).toContain("payload:")
  })

  it("renders unavailable args in details without inventing context", () => {
    const lines = detailLines(makeRequest({ sanitizedArgs: undefined, argsSource: "unavailable" }))
    expect(lines.join("\n")).toContain("Arguments unavailable from OpenCode")
  })

  it("keeps wrapped detail lines within the width budget", () => {
    const lines = detailLines(
      makeRequest({
        requestSessionID: "ses_" + "long".repeat(40),
        sanitizedArgs: { command: "z".repeat(600) },
      }),
    )
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(96)
    }
  })
})
