# Design: Persistent Subagent Permission Context in OpenCode TUI

## Implementation Prompt

Implement an OpenCode plugin that makes permission requests raised by child and nested subagent sessions understandable from the primary session view.

The plugin must show a persistent, non-chat UI element containing the requesting agent, tool, and sanitized arguments. The element must remain visible until the corresponding native OpenCode permission request is resolved. Native OpenCode permission controls remain authoritative; the plugin must not silently approve or deny requests.

Treat this document as the implementation contract. Verify all version-dependent OpenCode APIs against the installed OpenCode version and its published types before writing code. Do not invent compatibility shims for APIs that are absent.

## Problem

OpenCode can surface a permission request from a subagent in the primary TUI without enough context to make an informed decision. Bash prompts may omit command arguments, and MCP prompts may omit most call context. With concurrent subagents, the requester can also be unclear.

There is no current `opencode.json` option that controls expansion of permission details. Permission configuration controls only `allow`, `ask`, and `deny` decisions.

Related upstream report: <https://github.com/anomalyco/opencode/issues/15332>.

Nested descendants may have additional prompt-routing problems in affected OpenCode versions: <https://github.com/anomalyco/opencode/issues/13715>. This plugin must not claim to repair a permission event that OpenCode never delivers to the plugin or TUI.

## Goals

1. Show the origin subagent and tool for each pending permission request.
2. Show the fullest available sanitized invocation context, including Bash commands and MCP arguments.
3. Keep the information visible until that exact request is allowed, always allowed, rejected, cancelled, or otherwise removed.
4. Support multiple simultaneous pending requests without overwriting one request with another.
5. Preserve native OpenCode permission semantics and controls.
6. Keep the additional UI out of the conversation transcript and model context.
7. Fail safely when arguments, origin metadata, or newer TUI extension APIs are unavailable.

## Non-Goals

- Do not inject synthetic user, assistant, or system messages into a session.
- Do not call the model to summarize tool arguments.
- Do not auto-approve requests.
- Do not replace or reinterpret OpenCode permission rules.
- Do not fix OpenCode core routing for undelivered nested-subagent requests.
- Do not persist raw arguments or secrets to disk by default.
- Do not build a general session monitor or tool-call inspector.

## Verified OpenCode Extension Points

Use only APIs present in the installed version. Current upstream documentation/source exposes these relevant hooks:

```ts
"permission.ask"?: (
  input: Permission,
  output: { status: "ask" | "deny" | "allow" },
) => Promise<void>
```

`permission.ask` provides a permission request containing fields such as request/session identity, permission name, patterns, metadata, and optional tool identity. Exact fields must be taken from the installed `@opencode-ai/plugin` types.

`tool.execute.before` provides the tool name plus `sessionID` and `callID`, with mutable `output.args`. Use this hook only to capture a bounded in-memory snapshot of arguments before execution. Do not mutate the arguments.

The general `event` hook can observe OpenCode events. Inspect the installed event schema to identify the canonical permission resolution/removal events. Do not hard-code guessed event names.

The SDK exposes `client.tui.showToast`, but a toast has a fixed duration and is not tied to permission resolution. A toast is therefore a fallback notification, not the primary persistent UI.

Newer OpenCode versions expose TUI plugin slots/dialog primitives. Their exact registration and lifecycle API is version-dependent. Confirm availability in the installed package before selecting the persistent UI implementation.

## User Experience

### Primary View

Render a compact persistent panel near the session prompt or native permission area:

```text
Permission requests (2)

1  @explore · bash
   rg "permission.ask" packages/opencode
   Waiting for native Allow / Always / Reject

2  @librarian · context7.query-docs
   { libraryId: "/anomalyco/opencode", query: "..." }
   Waiting for native Allow / Always / Reject
```

Requirements:

- The panel is visible while at least one tracked request is pending.
- It disappears when no tracked requests remain.
- Requests use stable ordering: oldest pending request first.
- A newly arriving request must not replace an existing request.
- Long payloads are truncated in the compact view.
- A details action opens the full sanitized payload in a scrollable dialog when the installed TUI API supports it.
- The panel never contains its own Allow/Reject buttons in the initial implementation. The native permission dialog remains the only decision surface.
- The panel must clearly say when displayed data is incomplete, for example `Arguments unavailable from OpenCode`.

### Fallback Mode

If persistent TUI slots are unavailable:

1. Show a finite-duration warning toast when a request arrives.
2. Include requester, tool, and a short sanitized summary.
3. Keep the request in internal state for diagnostics, but do not imply that the toast persists until resolution.
4. Log one clear startup warning stating that the installed OpenCode version lacks the required persistent TUI API.

