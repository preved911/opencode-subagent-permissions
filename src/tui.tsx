/** @jsxImportSource @opentui/solid */
import { For, Show, createMemo, createResource, createRoot, createSignal } from "solid-js"
import type { JSX } from "@opentui/solid"
import type {
  TuiCommand,
  TuiDialogSelectOption,
  TuiDialogStack,
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
} from "@opencode-ai/plugin/tui"
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import { SessionResolver, type SessionLike } from "./shared/session-resolver.ts"
import { compactRows, detailLines, essenceLine, header, originLabel, toolLabel } from "./shared/render.ts"
import { createArgsLookup, nativeDialogLacksEssence, selectVisibleRequests, toPendingRequests } from "./shared/panel.ts"

/**
 * TUI half of the subagent permission overlay plugin.
 *
 * Renders a persistent panel of pending subagent permission requests in the
 * right sidebar (`sidebar_content` slot, plugin order -100 — first widget).
 * The panel:
 * - shows requester, tool and sanitized invocation context,
 * - stays visible until the native permission request is resolved
 *   (`permission.replied` refreshes the authoritative pending list),
 * - never renders decision controls — the native OpenCode permission dialog
 *   remains the only decision surface.
 *
 * Data sources (see IMPLEMENTATION.md for the exact APIs):
 * - pending requests: `client.permission.list()` (authoritative query),
 *   refreshed on `permission.asked` / `permission.replied` /
 *   `session.deleted` TUI events,
 * - tool arguments: session tool parts via `state.part(messageID)` keyed by
 *   `tool.callID` — the same source the native permission prompt uses,
 * - origin: session chain via `client.session.get` (`parentID` walk).
 */

const DETAILS_COMMAND = "subagent_permissions.details"
const MANAGE_COMMAND = "subagent_permissions.manage"

function routeSessionID(api: TuiPluginApi): string | undefined {
  const current = api.route.current
  if (current.name !== "session") return undefined
  const params: unknown = current.params
  if (typeof params !== "object" || params === null) return undefined
  const sessionID = (params as { sessionID?: unknown }).sessionID
  return typeof sessionID === "string" ? sessionID : undefined
}

