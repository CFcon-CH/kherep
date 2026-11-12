import fs from "node:fs";
import path from "node:path";
import type test from "node:test";

import { makeEnvelope, parseEnvelope, type Envelope } from "../protocol.mts";
import { MESSAGING_PROXY_CAPABILITY, type MessageSendBody } from "../protocol-messages.mts";
import { listenerDir, wakeAudit } from "./autonomy.mts";
import { NodeClient } from "./client.mts";
import { busyPolicyFingerprint } from "./codex-busy-policy.mts";
import { advanceForkAttempt, claimForkAttempt, forkAttempts, type ForkAttempt } from "./codex-fork-attempts.mts";
import { FORK_ID, FORK_OWNER, forkNode, LAST_TURN } from "./codex-fork-fixture.mts";
import { legacyForkPoll } from "./codex-fork-legacy-poll.mts";
import { relayPending, relaySendGate, resetRelayState } from "./codex-fork-relay.mts";
import type { CodexDeps } from "./codex-process.mts";
import { codexQueueIdle, pollCodexQueue } from "./codex-queue.mts";
import { exchangeOptions, pollExchange } from "./exchange.mts";
import { generateIdentity } from "./identity.mts";
import { readJson, writeJsonAtomic } from "./inbox.mts";
import { DEFAULT_POLICY, readPolicy } from "./policy.mts";

// Issue #408, PR 4 (design r3 section 6): a fork node whose Worker capability
// the test sets (the connection-bound value of client.mts), seeded completed
// attempts in the PR 3 shape, the owner's session record, and one exchange
// round through pollExchange with the relay's send gate. Synthetic only.

export const DAY = 24 * 60 * 60_000;
export type RelayNode = ReturnType<typeof relayNode>;

const decode = (frames: string[]): Envelope[] => frames.map((frame) => {
  const parsed = parseEnvelope(frame);
  if (!parsed.ok) throw new Error("undecodable frame");
  return parsed.envelope;
});

export function relayNode(t: test.TestContext, options: { capability?: boolean } = {}) {
  resetRelayState();
  t.after(() => resetRelayState());
  const f = forkNode(t, {}, { capability: options.capability });
  let capabilities: () => readonly string[] | null = () => [MESSAGING_PROXY_CAPABILITY];
  const now = (): number => f.deps().now!();
  const deps = (extra: CodexDeps = {}) => ({ ...f.deps(extra), workerCapabilities: () => capabilities() });
  const client = new NodeClient({
    nodeId: "00000000-0000-4000-8000-0000000000aa", identity: generateIdentity(), policy: DEFAULT_POLICY,
    handlers: { "node.status": async () => ({}), "runtime.list": async () => [], "session.list": async () => [] },
    facts: () => ({ hostname: "node-a.example.com", os: "linux", arch: "x64", cpus: 1, memoryBytes: 1 }),
    runtimes: async () => [], sessions: async () => [], storeMessage: () => {}, ...exchangeOptions(f.paths, now),
  });
  const authenticated = client.onFrame(JSON.stringify(makeEnvelope("event", { name: "auth.ok" }, 0, 0)));
  const inflight = new Map<string, number>();
  const logs: string[] = [];
  const log = (line: string): void => { logs.push(line); };

  // A completed attempt as PR 3 leaves it; fields override the defaults.
  const seed = (messageId: string, fields: { attemptedAt?: number; answer?: string; policyFingerprint?: string } = {}): ForkAttempt => {
    const policyFingerprint = fields.policyFingerprint ?? busyPolicyFingerprint(readPolicy(f.paths.policy, true)!);
    const at = fields.attemptedAt ?? now();
    claimForkAttempt(f.paths, { owner: FORK_OWNER, messageId, attemptedAt: at, policyFingerprint, producer: { route: "local" } });
    advanceForkAttempt(f.paths, FORK_OWNER, messageId, "launching", "running", { lastTurnId: LAST_TURN, forkId: FORK_ID }, at);
    return advanceForkAttempt(f.paths, FORK_OWNER, messageId, "running", "completed", { answer: fields.answer ?? "Green." }, at);
  };
  const policy = (change: (policy: Record<string, any>) => void): void => {
    const value = JSON.parse(fs.readFileSync(f.paths.policy, "utf8"));
    change(value);
    fs.writeFileSync(f.paths.policy, JSON.stringify(value));
  };
  const session = (change: Record<string, unknown> | null): void => {
    const file = path.join(f.paths.codexSessions, `${FORK_OWNER}.json`);
    if (change === null) fs.rmSync(file, { force: true });
    else writeJsonAtomic(file, { ...readJson<object>(file), ...change });
  };
  const attempt = (messageId: string): ForkAttempt => forkAttempts(f.paths, FORK_OWNER).find((a) => a.messageId === messageId)!;
  return {
    ...f, deps, log, logs, client, inflight, seed, policy, session, attempt,
    capability: (value: readonly string[] | null) => { capabilities = () => value; },
    // The capability as another object holds it (the daemon's client).
    capabilityFrom: (source: () => readonly string[] | null) => { capabilities = source; },
    // The sweep alone, as the poll loop calls it.
    sweep: (extra: CodexDeps = {}) => relayPending(deps(extra), FORK_OWNER, log),
    // The real poll and lane: since issue #890 only the relay bookkeeping, no sweep and no fork producer.
    poll: async (extra: CodexDeps = {}) => { pollCodexQueue(deps(extra), log); await codexQueueIdle(); },
    // The poll as it was before issue #890: the sweep, then the fork producer (codex-fork-legacy-poll.mts).
    legacyPoll: async (extra: CodexDeps = {}) => { legacyForkPoll(deps(extra), log); await codexQueueIdle(); },
    // One exchange round with the gate; the message.send bodies that went out.
    exchange: async (extra: CodexDeps = {}, gate = relaySendGate(deps(extra), log)): Promise<MessageSendBody[]> => {
      await authenticated;
      const sent: string[] = [];
      pollExchange(client, f.paths, inflight, (frame) => { sent.push(frame); return true; }, now(), () => 0, gate);
      return decode(sent).filter((e) => e.type === "message.send").map((e) => e.body as unknown as MessageSendBody);
    },
    // A Worker status frame for a message this node sent; the frames the client answered.
    status: async (messageId: string, state: string, reason?: string): Promise<Envelope[]> => {
      await authenticated;
      return decode(await client.onFrame(JSON.stringify(makeEnvelope("message.status",
        { messageId, state, ...(reason ? { reason } : {}) }, 0, 0))));
    },
    outbox: (): string[] => (fs.existsSync(f.paths.outbox) ? fs.readdirSync(f.paths.outbox).filter((n) => !n.startsWith(".")) : []),
    turns: (): number[] => {
      const file = path.join(listenerDir(f.paths), `${FORK_OWNER}.turns.json`);
      return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as { turns: number[] }).turns : [];
    },
    audit: (): string[] => (fs.existsSync(wakeAudit(f.paths))
      ? fs.readFileSync(wakeAudit(f.paths), "utf8").trim().split("\n").map((line) => JSON.parse(line).action as string) : [])
      .filter((action) => action.startsWith("fork")),
    killSwitch: (on: boolean) => {
      const file = path.join(f.paths.dir, "wake.disabled");
      if (on) fs.writeFileSync(file, "");
      else fs.rmSync(file, { force: true });
    },
  };
}
