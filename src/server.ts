import type { Hooks, Plugin, PluginModule } from "@opencode-ai/plugin"
import type { Event, Permission } from "@opencode-ai/sdk"
import { PermissionTracker } from "./shared/tracker.ts"
import { ToolInvocationCache } from "./shared/invocation-cache.ts"
import { SessionResolver, type SessionLike } from "./shared/session-resolver.ts"
import { sanitizeArgs } from "./shared/sanitize.ts"
import { originLabel } from "./shared/render.ts"
import { normalizePatterns, type PendingPermission } from "./shared/types.ts"

/**
 * Server-side half of the subagent permission overlay plugin.
 *
 * Responsibilities (see IMPLEMENTATION.md for the exact APIs used):
 * - `tool.execute.before`: bounded sanitized snapshot per `(sessionID, callID)`.
 * - `permission.ask`: track the pending request; never touch `output.status`.
 * - `event`: exact removal on `permission.replied`, tree cleanup on
 *   `session.deleted`.
 * - Optional finite toast fallback when the persistent TUI overlay is not
 *   available.
 *
 * This plugin never approves, denies or rewrites permission decisions.
 */

type PluginOptionsLike = {
  toastFallback?: unknown
  debug?: unknown
}

const TOAST_DURATION_MS = 8_000

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

function readOptions(options: unknown): { toastFallback: boolean; debug: boolean } {
  const raw = (options ?? {}) as PluginOptionsLike
  return {
    toastFallback: readBoolean(raw.toastFallback, true),
    debug: readBoolean(raw.debug, false) || process.env["OPENCODE_SUBAGENT_PERMISSIONS_DEBUG"] === "1",
  }
}

function toolNameFromMetadata(permission: Permission): string | undefined {
  const candidate = permission.metadata["tool"]
  if (typeof candidate === "string" && candidate.length > 0 && candidate !== permission.type) {
    return candidate
  }
  return undefined
}

function pendingFromPermission(permission: Permission): PendingPermission {
  return {
    requestID: permission.id,
    requestSessionID: permission.sessionID,
    rootSessionID: undefined,
    originAgent: undefined,
    originTitle: undefined,
    permission: permission.type,
    toolName: toolNameFromMetadata(permission),
    callID: permission.callID,
    patterns: normalizePatterns(permission.pattern),
    sanitizedArgs: undefined,
    argsSource: "unavailable",
    createdAt: Date.now(),
  }
}

const server: Plugin = async (input, options) => {
  const { client } = input
  const settings = readOptions(options)
  const cache = new ToolInvocationCache()
  const tracker = new PermissionTracker()
  const resolver = new SessionResolver(async (sessionID): Promise<SessionLike | null> => {
    const result = await client.session.get({ path: { id: sessionID } })
    const data = result.data
    if (!data) return null
    // The v1 `Session` record has no agent field; the origin agent is rendered
    // by the TUI from the v2 session API. Server-side labels fall back to the
    // session title instead of guessing.
    return { id: data.id, parentID: data.parentID, title: data.title }
  })

  const debug = (message: string, fields: Record<string, unknown>): void => {
    if (!settings.debug) return
    // Opt-in only; every field is sanitized before it reaches the log.
    console.error(`[subagent-permissions] ${message}`, sanitizeArgs(fields))
  }

  debug("plugin initialized", { directory: input.directory })

  const notifyToast = (request: PendingPermission): void => {
    void client.tui
      .showToast({
        body: {
          title: "Subagent permission request",
          message: `${originLabel(request)} · ${request.permission} — approve/deny in the native dialog`,
          variant: "warning",
          duration: TOAST_DURATION_MS,
        },
      })
      .catch(() => {
        // No TUI attached (headless run) — the toast is best-effort only.
      })
  }

  const enrichAsync = (permission: Permission): Promise<void> => {
    return (async () => {
      // Arguments: prefer the tool-captured snapshot; fall back to metadata.
      if (permission.callID) {
        const cached = cache.take(permission.sessionID, permission.callID)
        if (cached !== undefined) {
          tracker.enrich(permission.id, { sanitizedArgs: cached, argsSource: "tool-cache" })
        }
      }
      // Origin: resolve the session chain from the request session ID.
      const origin = await resolver.resolve(permission.sessionID)
      tracker.enrich(permission.id, {
        rootSessionID: origin.rootSessionID,
        originAgent: origin.originAgent,
        originTitle: origin.originTitle,
      })
      debug("tracked request enriched", { requestID: permission.id })
    })().catch((error: unknown) => {
      debug("enrichment failed", { requestID: permission.id, error: String(error) })
    })
  }

  const trackNewRequest = (permission: Permission): Promise<void> | undefined => {
    if (tracker.has(permission.id)) return undefined // duplicate delivery — ignore
    tracker.insert(pendingFromPermission(permission))
    const metadataKeys = Object.keys(permission.metadata)
    if (metadataKeys.length > 0) {
      tracker.enrich(permission.id, {
        sanitizedArgs: sanitizeArgs(permission.metadata),
        argsSource: "permission-metadata",
      })
    }
    return enrichAsync(permission)
  }

  const hooks: Hooks = {
    "tool.execute.before": async (hookInput, output) => {
      // Snapshot only — the arguments must not be mutated.
      try {
        cache.put(hookInput.sessionID, hookInput.callID, sanitizeArgs(output.args))
      } catch (error) {
        debug("argument capture failed", { error: String(error) })
      }
    },
    "tool.execute.after": async (hookInput) => {
      cache.drop(hookInput.sessionID, hookInput.callID)
    },
    "permission.ask": async (permission, output) => {
      // Leave the status exactly as other policy set it; when still "ask",
      // track the request for display. Never write "allow" here.
      if (output.status !== "ask") return
      const enrichment = trackNewRequest(permission)
      debug("permission.ask tracked", { requestID: permission.id, permission: permission.type })
      if (enrichment && settings.toastFallback) {
        // Toast after enrichment so the label is resolved, not guessed.
        void enrichment.then(() => {
          const tracked = tracker.get(permission.id)
          if (tracked) notifyToast(tracked)
        })
      }
    },
    event: async ({ event }: { event: Event }) => {
      switch (event.type) {
        case "permission.updated": {
          // Re-delivery or late notice: track if unknown, dedupe if known.
          trackNewRequest(event.properties)
          break
        }
        case "permission.replied": {
          const removed = tracker.remove(event.properties.permissionID)
          if (removed) debug("request resolved", { requestID: removed.requestID })
          break
        }
        case "session.deleted": {
          const deleted = event.properties.info.id
          const removed = tracker.removeWhere((request) => {
            if (request.requestSessionID === deleted) return true
            const chain = resolver.cachedChain(request.requestSessionID)
            return chain?.includes(deleted) ?? false
          })
          if (removed.length > 0) {
            cache.clearSessionTree(new Set([deleted]))
            debug("session tree cleaned", { sessionID: deleted, removed: removed.length })
          }
          resolver.invalidate(deleted)
          break
        }
        default:
          break
      }
    },
    dispose: async () => {
      tracker.clear()
      cache.clear()
      resolver.invalidate()
    },
  }

  return hooks
}

export default {
  id: "opencode-subagent-permissions",
  server,
} satisfies PluginModule
