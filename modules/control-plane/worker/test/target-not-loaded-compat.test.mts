import { expect, it, vi } from "vitest";
import { blockerDiagnostic, MESSAGING_DIAGNOSTICS_CAPABILITY as V1, MESSAGING_DIAGNOSTICS_V2_CAPABILITY as V2,
  MESSAGING_DIAGNOSTICS_V3_CAPABILITY as V3 } from "../../protocol-diagnostics.mts";
import { makeEnvelope } from "../../protocol.mts";
import { MESSAGING_CAPABILITY } from "../../protocol-messages.mts";
import { isMessageDiagnostic as preV3Accepts } from "../../test/fixtures/diagnostics-pre-v3.mts";
import { authenticate, enroll, FACTS, newKey, registry, session, until } from "./helpers.mts";

// Issue #883: a target node reports target-not-loaded under target-busy. The Worker keeps the reported code in the row
// and hands a sender without messaging.diagnostics.v3 target-not-idle, the code that sender validates.
type Diagnosed = { diagnostic?: { code?: string; observedState?: string }; progress?: { code?: string } };
const progress = { phase: "waiting" as const, code: "target-busy" as const, observedAt: "2026-11-12T00:00:00.000Z" };

async function reported(senderCaps: string[]) {
  const key = await newKey(), source = await enroll(key), target = await enroll(await newKey());
  await registry().updateRegistration(source, FACTS, [], senderCaps);
  await registry().updateRegistration(target, FACTS, [], [MESSAGING_CAPABILITY, V1, V2, V3]);
  const messageId = crypto.randomUUID();
  await registry().sendMessage({ messageId, from: { nodeId: source, session: "sender" }, to: { nodeId: target, session: "target" }, text: "Synthetic" }, "test");
  const diagnostic = blockerDiagnostic("target-not-loaded", Date.parse(progress.observedAt), "target-progress", "unknown");
  const result = await registry().reportMessageStatus(target, { messageId, state: "accepted", progress, diagnostic });
  return { key, source, messageId, diagnostic, routed: result.effects.statuses[0].body as Diagnosed };
}

for (const modern of [false, true]) it(`a target-not-loaded report, v3 sender=${modern}: routed, replayed and pushed bodies follow the sender`, async () => {
  const caps = [MESSAGING_CAPABILITY, V1, V2, ...(modern ? [V3] : [])];
  const { key, source, messageId, diagnostic, routed } = await reported(caps);
  const expected = modern ? "target-not-loaded" : "target-not-idle";
  expect(routed.progress?.code).toBe("target-busy");
  expect(routed.diagnostic).toEqual({ ...diagnostic, code: expected });
  const page = await registry().messageStatusPageFor(source, 0, 100);
  expect((page.effects.statuses.find(s => s.body.messageId === messageId)?.body as Diagnosed).diagnostic?.code).toBe(expected);
  expect((await registry().mcpMessageStatus(source, messageId) as Diagnosed).diagnostic?.code).toBe("target-not-loaded");
  const socket = await authenticate(source, key);
  socket.send(makeEnvelope("register", { facts: FACTS, runtimes: [], capabilities: caps }, 1, 0));
  await vi.waitFor(async () => { expect((await session(source).loopCapabilityEvidence()).registered).toBe(true); });
  await session(source).pushFrame("message.status", { messageId, state: "accepted", progress, diagnostic });
  // The status replay at authentication runs before register, so it carries no diagnostic; skip it to reach the push.
  let pushed: Diagnosed = {};
  for (let attempt = 0; pushed.diagnostic === undefined && attempt < 4; attempt++) {
    pushed = (await until(socket, "message.status", { messageId, state: "accepted" }, 32)).at(-1)!.body as Diagnosed;
  }
  expect(pushed.diagnostic?.code).toBe(expected);
  if (!modern) for (const body of [routed, pushed]) expect(preV3Accepts(body.diagnostic)).toBe(true);
  socket.ws.close();
});
