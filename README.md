# opencode-subagent-permissions

Persistent, sanitized subagent permission context for the OpenCode TUI.

When a subagent (or a nested descendant) raises a permission request, the
native OpenCode prompt may show little context: Bash prompts can omit command
arguments, MCP prompts can omit most call context, and with concurrent
subagents the requester can be unclear. This plugin renders a compact panel —
outside the conversation transcript and the model context — that shows, for
every pending request visible from your root session:

```text
Permission requests (2)

1  @explore · bash
   {"command":"rg \"permission.ask\" packages/opencode"}
   Waiting for native Allow / Always / Reject (args: session tool call)

2  @librarian · context7.query-docs
   {"libraryId":"/anomalyco/opencode","query":"…"}
   Waiting for native Allow / Always / Reject (args: session tool call)

Decide in the native permission dialog — this panel is informational only.
```

The panel is informational only. The native OpenCode permission dialog remains
the only decision surface; the plugin never approves, denies, or rewrites any
permission decision and never injects anything into the session.

Related upstream reports:
[#15332](https://github.com/anomalyco/opencode/issues/15332) (permission
context), [#13715](https://github.com/anomalyco/opencode/issues/13715)
(nested-subagent routing).

## Requirements

- OpenCode **1.18.25 or newer** (the exact version the plugin's typed APIs were
  verified against — see [IMPLEMENTATION.md](./IMPLEMENTATION.md)).
- The TUI plugin needs no extra runtime installs: it resolves `solid-js` /
  `@opentui/*` inside the OpenCode runtime.

## Installation

### Local file install (this repository)

OpenCode must be **fully restarted** after installing or changing plugin files
or configuration — configuration and plugin files load at startup.

1. Copy/clone this repository somewhere permanent.
2. Register both entrypoints.

`<project>/.opencode/opencode.json` (server plugin):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["/absolute/path/to/opencode-subagent-permissions/src/server.ts"]
}
```

`<project>/.opencode/tui.json` (TUI overlay plugin):

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["/absolute/path/to/opencode-subagent-permissions/src/tui.tsx"]
}
```

Relative paths are resolved against the config file that declares them; use
absolute paths to share one checkout across projects.

### npm install (when published)

```sh
opencode plugin add opencode-subagent-permissions
```

and add the same name to both `opencode.json` (`plugin`) and `tui.json`
(`plugin`) if your OpenCode version does not patch the configs for you.

## UI behavior

- The panel appears in the **root/primary session view** while at least one
  tracked request is pending for that session tree, and disappears when the
  last request resolves.
- Requests are ordered oldest-first; a newly arriving request never replaces
  an existing one; resolving one request removes only that request.
- Invocation context is resolved in priority order:
  1. the session tool part for the request's `(messageID, callID)` — the same
     source the native permission prompt uses,
  2. sanitized `permission.metadata`,
  3. an explicit `Arguments unavailable from OpenCode` marker (never invented
     context).
- The origin row shows the requesting session's agent (`@explore`), falling
  back to the session title, falling back to `Unknown subagent`.
- A command palette entry (`Subagent permission requests: details`) opens a
  scrollable dialog with the full sanitized payload for every pending request.
- If the installed OpenCode version lacks the typed TUI slot API, the package
  degrades to a single finite warning toast per request plus one clear startup
  limitation notice — it never refreshes toasts to fake persistence.

## Security and redaction

Permission arguments can contain credentials. Everything shown in the panel,
the details dialog, and debug logs passes through the sanitizer first:

- object keys containing (case-insensitive) `authorization`, `cookie`,
  `password`, `passwd`, `secret`, `token`, `api_key`, `apikey`, `private_key`,
  `client_secret` are replaced with `[REDACTED]`;
- bearer-token and private-key patterns inside strings are redacted;
- limits: max depth 6, 50 entries per level, 2,000 chars per string, 16 KiB
  per payload, 240 chars per compact summary;
- nothing is written to disk by default; files are never read to build
  previews.

Debug logging is opt-in: set `OPENCODE_SUBAGENT_PERMISSIONS_DEBUG=1` or pass
`{ "debug": true }` plugin options. All logged fields are sanitized.

## Integration scenario (manual, requires a live model)

The repository ships a fixture project for the full loop
(`test/fixtures/project/`):

1. `cd test/fixtures/project`
2. Start the TUI: `opencode` (config already registers both plugin entries and
   an `integration-subagent` agent whose Bash permission is `ask`).
3. Prompt the primary session to spawn the `integration-subagent` subagent
   with the task "run your integration command".
4. Before approving, verify the primary TUI shows the panel with the
   subagent's name, `bash`, and `echo SUBAGENT_PERMISSION_INTEGRATION_TEST`.
5. Verify the native permission prompt is still the only decision surface.
   Approve once — only that panel entry disappears. Repeat with rejection.
6. Run two requests concurrently (two subagents) and resolve them in reverse
   order; each row must disappear independently.
7. Repeat with an MCP server configured via `mcp` config that exposes a tool
   with nested arguments and a fake secret value; verify the arguments are
   shown and the secret is redacted.

If OpenCode fails to deliver a nested-subagent request to the TUI at all, that
is the known upstream core limitation ([#13715](https://github.com/anomalyco/opencode/issues/13715));
the plugin cannot display a request it never sees.

## Development

```sh
npm install          # local devDependencies only (cache it wherever you like)
npm run typecheck    # tsc --noEmit, includes the TSX against real @opentui types
npm test             # vitest: unit + UI-logic + server-plugin + integration smoke
```

The integration smoke test spawns a real `opencode serve` with the fixture
config and asserts the plugin loads inside the OpenCode runtime.

## Known limitations

- OpenCode versions without the typed TUI slot API get only the toast
  fallback (a single finite warning per request) — by design, not a bug.
- Nested descendants may not deliver permission events in some affected
  OpenCode versions; the plugin shows what OpenCode actually delivers and
  labels anything missing.
- The plugin starts with empty in-memory state after reload; the panel
  rebuilds from the authoritative pending-permissions query on the next
  render, so stale requests are never shown as live.