Do not repeatedly refresh a long-duration toast to simulate persistence. That causes stale notifications and poor behavior with concurrent requests.

## Architecture

### Components

1. `PermissionTracker`
   - Owns pending requests in memory.
   - Adds requests, enriches them with captured tool context, and removes them on canonical resolution/removal events.
   - Exposes a readonly ordered snapshot to the UI.

2. `ToolInvocationCache`
   - Captures arguments from `tool.execute.before`.
   - Keys entries by `(sessionID, callID)`.
   - Uses bounded size and TTL eviction to prevent unbounded memory growth.
   - Deletes an entry after it is attached to a permission request or after the tool finishes/fails when suitable lifecycle events exist.

3. `SessionResolver`
   - Resolves the requesting session and walks `parentID` links to the root session using the installed SDK.
   - Derives the origin agent name and task/session title from actual session data.
   - Uses request `sessionID` as the source of truth; labels unresolved origins explicitly rather than guessing.

4. `ArgumentSanitizer`
   - Produces display-safe structured data without modifying the underlying call.
   - Redacts sensitive values and enforces depth, item-count, string-length, and total-byte limits.

5. `PermissionOverlay`
   - Renders pending requests only in the relevant root/primary session view.
   - Supports compact rows and an optional details dialog.
   - Contains no permission-decision logic.

6. `ToastFallback`
   - Used only when persistent TUI extension APIs are unavailable.

### State Model

Define a strict type equivalent to:

```ts
type PendingPermission = {
  requestID: string
  requestSessionID: string
  rootSessionID: string | undefined
  originAgent: string | undefined
  originTitle: string | undefined
  permission: string
  toolName: string | undefined
  callID: string | undefined
  patterns: readonly string[]
  sanitizedArgs: unknown | undefined
  argsSource: "tool-cache" | "permission-metadata" | "unavailable"
  createdAt: number
}
```

Use the canonical permission request ID as the primary key. If the installed API does not expose one to the hook, derive a temporary correlation key only from stable request fields and document the collision risk in code. Prefer refusing persistent tracking over pretending an unsafe key is unique.

### Event Flow

1. A tool call enters `tool.execute.before`.
2. Store a sanitized or safely cloneable bounded snapshot under `(sessionID, callID)` without mutating `output.args`.
3. `permission.ask` fires.
4. Leave `output.status` as `ask` unless another existing plugin or explicit policy has already changed it. Never set `allow` automatically.
5. Resolve the root session and origin agent from session data.
6. Enrich the request from the invocation cache using its optional tool `callID`.
7. If no cache match exists, inspect documented permission metadata and patterns. Mark missing arguments as unavailable.
8. Insert the request into `PermissionTracker`.
9. Render or update the overlay in the primary/root session.
10. Native OpenCode renders and resolves its permission dialog.
11. On the canonical resolution/removal event, remove only the matching request.
12. Hide the overlay when the root session has no pending requests.

### Race Handling

- Permission resolution may arrive before asynchronous session enrichment completes. Insert a minimal request synchronously, then enrich it only if it remains pending.
- Multiple requests may share a session and tool name. Correlate by request ID and call ID, never by display text.
- Ignore duplicate delivery of the same request ID.
- Resolution of one request must not remove sibling requests.
- Session disposal must clear pending requests and invocation-cache entries belonging to that session tree.
- A plugin reload starts with empty state. Do not present old requests as live unless the installed SDK provides an authoritative pending-permissions query and it is verified during implementation.

## Argument Capture and Display

### Bash

Prefer captured tool arguments. Display the command exactly after sanitization and truncation. Do not execute shell parsing solely for display.

### Skills

Display the skill name from the permission pattern or verified metadata. If skill invocation input is captured by `tool.execute.before`, show a bounded argument summary.

### MCP

Display the generated OpenCode tool name and sanitized structured arguments captured by `tool.execute.before`. Do not assume `permission.ask.metadata` always contains the MCP payload.

### Unknown Tools

Display permission name, patterns, and verified metadata fields. Label the payload source. Never stringify arbitrary cyclic objects without a bounded safe serializer.

## Security and Privacy

The plugin exists to reveal context, but permission arguments can contain credentials. Implement redaction before rendering or logging.

Redact object keys matching a configurable case-insensitive set that includes:

```text
authorization
cookie
password
passwd
secret
token
api_key
apikey
private_key
client_secret
```

Also redact common bearer-token and private-key patterns inside strings. Keep this conservative and test it. Never attempt to read referenced files to produce a preview.

Default limits:

