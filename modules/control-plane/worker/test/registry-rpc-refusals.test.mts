import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { ClaudeSlotSelection } from "../../protocol.mts";
import type { CodexActivityRegistration } from "../../protocol-mcp.mts";
import { replaceIntercomSlot, type SlotOccupant } from "../src/intercom-slots.mts";
import { enroll, FACTS, newKey, registry } from "./helpers.mts";

// Issue #965: Registry RPC refusals for connection, activity, Claude slot
// selection that do not meet their preconditions, and the Codex slot address.
async function connected(os: string, runtimes = ["claude"]): Promise<{ nodeId: string; token: string }> {
  const nodeId = await enroll(await newKey(), `rpc-${crypto.randomUUID()}`), token = crypto.randomUUID();
  expect(await registry().beginMessageConnection(nodeId, token)).toBe(true);
  await registry().updateRegistration(nodeId, { ...FACTS, os }, runtimes.map((name) => ({ name, kind: "cli" as const })), ["messaging.v1"], token);
  return { nodeId, token };
}

function selection(slot: ClaudeSlotSelection["slot"]): ClaudeSlotSelection {
  const now = Date.now();
  return { slot, sessionId: crypto.randomUUID(), promptId: crypto.randomUUID(), requestId: crypto.randomUUID(), observedAt: now, expiresAt: now + 20_000 };
}

describe("Registry connection and activity refusals", () => {
  it("refuses to begin a message connection without a token", async () => {
    const nodeId = await enroll(await newKey());
    expect(await registry().beginMessageConnection(nodeId, "")).toBe(false);
  });

  it("refuses a malformed Codex activity registration", async () => {
    const { nodeId, token } = await connected("darwin", ["codex"]);
    expect(await registry().registerCodexActivity(nodeId, {} as CodexActivityRegistration, token))
      .toEqual({ ok: false, error: "invalid intent metadata" });
  });

  it("returns the runtime version and endpoint a node registered", async () => {
    const nodeId = await enroll(await newKey());
    await registry().updateRegistration(nodeId, FACTS, [{ name: "codex", kind: "cli", version: "1.2.3" }], []);
    expect((await registry().getNode(nodeId))?.runtimes).toEqual([{ name: "codex", kind: "cli", version: "1.2.3" }]);
  });
});

describe("Claude slot selection refusals", () => {
  const denied = (request: ClaudeSlotSelection) => ({ result: { kind: "slot-selection", requestId: request.requestId,
    slot: request.slot, outcome: "denied", revision: null } });

  it("denies a malformed request and a request on a stale connection token", async () => {
    const { nodeId, token } = await connected("darwin");
    const malformed = { ...selection("claude-mac"), expiresAt: 0 };
    expect(await registry().prepareClaudeSelection(nodeId, malformed, token)).toEqual(denied(malformed));
    const request = selection("claude-mac");
    expect(await registry().prepareClaudeSelection(nodeId, request, crypto.randomUUID())).toEqual(denied(request));
  });

  it("denies a node on an unsupported platform, the other platform's slot, or without the Claude CLI", async () => {
    const linux = await connected("linux"), mac = await connected("darwin"), codexOnly = await connected("darwin", ["codex"]);
    const linuxRequest = selection("claude-mac"), windowsRequest = selection("claude-windows"), cliRequest = selection("claude-mac");
    expect(await registry().prepareClaudeSelection(linux.nodeId, linuxRequest, linux.token)).toEqual(denied(linuxRequest));
    expect(await registry().prepareClaudeSelection(mac.nodeId, windowsRequest, mac.token)).toEqual(denied(windowsRequest));
    expect(await registry().prepareClaudeSelection(codexOnly.nodeId, cliRequest, codexOnly.token)).toEqual(denied(cliRequest));
  });
});

describe("slot address", () => {
  const occupy = (occupant: SlotOccupant | null) => runInDurableObject(registry(), (_i, state) => {
    const revision = Number(state.storage.sql.exec("SELECT revision FROM intercom_slots WHERE slot='codex-mac'").one().revision);
    expect(replaceIntercomSlot(state.storage.sql, "codex-mac", revision, occupant)).toBe(revision + 1);
  });

  // A Claude occupant cannot be written to a Codex slot (replaceIntercomSlot
  // throws "invalid Intercom slot occupant"), so only the Codex answer is reachable.
  it("answers a Codex slot with its Codex occupant", async () => {
    const { nodeId, token } = await connected("darwin", ["codex"]);
    const sessionId = crypto.randomUUID(), requestId = crypto.randomUUID();
    try {
      await occupy({ nodeId, runtime: "codex", sessionId, chatName: "Synthetic Codex chat" });
      expect(await registry().slotAddress(nodeId, token, "codex-mac", requestId))
        .toEqual({ kind: "slot-address", slot: "codex-mac", requestId, address: { nodeId, session: sessionId } });
    } finally {
      await occupy(null);
    }
  });
});
