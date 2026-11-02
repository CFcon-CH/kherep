import { expect, it } from "vitest";
import { normalizeLoopText, isAcknowledgementOnly, prepareLoopSignal } from "../src/message-loop-signals.mts";
import { pairIdentity } from "../src/message-loop-identity.mts";
const sign = async (domain: string, text: string) => {
  const key = await crypto.subtle.importKey("raw", new Uint8Array(32).fill(7), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(JSON.stringify([domain, text]))))].map((v) => v.toString(16).padStart(2, "0")).join("");
};
it("normalizes presentation only and matches only the complete bounded ACK lexicon", async () => {
  expect(normalizeLoopText(" ＯＫ  Test\n17 /A ")).toBe("ok test 17 /a");
  for (const text of ["ack", "OK!", "Danke, verstanden.", "thank you! got it.", " \n "]) expect(isAcknowledgementOnly(text), text).toBe(true);
  for (const text of ["OK?", "Thanks, test 17 now passes", "ack /work", "ok: code", "ok `x`", "已收到", "acknowledgement", "ok ".repeat(40)]) expect(isAcknowledgementOnly(text), text).toBe(false);
  expect((await prepareLoopSignal(" Result １７  ", sign)).fingerprint).toBe((await prepareLoopSignal("result 17", sign)).fingerprint);
  expect((await prepareLoopSignal("result 17!", sign)).fingerprint).not.toBe((await prepareLoopSignal("result 17", sign)).fingerprint);
});
it("strips only the exact verified owner/original proxy prefix; fork UUID changes cannot disguise ACK", async () => {
  const owner = crypto.randomUUID(), messageId = crypto.randomUUID();
  const text = () => `Kherep proxy answer: an ephemeral fork of session ${owner} (fork ${crypto.randomUUID()}) answered message ${messageId} while the owner was idle. The owner has not read your message yet.\n\nOK!`;
  const a = await prepareLoopSignal(text(), sign, { owner, messageId });
  const b = await prepareLoopSignal(text(), sign, { owner, messageId });
  expect(a).toEqual(b); expect(a.acknowledgement).toBe(true);
  expect((await prepareLoopSignal(text(), sign)).acknowledgement).toBe(false);
  expect((await prepareLoopSignal(text(), sign, { owner: crypto.randomUUID(), messageId })).acknowledgement).toBe(false);
  expect(Object.keys(a)).toEqual(["fingerprint", "acknowledgement"]);
});
it("orders exact UTF8 endpoint tuples and reverses the bit without changing pair encoding", () => {
  const a = { nodeId: "n", session: "A" }, b = { nodeId: "n", session: "é" };
  expect(pairIdentity(a, b)?.direction).toBe(0);
  expect(pairIdentity(b, a)).toEqual({ encoding: pairIdentity(a, b)!.encoding, direction: 1 });
  expect(pairIdentity(a, a)).toBeNull();
});