- Maximum object depth: 6.
- Maximum array/object entries per level: 50.
- Maximum displayed string length: 2,000 characters.
- Maximum full sanitized payload: 16 KiB.
- Maximum compact summary: 240 characters.
- Invocation-cache TTL: 10 minutes.
- Maximum cached invocations: 500.

Expose limits and additional redacted key names through plugin options only if the repository already has a typed plugin-options pattern. Otherwise keep constants local for the first version.

Never write raw or sanitized payloads to disk by default. Debug logging must be opt-in and must use sanitized data.

## Version Compatibility

Before implementation:

1. Determine the installed OpenCode version.
2. Inspect the exact exported plugin, permission, event, SDK, and TUI slot types for that version.
3. Record the minimum supported version in the plugin README/package metadata.
4. Choose one supported persistent TUI API. Do not use runtime `any`, `@ts-ignore`, `@ts-expect-error`, or undocumented property probing.
5. If the installed version lacks a typed persistent TUI extension API, implement only the explicit toast fallback and report the limitation. Do not patch OpenCode internals from the plugin.

Configuration changes and plugin files are loaded at OpenCode startup. Document that OpenCode must be fully restarted after installation or configuration changes.

## Failure Behavior

- UI rendering failure must not block or resolve the native permission request.
- Session lookup failure renders an `Unknown subagent` label.
- Missing arguments render an explicit unavailable marker.
- Sanitization failure renders only permission type and patterns.
- Event-schema mismatch detected at startup disables persistent mode and emits one actionable warning.
- Never swallow errors silently; use OpenCode's plugin logging facilities with sanitized structured fields.

## Testing

### Unit Tests

Cover:

- Request insertion, deduplication, ordering, and exact removal.
- Concurrent requests from sibling subagents.
- Multiple requests from one tool/session.
- Resolution-before-enrichment race.
- Invocation correlation by `(sessionID, callID)`.
- Cache TTL and maximum-size eviction.
- Root-session traversal and missing-parent behavior.
- Redaction of nested keys and sensitive string patterns.
- Depth, entry-count, string-length, and byte truncation.
- Cyclic and non-JSON-compatible argument values.

### UI Tests

Cover:

- Panel appears for one pending child request.
- Panel remains until the matching resolution event.
- Resolving one of two requests leaves the other visible.
- Compact truncation and details-dialog rendering.
- Correct root-session scoping.
- Unknown origin and unavailable arguments states.

### Integration Test

Run OpenCode with a test subagent whose Bash permission is `ask`:

1. Spawn the subagent from a primary session.
2. Make it request a harmless command with distinctive arguments.
3. Verify the primary TUI shows agent, tool, and command before approval.
4. Verify the native permission prompt remains authoritative.
5. Approve once and verify only that overlay item disappears.
6. Repeat with rejection.
7. Run two requests concurrently and resolve them in reverse order.
8. Repeat with an MCP fixture containing nested arguments and a fake secret; verify context is shown and the secret is redacted.

If nested subagents are supported by the installed OpenCode version, add a depth-two case. If OpenCode fails to deliver the request, report it as the known core limitation rather than weakening the test.

## Acceptance Criteria

- A direct child subagent's pending Bash request is understandable from the primary TUI without navigating to the child session.
- A delivered nested-subagent request identifies its actual origin and root session.
- MCP arguments are shown when captured by `tool.execute.before`.
- Sensitive values are redacted before reaching the UI or logs.
- The overlay persists until exact resolution, not for an arbitrary timer.
- Concurrent requests are independently visible and independently removed.
- Native OpenCode Allow/Always/Reject behavior is unchanged.
- No synthetic chat messages are created.
- No permission is automatically approved.
- Missing context is labeled rather than invented.
- Unsupported OpenCode versions degrade to a truthful finite-duration toast warning.
- Type checking, unit tests, UI tests, and the integration scenario pass.

## Deliverables

Produce:

1. The plugin implementation using the repository's existing language, package manager, formatter, and test conventions.
2. Unit and UI tests plus one automated or reproducible integration test.
3. A README covering installation, minimum OpenCode version, restart requirement, UI behavior, fallback behavior, security/redaction, and known nested-subagent limitations.
4. A minimal configuration example that registers the plugin without broadening any existing permission rule.
5. A short implementation note listing the exact installed OpenCode types/events used for request creation and resolution.

## Implementation Constraints

- Read the target repository and installed OpenCode type definitions before editing.
- Follow existing project conventions; do not create a parallel architecture when suitable utilities exist.
- Keep strict types. Never use `any`, unsafe casts, suppression comments, or empty catch blocks.
- Do not change unrelated permission rules or agent definitions.
- Do not commit, publish, or install globally unless explicitly requested.
- Validate with type checking, focused tests, and a real TUI run before declaring completion.
