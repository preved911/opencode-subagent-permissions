import { describe, expect, it } from "vitest"
import { ToolInvocationCache } from "../src/shared/invocation-cache.ts"

function makeClock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let current = start
  return {
    now: () => current,
    advance: (ms) => {
      current += ms
    },
  }
}

describe("ToolInvocationCache", () => {
  it("stores and takes a snapshot, deleting it on take", () => {
    const cache = new ToolInvocationCache({}, () => 1_000)
    cache.put("s1", "c1", { command: "ls" })
    expect(cache.size).toBe(1)
    expect(cache.take("s1", "c1")).toEqual({ command: "ls" })
    expect(cache.size).toBe(0)
    expect(cache.take("s1", "c1")).toBeUndefined()
  })

  it("evicts entries after the TTL expires", () => {
    const clock = makeClock()
    const cache = new ToolInvocationCache({ ttlMs: 10 * 60 * 1000 }, clock.now)
    cache.put("s1", "c1", { a: 1 })
    clock.advance(10 * 60 * 1000 - 1)
    expect(cache.peek("s1", "c1")).toEqual({ a: 1 })
    clock.advance(1)
    expect(cache.peek("s1", "c1")).toBeUndefined()
    expect(cache.take("s1", "c1")).toBeUndefined()
  })

  it("evicts the oldest entries beyond the maximum size", () => {
    const cache = new ToolInvocationCache({ maxEntries: 3 }, () => 1_000)
    cache.put("s", "c1", 1)
    cache.put("s", "c2", 2)
    cache.put("s", "c3", 3)
    cache.put("s", "c4", 4)
    expect(cache.size).toBe(3)
    expect(cache.peek("s", "c1")).toBeUndefined()
    expect(cache.peek("s", "c4")).toBe(4)
  })

  it("refreshes recency when the same key is overwritten", () => {
    const cache = new ToolInvocationCache({ maxEntries: 2 }, () => 1_000)
    cache.put("s", "c1", 1)
    cache.put("s", "c2", 2)
    cache.put("s", "c1", 10)
    cache.put("s", "c3", 3)
    expect(cache.peek("s", "c1")).toBe(10)
    expect(cache.peek("s", "c2")).toBeUndefined()
  })

  it("drops a single entry on tool completion", () => {
    const cache = new ToolInvocationCache({}, () => 1_000)
    cache.put("s", "c1", 1)
    cache.drop("s", "c1")
    expect(cache.peek("s", "c1")).toBeUndefined()
  })

  it("clears an entire session tree by session ID", () => {
    const cache = new ToolInvocationCache({}, () => 1_000)
    cache.put("root", "c1", 1)
    cache.put("child", "c2", 2)
    cache.put("unrelated", "c3", 3)
    const removed = cache.clearSessionTree(new Set(["root", "child"]))
    expect(removed).toBe(2)
    expect(cache.size).toBe(1)
    expect(cache.peek("unrelated", "c3")).toBe(3)
  })

  it("prunes expired entries", () => {
    const clock = makeClock()
    const cache = new ToolInvocationCache({ ttlMs: 100 }, clock.now)
    cache.put("s", "c1", 1)
    cache.put("s", "c2", 2)
    clock.advance(101)
    expect(cache.prune()).toBe(2)
    expect(cache.size).toBe(0)
  })
})
