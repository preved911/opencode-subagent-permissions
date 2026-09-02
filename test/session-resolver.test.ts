import { describe, expect, it } from "vitest"
import { SessionResolver, type SessionLike } from "../src/shared/session-resolver.ts"

function makeFetcher(
  sessions: Record<string, SessionLike>,
  failures: ReadonlySet<string> = new Set(),
): (sessionID: string) => Promise<SessionLike | null> {
  return async (sessionID) => {
    if (failures.has(sessionID)) throw new Error("lookup failed")
    return sessions[sessionID] ?? null
  }
}

describe("SessionResolver", () => {
  it("walks parentID links to the root", async () => {
    const resolver = new SessionResolver(
      makeFetcher({
        ses_root: { id: "ses_root", title: "Root session" },
        ses_child: { id: "ses_child", parentID: "ses_root", agent: "explore", title: "Search" },
      }),
    )
    const origin = await resolver.resolve("ses_child")
    expect(origin.chain).toEqual(["ses_child", "ses_root"])
    expect(origin.rootSessionID).toBe("ses_root")
    expect(origin.originAgent).toBe("explore")
    expect(origin.originTitle).toBe("Search")
  })

  it("treats a session without parentID as its own root", async () => {
    const resolver = new SessionResolver(makeFetcher({ ses_a: { id: "ses_a", title: "Solo" } }))
    const origin = await resolver.resolve("ses_a")
    expect(origin.rootSessionID).toBe("ses_a")
    expect(origin.chain).toEqual(["ses_a"])
  })

  it("stops gracefully when the parent record is missing", async () => {
    const resolver = new SessionResolver(
      makeFetcher({ ses_child: { id: "ses_child", parentID: "ses_missing" } }),
    )
    const origin = await resolver.resolve("ses_child")
    expect(origin.chain).toEqual(["ses_child"])
    expect(origin.rootSessionID).toBe("ses_child")
    expect(origin.originAgent).toBeUndefined()
  })

  it("labels lookup failures as unresolved instead of guessing", async () => {
    const resolver = new SessionResolver(makeFetcher({}, new Set(["ses_fail"])))
    const origin = await resolver.resolve("ses_fail")
    expect(origin.rootSessionID).toBeUndefined()
    expect(origin.originAgent).toBeUndefined()
    expect(origin.originTitle).toBeUndefined()
  })

  it("guards against parentID cycles", async () => {
    const resolver = new SessionResolver(
      makeFetcher({
        ses_a: { id: "ses_a", parentID: "ses_b" },
        ses_b: { id: "ses_b", parentID: "ses_a" },
      }),
    )
    const origin = await resolver.resolve("ses_a")
    expect(origin.chain).toEqual(["ses_a", "ses_b"])
  })

  it("serves repeat lookups from the bounded memo", async () => {
    let calls = 0
    const resolver = new SessionResolver(async (id) => {
      calls++
      return { id, title: `t-${id}` }
    })
    await resolver.resolve("ses_x")
    await resolver.resolve("ses_x")
    expect(calls).toBe(1)
  })

  it("invalidates one session or the whole memo", async () => {
    let calls = 0
    const resolver = new SessionResolver(async (id) => {
      calls++
      return { id }
    })
    await resolver.resolve("ses_x")
    resolver.invalidate("ses_x")
    await resolver.resolve("ses_x")
    expect(calls).toBe(2)
    resolver.invalidate()
    await resolver.resolve("ses_x")
    expect(calls).toBe(3)
  })

  it("reports incomplete chains as undefined in cachedChain", async () => {
    const resolver = new SessionResolver(
      makeFetcher({ ses_child: { id: "ses_child", parentID: "ses_root" } }),
    )
    expect(resolver.cachedChain("ses_child")).toBeUndefined()
    await resolver.resolve("ses_child")
    expect(resolver.cachedChain("ses_child")).toEqual(["ses_child"])
  })
})
