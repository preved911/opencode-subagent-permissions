import { describe, expect, it } from "vitest"
import {
  createArgsLookup,
  selectVisibleRequests,
  toPendingRequests,
  type PermissionRequestLike,
} from "../src/shared/panel.ts"
import { compactRows } from "../src/shared/render.ts"
import { ARGS_UNAVAILABLE_MARKER, type PendingPermission } from "../src/shared/types.ts"

const ROOT = "ses_root"
const CHILD = "ses_child"
const SIBLING = "ses_sibling"
const OTHER = "ses_other"

const chains: Record<string, string[]> = {
  [CHILD]: [CHILD, ROOT],
  [SIBLING]: [SIBLING, ROOT],
  [OTHER]: [OTHER],
}

const chainOf = (sessionID: string): string[] | undefined => chains[sessionID]

function makeNative(overrides: Partial<PermissionRequestLike> & { id: string }): PermissionRequestLike {
  return {
    sessionID: CHILD,
    permission: "bash",
    patterns: ["*"],
    metadata: {},
    ...overrides,
  }
}

describe("panel visibility (UI scoping)", () => {
  it("shows a pending child request in the root session view", () => {
    const visible = selectVisibleRequests([makeNative({ id: "p1", sessionID: CHILD })], ROOT, chainOf)
    expect(visible).toHaveLength(1)
  })

  it("hides requests belonging to unrelated session trees", () => {
    const visible = selectVisibleRequests(
      [makeNative({ id: "p1", sessionID: OTHER })],
      ROOT,
      chainOf,
    )
    expect(visible).toHaveLength(0)
  })

  it("shows requests from any descendant of the viewed root", () => {
    const visible = selectVisibleRequests(
      [
        makeNative({ id: "p1", sessionID: CHILD }),
        makeNative({ id: "p2", sessionID: SIBLING }),
      ],
      ROOT,
      chainOf,
    )
    expect(visible).toHaveLength(2)
  })

  it("does not show a child-tree request when viewing a sibling session", () => {
    const visible = selectVisibleRequests([makeNative({ id: "p1", sessionID: CHILD })], SIBLING, chainOf)
    expect(visible).toHaveLength(0)
  })

  it("shows a direct request while viewing that session itself", () => {
    const visible = selectVisibleRequests([makeNative({ id: "p1", sessionID: OTHER })], OTHER, chainOf)
    expect(visible).toHaveLength(1)
  })
})

describe("panel view model", () => {
  const partsByMessage: Record<string, unknown[]> = {
    msg_1: [
      {
        type: "tool",
        callID: "call_1",
        state: { status: "running", input: { command: "rg permission.ask packages/opencode" } },
      },
    ],
  }

  const argsOf = createArgsLookup((messageID) => partsByMessage[messageID])

  const lookups = {
    argsOf,
    chainOf,
    originOf: (sessionID: string) =>
      sessionID === CHILD
        ? { agent: "explore", title: "Search the codebase" }
        : sessionID === SIBLING
          ? { agent: "librarian", title: "Find docs" }
          : { agent: undefined, title: undefined },
    now: () => 5_000,
  }

  it("builds the display model with origin, tool and args source", () => {
    const [model] = toPendingRequests(
      [makeNative({ id: "p1", tool: { messageID: "msg_1", callID: "call_1" } })],
      lookups,
    )
    expect(model).toMatchObject({
      requestID: "p1",
      rootSessionID: ROOT,
      originAgent: "explore",
      permission: "bash",
      argsSource: "session-parts",
    })
    expect(JSON.stringify(model.sanitizedArgs)).toContain("rg permission.ask")
  })

  it("falls back to permission metadata when the tool part is missing", () => {
    const [model] = toPendingRequests(
      [makeNative({ id: "p1", metadata: { command: "printf hello" } })],
      lookups,
    )
    expect(model.argsSource).toBe("permission-metadata")
    expect(JSON.stringify(model.sanitizedArgs)).toContain("printf hello")
  })

  it("labels missing context instead of inventing it", () => {
    const [model] = toPendingRequests([makeNative({ id: "p1", metadata: {} })], lookups)
    expect(model.argsSource).toBe("unavailable")
    const rows = compactRows([model])
    expect(rows.join("\n")).toContain(ARGS_UNAVAILABLE_MARKER)
  })

  it("labels unresolved origins explicitly", () => {
    const [model] = toPendingRequests([makeNative({ id: "p1", sessionID: "ses_unknown" })], {
      ...lookups,
      chainOf: () => undefined,
      originOf: () => undefined,
    })
    expect(model.originAgent).toBeUndefined()
    expect(model.rootSessionID).toBeUndefined()
    expect(compactRows([model])[0]).toContain("Unknown subagent")
  })

  it("resolving one of two requests leaves the other visible", () => {
    const first = toPendingRequests(
      [makeNative({ id: "p1", tool: { messageID: "msg_1", callID: "call_1" } })],
      lookups,
    )
    const second = toPendingRequests(
      [makeNative({ id: "p2", sessionID: SIBLING, permission: "webfetch", metadata: { url: "https://example.com" } })],
      lookups,
    )
    const rows = compactRows([...second])
    expect(rows.join("\n")).toContain("https://example.com")
    expect(rows.join("\n")).not.toContain("rg permission.ask")
    expect(first).toHaveLength(1)
  })

  it("keeps stable ordering via firstSeen across re-renders", () => {
    const requests = [makeNative({ id: "p1" }), makeNative({ id: "p2", sessionID: SIBLING })]
    const firstSeen = new Map<string, number>([
      ["p1", 100],
      ["p2", 200],
    ])
    const models = toPendingRequests(requests, lookups, firstSeen)
    expect(models.map((m: PendingPermission) => m.createdAt)).toEqual([100, 200])
  })

  it("redacts secrets from displayed metadata", () => {
    const [model] = toPendingRequests(
      [
        makeNative({
          id: "p1",
          metadata: { command: "curl -H 'Authorization: Bearer supersecret123'", apiKey: "sk-toplevel" },
        }),
      ],
      lookups,
    )
    const rendered = JSON.stringify(model.sanitizedArgs)
    expect(rendered).not.toContain("supersecret123")
    expect(rendered).not.toContain("sk-toplevel")
  })
})
