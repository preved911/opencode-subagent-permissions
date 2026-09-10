# Implementation notes

Every API below was verified against the types published by
`@opencode-ai/plugin` / `@opencode-ai/sdk` (pinned dev dependency, currently
1.18.25) and against the real OpenCode runtime (tested on 1.18.27; the
permission/plugin subsystem is unchanged through 1.18.29+). No undocumented
property probing, no `any`, no suppression comments.

## Package layout

A single npm package with one entrypoint (a v1 TUI plugin module exports
`tui`):

- `./tui` → `src/tui.tsx` — default export `{ id, tui }`
  (`TuiPluginModule`, registered via `tui.json` → `plugin`)
- `src/shared/` — pure logic used by the TUI side (sanitizer, session
  resolver, panel view-model, text rendering)

File/path plugin specs must export a non-empty `id`; the module uses
`opencode-subagent-permissions`.

## Why there is no server plugin

An earlier revision shipped a second (`server`) entrypoint that relied on the
`permission.ask` plugin hook and `permission.updated` / `permission.replied`
events to track pending requests and raise fallback toasts. Neither path
exists in the runtime:

- `permission.ask` is declared in the `Hooks` interface of
  `@opencode-ai/plugin` but is **never invoked** — no code path calls the
  plugin trigger with that name (verified against the `sst/opencode` source;
  unchanged from 1.18.20 through 1.18.30).
- The runtime emits `permission.asked` / `permission.replied` events;
  `permission.updated` does not exist.

The server entrypoint was therefore dead code from day one (its own debug
logs confirmed the hook never fired). The TUI side does not depend on it: the
panel reads OpenCode's own authoritative stores directly. It was removed in
full (`server.ts`, tracker, invocation cache, `./server` export).

## TUI plugin (`src/tui.tsx`)

### Registration APIs (`@opencode-ai/plugin/tui`)

- `TuiPluginModule` default export `{ id, tui }`; `tui: (api, options, meta) => Promise<void>`.
- `api.slots.register({ slots: { app_bottom() { … } } })` — `app_bottom` is
  rendered by the host in normal layout flow below the active route
  (`packages/tui/src/app.tsx`), i.e. additive and outside the transcript.
  `session_prompt` was rejected deliberately: the host renders it with
  `mode="replace"`, so a plugin there would replace the native prompt.
- `api.event.on(type, handler)` — TUI event bus: `permission.asked`,
  `permission.replied`, `session.deleted` bump the panel's reactive version.
  The TUI runtime tracks and disposes these subscriptions.
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

### Resolution-before-visibility invariant

Session-chain resolution (`resolver.resolve`) MUST be triggered for every
pending request BEFORE visibility filtering. Visibility itself requires a
resolved chain (`selectVisibleRequests`), so resolving only already-visible
requests deadlocks subagent requests forever — their `sessionID` differs from
the viewed root session and their chain never becomes visible. This bug
shipped in 0.1.0 and made the panel permanently empty; unit tests missed it
because they mocked `chainOf` with pre-resolved chains.

Reactivity: one `createRoot` owns the panel's signal/resource/memo graph; the
slot component and the details dialog read the same `displayRequests`
accessor. `firstSeen` keeps ordering stable across re-renders and forgets
resolved IDs to stay bounded.

## Shared modules (`src/shared/`)

- `types.ts` — `PendingPermission` (design contract), `ArgsSource`
  (`session-parts` | `permission-metadata` | `unavailable`),
  `normalizePatterns` (`string | string[] | undefined` → `string[]`).
- `sanitize.ts` — cyclic-safe, key- and pattern-redacting, depth/item/string/
  byte-bounded sanitizer (6 / 50 / 2000 / 16 KiB), 240-char compact summary.
- `session-resolver.ts` — memoized `parentID` walk with cycle guard; only
  successfully loaded sessions enter the chain (the last resolved session is
  the root — never a guess); bounded memo, per-entry and full invalidation.
- `panel.ts` — root-session scoping (`selectVisibleRequests`), view-model
  conversion (`toPendingRequests`), argument lookup with source labeling
  (`createArgsLookup`: session-parts → permission-metadata → unavailable).
- `render.ts` — pure text rendering: header, compact rows (origin · tool,
  truncated payload, native-decision note, payload-source tag), detail lines.

## Deliberate design decisions

1. **TUI-only, no server part.** The TUI renders from OpenCode's own
   authoritative stores (`/permission`, session parts, v2 session API). The
   previously attempted server-side hook/event tracking relied on APIs the
   runtime never provides (see above).
2. **`session_prompt` rejected** in favor of `app_bottom` (additive) —
   registering `session_prompt` replaces the native prompt (host renders it
   with `mode="replace"`).
3. **The authoritative pending-permissions query exists** (`/permission`), so
   the panel rebuilds truth after plugin reloads instead of showing stale
   state.
4. **Args precedence** — session tool part first (what the native prompt
   shows), then `permission.metadata` (bash puts `{ command }` there —
   verified in `packages/opencode/src/tool/shell.ts`), then an explicit
   unavailable marker.
5. **Never `allow`.** The plugin never touches permission decisions; the
   native dialog is the only decision surface.
