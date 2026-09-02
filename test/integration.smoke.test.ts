import { spawn, type ChildProcess } from "node:child_process"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { afterAll, describe, expect, it } from "vitest"

/**
 * Integration smoke test: boots a real `opencode serve` instance with the
 * fixture project config that registers the server plugin, then asserts
 *
 * 1. the server comes up and serves HTTP,
 * 2. the plugin module actually loaded inside the OpenCode runtime
 *    (observed via the opt-in debug init log),
 * 3. the native permission HTTP surface answers.
 *
 * The full TUI scenario (subagent asks for bash, panel renders, native dialog
 * resolves) requires a live model and is documented in README.md
 * ("Integration scenario").
 */

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "project")

let server: ChildProcess | undefined
let output = ""

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

describe("integration: opencode serve with the plugin registered", () => {
  it(
    "boots the server, loads the plugin, and exposes the permission surface",
    async () => {
      const port = 45_000 + Math.floor(Math.random() * 10_000)
      server = spawn(
        "opencode",
        ["serve", "--port", String(port), "--hostname", "127.0.0.1"],
        {
          cwd: fixtureDir,
          env: { ...process.env, OPENCODE_SUBAGENT_PERMISSIONS_DEBUG: "1" },
        },
      )
      server.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString()
      })
      server.stderr?.on("data", (chunk: Buffer) => {
        output += chunk.toString()
      })

      const base = `http://127.0.0.1:${String(port)}`
      const up = await waitForHttp(`${base}/doc`, 45_000)
      expect(up).toBe(true)

      // Instance-scoped request: triggers plugin loading inside the server.
      const permission = await fetch(`${base}/permission`)
      expect(permission.status).toBe(200)
      const pending = (await permission.json()) as unknown[]
      expect(Array.isArray(pending)).toBe(true)

      // The plugin must have loaded inside the real OpenCode runtime.
      const logged = await waitFor(
        () => output.includes("[subagent-permissions] plugin initialized"),
        15_000,
      )
      expect(logged).toBe(true)
    },
    60_000,
  )
})

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return predicate()
}
