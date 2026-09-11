import { describe, expect, it } from "vitest"
import { essenceLine, compactRows, detailLines, header, originLabel, toolLabel } from "../src/shared/render.ts"
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

  it("shows the explicit unavailable marker when nothing concrete is known", () => {
    const request = makeRequest({ patterns: [], sanitizedArgs: undefined, argsSource: "unavailable" })
    expect(essenceLine(request)).toBe("Arguments unavailable from OpenCode")
  })

  it("falls back to the matched bash pattern when args are unavailable", () => {
    const request = makeRequest({ sanitizedArgs: undefined, argsSource: "unavailable" })
    expect(essenceLine(request)).toBe("rg *")
  })

  it("shows the skill name from patterns when args are unavailable", () => {
    const request = makeRequest({
      permission: "skill",
      patterns: ["debugging"],
      sanitizedArgs: undefined,
      argsSource: "unavailable",
    })
    expect(essenceLine(request)).toBe("debugging")
  })

  it("shows the subagent type from patterns for task asks", () => {
    const request = makeRequest({
      permission: "task",
      patterns: ["explore"],
      sanitizedArgs: undefined,
      argsSource: "unavailable",
    })
    expect(essenceLine(request)).toBe("explore")
  })

  it("keeps the unavailable marker for wildcard-only patterns", () => {
    const request = makeRequest({
      permission: "skill",
      patterns: ["*"],
      sanitizedArgs: undefined,
      argsSource: "unavailable",
    })
    expect(essenceLine(request)).toBe("Arguments unavailable from OpenCode")
  })

  it("prefers the payload over pattern names when args are available", () => {
    const request = makeRequest({
      permission: "skill",
      patterns: ["debugging"],
      sanitizedArgs: { command: "rg x" },
      argsSource: "session-parts",
    })
    expect(essenceLine(request)).toContain("rg x")
  })

  it("renders the plain command value instead of JSON", () => {
    const request = makeRequest({ sanitizedArgs: { command: "rg x" }, argsSource: "session-parts" })
    expect(essenceLine(request)).toBe("rg x")
  })

  it("renders the plain skill name from the tool input", () => {
    const request = makeRequest({
      permission: "skill",
      sanitizedArgs: { name: "perm-test-skill" },
      argsSource: "session-parts",
    })
    expect(essenceLine(request)).toBe("perm-test-skill")
  })

  it("falls back to compact JSON for multi-field payloads", () => {
    const request = makeRequest({
      sanitizedArgs: { a: "1", b: "2" },
      argsSource: "session-parts",
    })
    expect(essenceLine(request)).toContain('"a"')
  })

  it("truncates long payloads in the compact view", () => {
    const request = makeRequest({
      sanitizedArgs: { command: "x".repeat(500) },
    })
    const rows = compactRows([request])
    for (const row of rows) {
      expect(row.length).toBeLessThanOrEqual(97)
    }
  })

  it("keeps multiple requests independently numbered in arrival order", () => {
    const rows = compactRows([
      makeRequest({ requestID: "a", permission: "bash" }),
      makeRequest({ requestID: "b", permission: "context7.query-docs", originAgent: "librarian" }),
    ])
    expect(rows[0]).toBe("1  @explore · bash")
    expect(rows[2]).toBe("2  @librarian · context7.query-docs")
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

  it("renders trimmed detail lines: header, patterns, payload", () => {
    const lines = detailLines(makeRequest())
    const joined = lines.join("\n")
    expect(joined).toContain("@explore · bash")
    expect(joined).toContain("patterns: rg *")
    expect(joined).toContain("payload:")
    expect(joined).not.toContain("request:")
    expect(joined).not.toContain("session:")
    expect(joined).not.toContain("root:")
    expect(joined).not.toContain("call:")
    expect(joined).not.toContain("payload source:")
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