const tui: TuiPlugin = async (api) => {
  const resolver = new SessionResolver(async (sessionID): Promise<SessionLike | null> => {
    const result = await api.client.session.get({ sessionID })
    const data = result.data
    if (!data) return null
    return { id: data.id, parentID: data.parentID, agent: data.agent, title: data.title }
  })

  const firstSeen = new Map<string, number>()

  // Sessions removed while their requests were pending: the core keeps such
  // requests in its pending map (session removal does not touch the
  // permission service), so they are filtered out here by tombstone.
  const deletedSessions = new Set<string>()

  // Plain notification fan-out: permission lifecycle events bump the reactive
  // version signal inside the reactive root below. The TUI runtime tracks and
  // disposes `api.event.on` subscriptions automatically.
  const listeners = new Set<() => void>()
  const notify = (): void => {
    for (const listener of listeners) listener()
  }
  api.event.on("permission.asked", notify)
  api.event.on("permission.replied", notify)
  // A run that ends without replying (abort, interrupt) removes its pending
  // requests silently — no permission.replied is published. The idle status
  // transition is the only signal, so refetch on it.
  api.event.on("session.status", (event) => {
    if (event.properties.status.type === "idle") notify()
  })
  api.event.on("session.deleted", (event) => {
    deletedSessions.add(event.properties.info.id)
    resolver.invalidate()
    notify()
  })

  const argsOf = createArgsLookup((messageID) => api.state.part(messageID))

  // One reactive root for the whole panel: created once at plugin init, shared
  // between the slot render and the details dialog, disposed on plugin dispose.
  const panel = createRoot((dispose) => {
    api.lifecycle.onDispose(dispose)

    const [version, bump] = createSignal(0)
    const bumpVersion = (): number => bump((n) => n + 1)
    listeners.add(bumpVersion)

    const viewedSession = () => routeSessionID(api)

    const [pendingRequests] = createResource(version, async () => {
      const result = await api.client.permission.list()
      return result.data ?? []
    })

    const chainOf = (sessionID: string): readonly string[] | undefined => resolver.cachedChain(sessionID)

    const originOf = (
      sessionID: string,
    ): { agent: string | undefined; title: string | undefined } | undefined => {
      const cached = resolver.cached(sessionID)
      if (cached === undefined || cached === null) return undefined
      return { agent: cached.agent, title: cached.title }
    }

    const displayRequests = createMemo(() => {
      const viewed = viewedSession()
      if (!viewed) return []
      const all = (pendingRequests() ?? []).filter(
        (request) =>
          !deletedSessions.has(request.sessionID) && nativeDialogLacksEssence(request.permission),
      )
      // Resolution must run for every pending request BEFORE visibility
      // filtering: visibility requires a resolved chain, so resolving only
      // visible requests deadlocks subagent requests forever.
      for (const request of all) {
        if (resolver.cached(request.sessionID) === undefined) {
          void resolver
            .resolve(request.sessionID)
            .then(() => bumpVersion())
            .catch(() => bumpVersion())
        }
      }
      const visible = selectVisibleRequests(all, viewed, chainOf)
      const pending = toPendingRequests(visible, { argsOf, chainOf, originOf, now: () => Date.now() }, firstSeen)
      // Keep first-seen times bounded: forget resolved request IDs.
      const alive = new Set(pending.map((request) => request.requestID))
      for (const id of firstSeen.keys()) {
        if (!alive.has(id)) firstSeen.delete(id)
      }
      return pending.sort((a, b) => a.createdAt - b.createdAt)
    })

    // The manage dialog lists every pending request in the viewed tree,
    // including types the native dialog renders fully: cleanup applies to all.
    const manageableRequests = createMemo(() => {
      const viewed = viewedSession()
      if (!viewed) return []
      const all = (pendingRequests() ?? []).filter(
        (request) => !deletedSessions.has(request.sessionID),
      )
      for (const request of all) {
        if (resolver.cached(request.sessionID) === undefined) {
          void resolver
            .resolve(request.sessionID)
            .then(() => bumpVersion())
            .catch(() => bumpVersion())
        }
      }
      const visible = selectVisibleRequests(all, viewed, chainOf)
      return toPendingRequests(visible, { argsOf, chainOf, originOf, now: () => Date.now() }, firstSeen).sort(
        (a, b) => a.createdAt - b.createdAt,
      )
    })

    return { displayRequests, manageableRequests }
  })

  const currentDetailLines = (): string[] => {
    const requests = panel.displayRequests()
    if (requests.length === 0) return ["No pending permission requests."]
    const lines: string[] = [header(requests.length), ""]
    for (const request of requests) {
      lines.push(...detailLines(request), "")
    }
    return lines
  }

  // Details dialog over the legacy (typed, v1-supported) command API: the
  // command palette entry opens a scrollable dialog with the full sanitized
  // payload for every pending request.
  api.command?.register(() => {
    const commands: TuiCommand[] = [
      {
        title: "Subagent permission requests: details",
        value: DETAILS_COMMAND,
        description: "Full sanitized context for pending subagent permission requests",
        category: "Permissions",
        onSelect: (dialog: TuiDialogStack | undefined) => {
          if (!dialog) return
          dialog.setSize("large")
          dialog.replace(() => {
            const lines = currentDetailLines()
            return (
              <scrollbox height="100%" width="100%">
                <box flexDirection="column" paddingLeft={1} paddingTop={1}>
                  <For each={lines}>{(line) => <text fg={api.theme.current.text}>{line}</text>}</For>
                </box>
              </scrollbox>
            )
          })
        },
      },
      {
        title: "Subagent permission requests: manage",
        value: MANAGE_COMMAND,
        description: "Review and reject pending permission requests",
        category: "Permissions",
        onSelect: (dialog: TuiDialogStack | undefined) => {
          if (!dialog) return
          dialog.setSize("large")
          dialog.replace(() => {
            const requests = panel.manageableRequests()
            const options: TuiDialogSelectOption<string>[] = requests.map((request) => ({
              title: `${originLabel(request)} · ${toolLabel(request)}`,
              description: essenceLine(request),
              value: request.requestID,
            }))
            if (options.length === 0) {
              options.push({ title: "No pending permission requests.", value: "none" })
            }
            return (
              <api.ui.DialogSelect
                title="Pending permission requests — select to reject"
                options={options}
                onSelect={(option) => {
                  if (option.value === "none") return
                  void api.client.permission
                    .reply({ requestID: option.value, reply: "reject" })
                    .then(() => dialog.clear())
                    .catch(() => dialog.clear())
                }}
              />
            )
          })
        },
      },
    ]
    return commands
  })

  api.slots.register({
    order: -100,
    slots: {
      sidebar_content(): JSX.Element {
        return (
          <Show when={panel.displayRequests().length > 0}>
            <box flexDirection="column" flexShrink={0} paddingLeft={1}>
              <text fg={api.theme.current.textMuted}>{header(panel.displayRequests().length)}</text>
              <For each={compactRows(panel.displayRequests())}>
                {(line) => <text fg={api.theme.current.text}>{line}</text>}
              </For>
            </box>
          </Show>
        )
      },
    },
  })
}

export default {
  id: "opencode-subagent-permissions",
  tui,
} satisfies TuiPluginModule
