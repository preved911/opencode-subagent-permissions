# opencode-subagent-permissions

Persistent, sanitized subagent permission context for the OpenCode TUI.

When a subagent (or a nested descendant) raises a permission request, the
native OpenCode prompt may show little context: with concurrent subagents the
requester can be unclear, and tool arguments are not always visible. This
plugin renders a compact widget in the right sidebar (first widget, above
other sidebar plugins) that shows, for every pending request visible from
your root session:

```text
Permission requests (2)

1  @explore · bash
   rg "permission.ask" packages/opencode

2  @librarian · context7.query-docs
   /anomalyco/opencode
```

Rows show the requester, the tool, and the request essence in plain form
(command text, skill name, matched pattern) — not JSON. The full sanitized
payload and the matched patterns are available in the details dialog
(`Subagent permission requests: details` in the command palette).

The widget lists only requests the native dialog renders **without** their
essence (the generic "Call tool X" fallback: skills, MCP tools, custom
permission types). Types the native dialog already renders fully — bash
commands, file edits, task spawns, web fetches — are not duplicated in the
widget.

The panel is informational only. The native OpenCode permission dialog remains
the only decision surface; the plugin never approves, denies, or rewrites any
permission decision and never injects anything into the session.

Related upstream reports:
[#15332](https://github.com/anomalyco/opencode/issues/15332) (permission
context), [#13715](https://github.com/anomalyco/opencode/issues/13715)
(nested-subagent routing).

## Requirements

- OpenCode **1.18.25 or newer** with the typed TUI slot API.
- No extra runtime installs: the plugin resolves `solid-js` / `@opentui/*`
  inside the OpenCode runtime.

## Installation

OpenCode must be **fully restarted** after installing or changing plugin files
or configuration — configuration and plugin files load at startup.

### Local file install (this repository)

`<project>/.opencode/tui.json` (or `~/.config/opencode/tui.json` for global):

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

and add the package name to `tui.json` (`plugin`) if your OpenCode version
does not patch the config for you.

## UI behavior

- The panel appears in the **root/primary session view** while at least one
  pending request targets that session tree, and disappears when the last
  request resolves.
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

## Security and redaction

Permission arguments can contain credentials. Everything shown in the panel
and the details dialog passes through the sanitizer first:

- object keys containing (case-insensitive) `authorization`, `cookie`,
  `password`, `passwd`, `secret`, `token`, `api_key`, `apikey`, `private_key`,
  `client_secret` are replaced with `[REDACTED]`;
- bearer-token and private-key patterns inside strings are redacted;
- limits: max depth 6, 50 entries per level, 2,000 chars per string, 16 KiB
  per payload, 240 chars per compact summary;
- nothing is written to disk by default; files are never read to build
  previews.

## Integration scenario (manual, requires a live model)

The repository ships a fixture project for the full loop
(`test/fixtures/project/`):

1. `cd test/fixtures/project`
2. Start the TUI: `opencode` (config already registers the TUI plugin and an
   `integration-subagent` agent whose Bash permission is `ask`).
3. Prompt the primary session to spawn the `integration-subagent` subagent
   with the task "run your integration command".
4. Before approving, verify the TUI shows the panel with the subagent's name,
   `bash`, and the `printf SUBAGENT_PERMISSION_INTEGRATION_TEST` command.
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
npm test             # vitest: unit + UI-logic + integration smoke
```

The integration smoke test spawns a real `opencode serve` and asserts the
`/permission` data surface the panel depends on. The full TUI scenario needs a
live model and is documented above.

## Known limitations

- OpenCode versions without the typed TUI slot API cannot render the panel.
- Nested descendants may not deliver permission events in some affected
  OpenCode versions; the plugin shows what OpenCode actually delivers and
  labels anything missing.
- The plugin starts with empty in-memory state after reload; the panel
  rebuilds from the authoritative pending-permissions query on the next
  render, so stale requests are never shown as live.
