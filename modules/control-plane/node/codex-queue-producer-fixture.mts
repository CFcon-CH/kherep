import { fixtureEvidence, publishSynthetic } from "./session-authority-fixture.mts";
import fs from "node:fs";
import { writeLocalSessions } from "./exchange-sessions.mts";
import { publishLiveness } from "./session-lifecycle.mts";
import path from "node:path";
import type test from "node:test";

import { codexNode, fakeCodexBin } from "./codex-fixture.mts";
import { codexQueueIdle, pollCodexQueue } from "./codex-queue.mts";
import { codexSessionName, recordCodexSession } from "./codex-sessions.mts";
import { storeMessage } from "./inbox.mts";
import { T0 } from "./task-fixture.mts";

export const NATIVE_OWNER = "01a0db01-0000-7000-8000-000000000001";
const PEER = { nodeId: "00000000-0000-4000-8000-0000000000bb", session: "public-synthetic-peer" };
let serial = 0;
// options.seenAt: the hook record's lastSeen; options.state: synthetic native evidence of that state instead of the default.
export function nativeQueueNode(t: test.TestContext, owner = NATIVE_OWNER, options: { seenAt?: number; state?: "running" | "idle-loaded" | "unknown" } = {}) {
  const fake = fakeCodexBin(t);
  const node = codexNode(t, {}, { findCodex: () => fake.file });
  const home = path.join(node.root, "synthetic-owner-home");
  fs.mkdirSync(home);
  const policy = JSON.parse(fs.readFileSync(node.paths.policy, "utf8"));
  policy.wake = { enabled: true, sessions: [owner], nativeQueue: true };
  fs.writeFileSync(node.paths.policy, JSON.stringify(policy));
  recordCodexSession(node.paths, owner, node.workspace, options.seenAt ?? T0, "default");
  // Synthetic exact-holder observation, independent of the historical hook.
  let livenessAuthority = publishSynthetic(node.paths, [{ runtime: "codex", sessionId: owner,
    holder: { status: "value", value: { present: true, creationIdentity: "synthetic-created-1" }, source: "native-holder", observedAt: T0, complete: true, reasonCode: "observed" },
    turn: { status: "value", value: "running", source: "native-turn", observedAt: T0, complete: true, reasonCode: "observed" },
  }], T0, [{ runtime: "codex", sessionId: owner, state: "running" }]);
  writeLocalSessions(node.paths, [{ runtime: "codex", sessionId: owner, state: "running" }], T0);
  // Republishes evidence, the named row and the in-process authority, as one liveness pass does.
  const publish = (state: "running" | "idle-loaded" | "unknown", at = node.deps().now!()) => {
    livenessAuthority = publishSynthetic(node.paths, [fixtureEvidence({ runtime: "codex", sessionId: owner }, state, at)], at,
      [{ runtime: "codex", sessionId: owner, state, name: codexSessionName(owner) }]);
  };
  if (options.state) publish(options.state, T0);
  // A bound for a hung fake, not a timing assumption: under the parallel suite a
  // freshly written fake boots in up to ~1.1 s (issue #452), the production
  // default stays QUEUE_TIMEOUT_MS.
  const deps = () => ({ ...node.deps({ findCodex: () => fake.file, home, queueTimeoutMs: 10_000 }), livenessAuthority });
  const add = (text = "Public synthetic peer content", toSession = owner) => {
    const id = `4080${(++serial).toString(16).padStart(4, "0")}-0000-4000-8000-000000000001`;
    storeMessage(node.paths.inbox, { messageId: id, from: PEER, toSession, text, createdAt: new Date(T0).toISOString() }, T0);
    return id;
  };
  const poll = async () => { pollCodexQueue(deps()); await codexQueueIdle(); };
  return { ...node, owner, fake, deps, add, poll, home, publish };
}
