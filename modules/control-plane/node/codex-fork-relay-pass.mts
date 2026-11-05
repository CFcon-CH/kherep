import fs from "node:fs";
import path from "node:path";

import { isMessageId } from "../protocol-messages.mts";
import { readForkAttempt } from "./codex-fork-attempts.mts";
import { reconcileRelay, relayPassMemo, type RelayDeps } from "./codex-fork-relay.mts";
import { getMessage } from "./inbox.mts";
import { getProxied } from "./inbox-proxied.mts";

// Issue #408, PR 4, review WX443-1 and WX443-2: the relay bookkeeping
// (owner-first withdrawal, held bookkeeping of a superseded attempt and the
// D19 bounded cleanup) driven by the sidecars in inbox/proxied/, not by
// wake.codexFork or the owner candidates. Called by every poll before the
// candidates exist. A sidecar exists only because a sweep ran with the section
// present, so without relay artefacts the footprint is one readdir (ENOENT)
// and the directory is never created. Per sidecar it reads the sidecar, the
// inbox record (its toSession is the attempt's owner) and the one attempt;
// never the policy file, a session record, the task list or the source
// context. It never sends, claims, creates a file, takes a turn or writes a
// held line, and audits only with the section present (supersede).

export function relayBookkeeping(deps: RelayDeps, log: (line: string) => void): void {
  let names: string[];
  try { names = fs.readdirSync(path.join(deps.paths.inbox, "proxied")); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const { settled, stopped } = relayPassMemo;
  const now = deps.now?.() ?? Date.now();
  for (const name of names.sort((left, right) => Number(left > right) - Number(left < right))) {
    const messageId = name.endsWith(".json") ? name.slice(0, -5) : "";
    if (!isMessageId(messageId) || settled.has(messageId)) continue;
    try {
      // A malformed or unreadable sidecar throws: logged once, nothing removed.
      if (getProxied(deps.paths.inbox, messageId) === null) continue;
      const owner = getMessage(deps.paths.inbox, messageId)?.toSession;
      const a = owner ? readForkAttempt(deps.paths, owner, messageId) : null;
      // Held as unconfirmed inside the bound, or waiting for a send: re-read every poll.
      if (!owner || !a?.relayMessageId || reconcileRelay(deps, owner, a, now) === "none") settled.add(messageId);
    } catch (error) {
      if (!stopped.has(messageId)) log(`kherep-node: Codex fork relay stopped; the answer stays stored: ${String((error as Error).message ?? error)}`);
      stopped.add(messageId);
    }
  }
}
