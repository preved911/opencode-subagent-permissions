import { describe, expect, it } from "vitest"
import { PermissionTracker } from "../src/shared/tracker.ts"
import type { PendingPermission } from "../src/shared/types.ts"

function makeRequest(overrides: Partial<PendingPermission> & { requestID: string }): PendingPermission {
  return {
    requestSessionID: "ses_child",
    rootSessionID: undefined,
    originAgent: undefined,
    originTitle: undefined,
    permission: "bash",
    toolName: undefined,
    callID: undefined,
    patterns: [],
    sanitizedArgs: undefined,
    argsSource: "unavailable",
    createdAt: 1_000,
    ...overrides,
  }
}

describe("PermissionTracker", () => {
  it("inserts requests and exposes them oldest-first", () => {
    const tracker = new PermissionTracker()
    tracker.insert(makeRequest({ requestID: "r2", createdAt: 2_000 }))
    tracker.insert(makeRequest({ requestID: "r1", createdAt: 1_000 }))
    expect(tracker.snapshot().map((r) => r.requestID)).toEqual(["r2", "r1"])
  })

  it("ignores duplicate delivery of the same request ID", () => {
    const tracker = new PermissionTracker()
    expect(tracker.insert(makeRequest({ requestID: "r1" }))).toBe(true)
    expect(tracker.insert(makeRequest({ requestID: "r1", permission: "edit" }))).toBe(false)
    expect(tracker.get("r1")?.permission).toBe("bash")
    expect(tracker.size).toBe(1)
  })

  it("removes exactly the matching request, leaving siblings", () => {
    const tracker = new PermissionTracker()
    tracker.insert(makeRequest({ requestID: "r1" }))
    tracker.insert(makeRequest({ requestID: "r2" }))
    tracker.insert(makeRequest({ requestID: "r3" }))
    const removed = tracker.remove("r2")
    expect(removed?.requestID).toBe("r2")
    expect(tracker.snapshot().map((r) => r.requestID)).toEqual(["r1", "r3"])
    expect(tracker.remove("r2")).toBeUndefined()
  })

  it("handles multiple concurrent requests from sibling subagents", () => {
    const tracker = new PermissionTracker()
    tracker.insert(makeRequest({ requestID: "a", requestSessionID: "ses_a" }))
    tracker.insert(makeRequest({ requestID: "b", requestSessionID: "ses_b" }))
    tracker.insert(makeRequest({ requestID: "c", requestSessionID: "ses_a" }))
    tracker.removeWhere((r) => r.requestSessionID === "ses_a" && r.requestID === "c")
    expect(tracker.snapshot().map((r) => r.requestID)).toEqual(["a", "b"])
  })

  it("discards enrichment for requests resolved before enrichment completed", () => {
    const tracker = new PermissionTracker()
    tracker.insert(makeRequest({ requestID: "r1" }))
    tracker.remove("r1")
    expect(tracker.enrich("r1", { originAgent: "@explore" })).toBe(false)
    expect(tracker.get("r1")).toBeUndefined()
  })

  it("applies enrichment patches only to the pending request", () => {
    const tracker = new PermissionTracker()
    tracker.insert(makeRequest({ requestID: "r1" }))
    tracker.insert(makeRequest({ requestID: "r2" }))
    tracker.enrich("r1", {
      rootSessionID: "ses_root",
      originAgent: "@explore",
      originTitle: "Search the codebase",
      toolName: undefined,
      sanitizedArgs: { command: "rg x" },
      argsSource: "tool-cache",
    })
    expect(tracker.get("r1")).toMatchObject({ originAgent: "@explore", argsSource: "tool-cache" })
    expect(tracker.get("r2")?.originAgent).toBeUndefined()
  })

  it("removes by session predicate for disposal cleanup", () => {
    const tracker = new PermissionTracker()
    tracker.insert(makeRequest({ requestID: "a", requestSessionID: "ses_child" }))
    tracker.insert(makeRequest({ requestID: "b", requestSessionID: "ses_other" }))
    const removed = tracker.removeWhere((r) => r.requestSessionID === "ses_child")
    expect(removed.map((r) => r.requestID)).toEqual(["a"])
    expect(tracker.size).toBe(1)
  })

  it("clears everything", () => {
    const tracker = new PermissionTracker()
    tracker.insert(makeRequest({ requestID: "r1" }))
    tracker.clear()
    expect(tracker.size).toBe(0)
  })
})
