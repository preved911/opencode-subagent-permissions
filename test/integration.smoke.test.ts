import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { afterAll, describe, expect, it } from "vitest"

/**
 * Integration smoke test.
 *
 * The plugin is TUI-only: the TUI plugin loads inside a TUI process, which
 * needs an interactive terminal and a live model, so it cannot be exercised
 * here (the manual scenario lives in README.md). What CAN be verified
 * headlessly is the data surface the panel depends on:
 *
 * 1. the server comes up and serves HTTP,
 * 2. the authoritative pending-permission query (`/permission`) answers and
 *    returns an array — the same query `client.permission.list()` performs.
 */

const hasOpencodeBinary = (() => {
  const probe = spawnSync("opencode", ["--version"], { stdio: "ignore" })
  return !probe.error
})()

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "project")

let server: ChildProcess | undefined

afterAll(() => {
  server?.kill("SIGTERM")
})

async function waitForHttp(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return true
    } catch {
      // Server not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  return false
}

describe("integration: opencode serve exposes the panel's data surface", () => {
  it.skipIf(!hasOpencodeBinary)(
    "boots the server and answers the pending-permission query",
    async () => {
      const port = 45_000 + Math.floor(Math.random() * 10_000)
      server = spawn(
        "opencode",
        ["serve", "--port", String(port), "--hostname", "127.0.0.1"],
        { cwd: fixtureDir },
      )

      const base = `http://127.0.0.1:${String(port)}`
      const up = await waitForHttp(`${base}/doc`, 45_000)
      expect(up).toBe(true)

      const permission = await fetch(`${base}/permission`)
      expect(permission.status).toBe(200)
      const pending = (await permission.json()) as unknown[]
      expect(Array.isArray(pending)).toBe(true)
    },
    60_000,
  )
})
