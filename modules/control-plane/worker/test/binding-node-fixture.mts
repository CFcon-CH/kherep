import { runInDurableObject } from "cloudflare:test";
import { afterEach, vi } from "vitest";
import { makeEnvelope, parseEnvelope } from "../../protocol.mts";
import { isResolveRequest, SELECTED_BINDING_CAPABILITY, type SelectedResult } from "../../protocol-message-binding.mts";
import { authenticate, enroll, FACTS, newKey, registry, session, type NodeKey } from "./helpers.mts";
const owned: { nodeId: string; socket: Awaited<ReturnType<typeof authenticate>> }[] = [];
afterEach(async () => {
  const closing = owned.splice(0);
  for (const f of closing) f.socket.ws.close();
  for (const nodeId of new Set(closing.map(f => f.nodeId))) await vi.waitFor(async () => {
    const token = await runInDurableObject(registry(), (_i, state) => state.storage.sql.exec("SELECT message_connection_token FROM nodes WHERE id=?", nodeId).one().message_connection_token);
    if (token !== null) throw new Error("synthetic close invalidation pending");
  });
});
export interface SelectedFixtureRow { sessionId: string; runtime: string; name?: string; lifecycleGeneration?: number }
export async function bindingNode(initialRows: SelectedFixtureRow[], capabilities = ["messaging.v1", "messaging.loop-brake.v1"]) {
  const key = await newKey(), nodeId = await enroll(key, "synthetic-binding-owner");
  return bindingConnection(nodeId, key, initialRows, capabilities);
}
export async function bindingConnection(nodeId: string, key: NodeKey, initialRows: SelectedFixtureRow[], capabilities: string[]) {
  const socket = await authenticate(nodeId, key);
  owned.push({ nodeId, socket });
  let sequence = 1, rows = initialRows;
  let beforeResponse: (() => Promise<void>) | undefined;
  socket.ws.addEventListener("message", event => {
    const frame = parseEnvelope(event.data as string);
    if (!frame.ok || frame.envelope.type !== "message.resolve.request" || !isResolveRequest(frame.envelope.body)) return;
    const request = frame.envelope.body, selected = rows;
    const results = request.selections.map((selection): SelectedResult => {
      const exact = selected.filter(r => r.sessionId === selection.ref);
      const matches = exact.length ? exact : selected.filter(r => r.name === selection.ref);
      if (matches.length !== 1) return { role: selection.role, code: matches.length ? "AMBIGUOUS" : "MISSING" };
      const owner = { sessionId: matches[0].sessionId, runtime: matches[0].runtime };
      if (selection.expected && (selection.expected.sessionId !== owner.sessionId || selection.expected.runtime !== owner.runtime)) return { role: selection.role, code: "CONFLICT" };
      return { role: selection.role, code: "BOUND", match: exact.length ? "exact" : "alias", owner,
        localGeneration: null, lifecycleGeneration: matches[0].lifecycleGeneration ?? null, selectionStamp: crypto.randomUUID(), leaseId: crypto.randomUUID() };
    });
    const hook = beforeResponse; beforeResponse = undefined;
    void (hook?.() ?? Promise.resolve()).then(() => { socket.send(makeEnvelope("message.resolve.response", { version: 1, requestId: request.requestId, messageId: request.messageId, results }, ++sequence, 0)); });
  });
  socket.send(makeEnvelope("register", { facts: FACTS, runtimes: [{ name: "codex", kind: "cli" }], capabilities: [...capabilities, SELECTED_BINDING_CAPABILITY] }, sequence, 0));
  await vi.waitFor(async () => { if (!(await session(nodeId).loopCapabilityEvidence()).registered) throw new Error("synthetic register pending"); });
  return { nodeId, key, socket, nextSequence: () => ++sequence, setRows: (value: SelectedFixtureRow[]) => { rows = value; },
    beforeResponse: (run: () => Promise<void>) => { beforeResponse = run; } };
}
