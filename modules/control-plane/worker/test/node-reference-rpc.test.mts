import { expect, it } from "vitest";
import { NodeReferenceRpc } from "../src/node-reference-rpc.mts";
import type { ResolveRequest, ResolveResponse } from "../../protocol-message-binding.mts";
const request = (): ResolveRequest => ({ version: 1, requestId: crypto.randomUUID(), messageId: crypto.randomUUID(), purpose: "admit",
  selections: [{ role: "to", ref: "synthetic-owner" }], expiresAt: Date.now() + 5000 });
const response = (r: ResolveRequest): ResolveResponse => ({ version: 1, requestId: r.requestId, messageId: r.messageId,
  results: [{ role: "to", code: "MISSING" }] });
it("S13: wrong socket, token, request, message, role and malformed response release no request", async () => {
  const rpc = new NodeReferenceRpc(), socket = {} as WebSocket, other = {} as WebSocket, r = request(); let sent = 0;
  const pending = rpc.request(socket, "one", r, () => { sent++; }, () => true);
  expect(sent).toBe(1);
  const good = response(r);
  expect(rpc.receive(other, "one", good)).toBe(false);
  expect(rpc.receive(socket, "two", good)).toBe(false);
  expect(rpc.receive(socket, "one", { ...good, requestId: crypto.randomUUID() })).toBe(false);
  expect(rpc.receive(socket, "one", { ...good, messageId: crypto.randomUUID() })).toBe(false);
  expect(rpc.receive(socket, "one", { ...good, results: [{ role: "from", code: "MISSING" }] })).toBe(false);
  expect(rpc.receive(socket, "one", { ...good, private: "CANARY" })).toBe(false);
  expect(rpc.receive(socket, "one", good)).toBe(true);
  expect(await pending).toEqual(good);
  expect(rpc.receive(socket, "one", good)).toBe(false);
});
it("S13: malformed BOUND local generation preserves the pending request for a corrected response", async () => {
  const rpc = new NodeReferenceRpc(), socket = {} as WebSocket, r = request();
  const pending = rpc.request(socket, "one", r, () => {}, () => true);
  const good: ResolveResponse = { ...response(r), results: [{ role: "to", code: "BOUND", match: "exact",
    owner: { sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", runtime: "codex" },
    selectionStamp: crypto.randomUUID(), leaseId: crypto.randomUUID(), localGeneration: 0, lifecycleGeneration: null }] };
  try {
    expect(rpc.receive(socket, "one", { ...good, results: [{ ...good.results[0], localGeneration: "bad" }] })).toBe(false);
    expect(rpc.receive(socket, "one", good)).toBe(true);
    expect(await pending).toEqual(good);
  } finally {
    rpc.clear(socket);
    await pending;
  }
});
it("S14: capacity and close/replacement are bounded and never produce a legacy response", async () => {
  const rpc = new NodeReferenceRpc(), socket = {} as WebSocket; let sent = 0;
  const pending = Array.from({ length: 32 }, () => rpc.request(socket, "one", request(), () => { sent++; }, () => true));
  expect(await rpc.request(socket, "one", request(), () => { sent++; }, () => true)).toBeNull();
  expect(sent).toBe(32); rpc.clear(socket);
  expect(await Promise.all(pending)).toEqual(Array(32).fill(null));
  const r = request(); let current = true;
  const stale = rpc.request(socket, "one", r, () => {}, () => current);
  current = false; expect(rpc.receive(socket, "one", response(r))).toBe(true); expect(await stale).toBeNull();
  rpc.clear();
});
it("S14: expired request and send failure leave no pending permission", async () => {
  const rpc = new NodeReferenceRpc(), socket = {} as WebSocket, r = request(); r.expiresAt = Date.now() - 1;
  expect(await rpc.request(socket, "one", r, () => { throw new Error("must not send"); }, () => true)).toBeNull();
  const fresh = request();
  expect(await rpc.request(socket, "one", fresh, () => { throw new Error("synthetic socket closed"); }, () => true)).toBeNull();
  expect(rpc.receive(socket, "one", response(fresh))).toBe(false);
  const timeout = request(); timeout.expiresAt = Date.now() + 10;
  expect(await rpc.request(socket, "one", timeout, () => {}, () => true)).toBeNull();
  expect(rpc.receive(socket, "one", response(timeout))).toBe(false);
});
