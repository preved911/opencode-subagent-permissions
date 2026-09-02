# Implementation notes

Target version: **OpenCode 1.18.25** (installed during development; brew
`opencode` 1.18.25). Every API listed below was verified against the types
published by `@opencode-ai/plugin@1.18.25` / `@opencode-ai/sdk@1.18.25` and
against the `v1.18.25` source tree of `anomalyco/opencode`. No undocumented
property probing, no `any`, no suppression comments.

## Package layout

A single npm package with two target-exclusive entrypoints (v1 plugin modules
may export `server` or `tui`, never both):

- `./server` → `src/server.ts` — default export `{ id, server }`
  (`PluginModule`, registered via `opencode.json` → `plugin`)
- `./tui` → `src/tui.tsx` — default export `{ id, tui }`
  (`TuiPluginModule`, registered via `tui.json` → `plugin`)
- `src/shared/` — pure logic used by both sides (sanitizer, invocation cache,
  tracker, session resolver, panel view-model, text rendering)

File/path plugin specs must export a non-empty `id`; both modules use
`opencode-subagent-permissions`.

## Server plugin (`src/server.ts`)

### Hooks used (from `Hooks`, `@opencode-ai/plugin`)

| Hook | Signature (1.18.25) | Use |
|---|---|---|
| `tool.execute.before` | `(input: { tool: string; sessionID: string; callID: string }, output: { args: any })` | Bounded sanitized snapshot per `(sessionID, callID)`; `output.args` is never mutated |
| `tool.execute.after` | `(input: { tool; sessionID; callID; args }, output)` | Cache drop on tool completion/failure |
| `permission.ask` | `(input: Permission, output: { status: "ask" \| "deny" \| "allow" })` | Track the request; `output.status` is left exactly as received — the plugin never writes `allow` (or `deny`) |
| `event` | `(input: { event: Event })` | Resolution/removal/cleanup (below) |
| `dispose` | `() => Promise<void>` | Clears tracker, cache, resolver memo |

### `Permission` input type (`@opencode-ai/sdk`, 1.18.25)

```ts
type Permission = {
  id: string                    // canonical request ID — primary key
  type: string                  // permission type, e.g. "bash" or MCP tool name
  pattern?: string | Array<string>
  sessionID: string
  messageID: string
  callID?: string
  title: string
  metadata: { [key: string]: unknown }
  time: { created: number }
}
```

### Events handled (from `Event`, `@opencode-ai/sdk`, 1.18.25)

| Event | Properties | Handling |
|---|---|---|
| `permission.updated` | `Permission` | Dedupe by `id`; inserts only unknown requests |
| `permission.replied` | `{ sessionID: string; permissionID: string; response: string }` | Exact removal by `permissionID` — resolving one request never removes siblings |
| `session.deleted` | `{ info: Session }` | Removes tracked requests whose chain contains the deleted session and drops cache entries for it; invalidates the resolver memo |

### Session origin resolution

`client.session.get({ path: { id } })` (v1 client from `PluginInput`) walks
`Session.parentID` links. The v1 `Session` record carries **no agent field**,
so server-side labels fall back to the session title; the TUI resolves the
origin agent from the v2 session API (below). Unresolvable sessions are
labeled, never guessed.

### Toast fallback

`client.tui.showToast({ body: { title, message, variant, duration? } })` —
one finite (`8s`) warning per newly tracked request, sent only after origin
enrichment completes so the label is not guessed. Duplicate deliveries do not
re-toast. When no TUI is attached the call fails silently (best-effort by
design). Options: `toastFallback` (default `true`), `debug` (default `false`
or `OPENCODE_SUBAGENT_PERMISSIONS_DEBUG=1`).

## TUI plugin (`src/tui.tsx`)

### Registration APIs (`@opencode-ai/plugin/tui`, 1.18.25)

- `TuiPluginModule` default export `{ id, tui }`; `tui: (api, options, meta) => Promise<void>`.
- `api.slots.register({ slots: { app_bottom() { … } } })` — `app_bottom` is
  rendered by the host in normal layout flow below the active route
  (`packages/tui/src/app.tsx`), i.e. additive and outside the transcript.
  `session_prompt` was rejected deliberately: the host renders it with
  `mode="replace"`, so a plugin there would replace the native prompt.
