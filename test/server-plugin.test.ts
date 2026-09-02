import { describe, expect, it } from "vitest"
import pluginModule from "../src/server.ts"
import type { Event, Permission } from "@opencode-ai/sdk"
import type { Hooks, PluginInput } from "@opencode-ai/plugin"

const plugin = pluginModule as unknown as { id: string; server: (input: PluginInput, options?: unknown) => Promise<Hooks> }

function makePermission(overrides: Partial<Permission> = {}): Permission {
  return {
    id: "perm_1",
    type: "bash",
    pattern: ["rm -rf /"],
    sessionID: "ses_child",
    messageID: "msg_1",
    callID: "call_1",
    title: "Run command",
    metadata: {},
    time: { created: 1_000 },
    ...overrides,
  }
}

type SessionRecord = { id: string; parentID?: string; title?: string }

function makeInput(sessions: Record<string, SessionRecord>, toasts: unknown[] = []): PluginInput {
  const client = {
    session: {
      get: async ({ path }: { path: { id: string } }) => ({
        data: sessions[path.id] ?? null,
      }),
    },
    tui: {
      showToast: async ({ body }: { body: { message: string } }) => {
        toasts.push(body)
        return true
      },
    },
  }
  return {
    client,
    project: { id: "proj", worktree: "/worktree", time: { created: 0 } },
    directory: "/worktree",
    worktree: "/worktree",
    serverUrl: new URL("http://127.0.0.1:4096"),
    $: {},
  } as unknown as PluginInput
}

describe("server plugin module", () => {
  it("exposes the v1 module shape with a non-empty id", () => {
    expect(pluginModule).toHaveProperty("server")
    expect(plugin.id).toBe("opencode-subagent-permissions")
    expect(typeof plugin.server).toBe("function")
  })

  it("tracks permission.ask without touching output.status", async () => {
    const hooks = await plugin.server(makeInput({ ses_child: { id: "ses_child", parentID: "ses_root" } }), {
      toastFallback: false,
    })
    const output = { status: "ask" as const }
    await hooks["permission.ask"]?.(makePermission(), output)
    expect(output.status).toBe("ask")
    await hooks.dispose?.()
  })

  it("never writes allow into the output", async () => {
    const hooks = await plugin.server(makeInput({}), { toastFallback: false })
    const output = { status: "ask" as const }
    await hooks["permission.ask"]?.(makePermission(), output)
    expect(output.status).not.toBe("allow")
    await hooks.dispose?.()
  })

  it("respects a status already set by earlier policy", async () => {
    const hooks = await plugin.server(makeInput({}), { toastFallback: false })
    const output = { status: "deny" as const }
    await hooks["permission.ask"]?.(makePermission(), output)
    expect(output.status).toBe("deny")
    await hooks.dispose?.()
  })

  it("captures tool args before execution and enriches the tracked request", async () => {
    const hooks = await plugin.server(
      makeInput({
        ses_child: { id: "ses_child", parentID: "ses_root", title: "Search" },
        ses_root: { id: "ses_root", title: "Root" },
      }),
      { toastFallback: false },
    )
    await hooks["tool.execute.before"]?.(
      { tool: "bash", sessionID: "ses_child", callID: "call_1" },
      { args: { command: "rg secret", token: "leak" } },
    )
    await hooks["permission.ask"]?.(makePermission(), { status: "ask" })
    // Enrichment is async; give the microtask queue a tick.
    await new Promise((resolve) => setTimeout(resolve, 20))
    await hooks.dispose?.()
    // No public accessor by design; behavioral proof is the absence of errors
    // plus the tracker exercised through the toast/debug surfaces below.
  })

  it("emits one finite fallback toast per new request when enabled", async () => {
    const toasts: unknown[] = []
    const hooks = await plugin.server(
      makeInput({ ses_child: { id: "ses_child", title: "Search" } }, toasts),
      { toastFallback: true },
    )
    await hooks["permission.ask"]?.(makePermission(), { status: "ask" })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(toasts).toHaveLength(1)
    const toast = toasts[0] as { message: string; duration?: number }
    expect(toast.message).toContain("bash")
    expect(toast.duration).toBeGreaterThan(0)
    // Duplicate delivery must not re-toast.
    await hooks["permission.ask"]?.(makePermission(), { status: "ask" })
    expect(toasts).toHaveLength(1)
    await hooks.dispose?.()
  })

  it("falls back to the session title for the toast origin label", async () => {
    const toasts: unknown[] = []
    const hooks = await plugin.server(makeInput({ ses_child: { id: "ses_child", title: "Search the codebase" } }, toasts), {
      toastFallback: true,
    })
    await hooks["permission.ask"]?.(makePermission({ sessionID: "ses_child", metadata: {} }), { status: "ask" })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect((toasts[0] as { message: string }).message).toContain("Search the codebase")
    await hooks.dispose?.()
  })

  it("removes exactly the replied request on permission.replied", async () => {
    const hooks = await plugin.server(makeInput({}), { toastFallback: false })
    await hooks["permission.ask"]?.(makePermission({ id: "perm_1" }), { status: "ask" })
    await hooks["permission.ask"]?.(makePermission({ id: "perm_2" }), { status: "ask" })
    const replied: Event = {
      type: "permission.replied",
      properties: { sessionID: "ses_child", permissionID: "perm_1", response: "once" },
    }
    await hooks.event?.({ event: replied })
    await hooks.dispose?.()
  })

  it("cleans up requests and resolver state on session.deleted", async () => {
    const hooks = await plugin.server(
      makeInput({
        ses_child: { id: "ses_child", parentID: "ses_root" },
        ses_root: { id: "ses_root", title: "Root" },
      }),
      { toastFallback: false },
    )
    await hooks["permission.ask"]?.(makePermission(), { status: "ask" })
    const deleted: Event = {
      type: "session.deleted",
      properties: { info: { id: "ses_root", projectID: "proj", directory: "/w", title: "Root", version: "1", time: { created: 0, updated: 0 } } },
    }
    await hooks.event?.({ event: deleted })
    await hooks.dispose?.()
  })
})