- `api.event.on(type, handler)` — TUI event bus (`Event["type"]` from
  `@opencode-ai/sdk/v2`): `permission.asked`, `permission.replied`,
  `session.deleted` bump the panel's reactive version. The TUI runtime tracks
  and disposes these subscriptions.
- `api.command?.register(cb)` — legacy (typed, v1-supported) command API;
  registers `subagent_permissions.details`, which opens a scrollable dialog
  via `api.ui.dialog.setSize("large")` + `dialog.replace(render)`.
- `api.lifecycle.onDispose` — disposes the plugin's Solid root.

### Data sources

| Need | API | Notes |
|---|---|---|
| Pending requests (authoritative) | `api.client.permission.list()` → `PermissionRequest[]` | v2 HTTP query `/permission`; re-queried on lifecycle events. `PermissionRequest = { id, sessionID, permission, patterns, metadata, always, tool?: { messageID, callID } }` |
| Tool arguments | `api.state.part(tool.messageID)` → v1 `Part[]`, matched by `part.type === "tool" && part.callID === tool.callID` → `state.input` | Same source the native `PermissionPrompt` uses (`packages/tui/src/routes/session/permission.tsx`); during a permission ask the part state is `running` with the input |
| Origin chain / agent | `api.client.session.get({ sessionID })` → v2 `Session { id, parentID?, agent?, title }` | Walked with `SessionResolver`; `Session.agent` is a v2-only field |
| Current session view | `api.route.current` → `{ name: "session", params: { sessionID } }` | Backed by the route Solid store, so reads inside JSX/memos are reactive |
| Theme | `api.theme.current.{text, textMuted}` | RGBA values from the active theme |

Reactivity: one `createRoot` owns the panel's signal/resource/memo graph; the
slot component and the details dialog read the same `displayRequests`
accessor. `firstSeen` keeps ordering stable across re-renders and forgets
resolved IDs to stay bounded.

## Shared modules (`src/shared/`)

- `types.ts` — `PendingPermission` (design contract; `argsSource` extended
  with `session-parts` to label the TUI-side source honestly),
  `normalizePatterns` (`string | string[] | undefined` → `string[]`).
- `sanitize.ts` — cyclic-safe, key- and pattern-redacting, depth/item/string/
  byte-bounded sanitizer (6 / 50 / 2000 / 16 KiB), 240-char compact summary,
  non-throwing `safeStringify`.
- `invocation-cache.ts` — `(sessionID, callID)` map, 10-minute TTL, 500-entry
  cap, `take`-on-attach, `clearSessionTree` for disposal.
- `tracker.ts` — pending registry keyed by canonical request ID: duplicate
  delivery ignored, insertion-order snapshot, enrichment only while pending
  (resolution-before-enrichment race discards late patches), exact removal.
- `session-resolver.ts` — memoized `parentID` walk with cycle guard; only
  successfully loaded sessions enter the chain (the last resolved session is
  the root — never a guess); bounded memo, per-entry and full invalidation.
- `panel.ts` — root-session scoping (`selectVisibleRequests`), view-model
  conversion (`toPendingRequests`), argument lookup with source labeling
  (`createArgsLookup`: session-parts → permission-metadata → unavailable).
- `render.ts` — pure text rendering: header, compact rows (origin · tool,
  truncated payload, native-decision note, payload-source tag), detail lines.

## Deliberate design decisions

1. **Two entrypoints, no cross-process bridge.** Server captures and tracks;
   TUI renders from OpenCode's own authoritative stores. No IPC, no disk.
2. **`session_prompt` rejected** in favor of `app_bottom` (additive) —
   registering `session_prompt` replaces the native prompt (host renders it
   with `mode="replace"`).
3. **The authoritative pending-permissions query exists** in 1.18.25
   (`/permission`), so the panel rebuilds truth after plugin reloads instead
   of showing stale state.
4. **v1 `Session` has no agent** — the TUI resolves the origin agent via the
   v2 API; the server-side toast falls back to the session title.
5. **Args precedence** — session tool part first (what the native prompt
   shows), then `permission.metadata` (bash puts `{ command }` there —
   verified in `packages/opencode/src/tool/shell.ts`), then an explicit
   unavailable marker.
6. **Never `allow`.** `permission.ask` `output.status` passes through
   untouched; the only permission mutation in the entire codebase is none.
